/**
 * `events-manage`：活动维护（阶段 04 / HUB-011，Widget 类型见共享 `EVENTS_WIDGET_IDS.manage`）。
 *
 * 边界（ADR-0004 D8 / D9 / D11）：
 * - 组件拿不到 Token 与 API 路径，只能通过 Host 注入的 `ModuleDataPort` 读写本模块的数据；
 *   缺少端口时**拒绝执行**（绝不自行 fetch、也不做本地乐观写入假装已持久化）。
 * - 提交前用共享纯函数就地校验（`validateEventRange` 判区间、`isHttpsEventSourceUrl` 判来源链接、
 *   长度用共享常量），**不合法就不发请求**（先本地拒绝，再让服务端复核）。
 * - 阶段徽章/排序/筛选同样走共享纯函数，组件里没有第二份时间判定。
 * - 删除是墓碑（服务端行为），界面只发 CAS（`expectedRevision`），因此并发修改不会被静默覆盖。
 *
 * 本组件**始终**报告 ready（而不是 empty）：表单本身就是内容，列表为空不代表这个 Widget
 * 没有可展示、可操作的东西——报空态会让 Host 显示「暂无内容」，而用户其实可以立刻新建活动。
 */
import {
  EVENTS_MESSAGES,
  EVENT_REGIONS,
  MAX_EVENT_DESCRIPTION_LENGTH,
  MAX_EVENT_SOURCE_URL_LENGTH,
  MAX_EVENT_TITLE_LENGTH,
  eventListResponseSchema,
  eventPhase,
  eventsManageConfigSchema,
  filterEvents,
  isHttpsEventSourceUrl,
  sortEvents,
  validateEventRange,
  type EventRegion,
  type WorkspaceEvent,
} from '@ff14-hub/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { EVENTS_PORT_OPERATIONS, EventsPortError, describeEventConflict } from './events-data-port';
import {
  EVENT_PHASE_LABELS,
  EVENT_REGION_LABELS,
  MISSING_PORT_MESSAGE,
  formatLocalMinute,
} from './EventsUpcomingWidget';
import type { WidgetRuntimeProps } from '../widgets/types';

/**
 * 列表的加载状态。
 * `failed` 与 `loading` 必须分开：失败后仍显示「正在加载…」就是在骗用户；
 * 失败原因由 Host 的错误卡片说明，列表区不再渲染任何内容。
 */
type ManageList =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | {
      readonly kind: 'loaded';
      readonly events: readonly WorkspaceEvent[];
      /** 列表响应里的服务端时间：阶段判定的基准，避免设备时钟偏差。 */
      readonly serverTimeMs: number;
    };

interface Draft {
  readonly title: string;
  readonly region: EventRegion | null;
  readonly startsLocal: string;
  readonly endsLocal: string;
  readonly description: string;
  readonly sourceUrl: string;
}

const EMPTY_DRAFT: Draft = {
  title: '',
  region: null,
  startsLocal: '',
  endsLocal: '',
  description: '',
  sourceUrl: '',
};

/**
 * `datetime-local` 的值 → UTC 毫秒。
 *
 * `datetime-local` 提交的是**不带时区**的本地时间字符串，按 ECMAScript 规范，
 * 这类「日期+时间但无偏移」的形式按**本地时区**解释，正是用户填写时的语义。
 * 解析不出来（空串/非法）返回 null，由调用方就地报错。
 */
function localInputToUtcMs(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  const parsed = new Date(trimmed).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/** UTC 毫秒 → `datetime-local` 的初始值。复用 `formatLocalMinute`，不另写一份格式化。 */
function toLocalInputValue(ms: number): string {
  return formatLocalMinute(ms).replace(' ', 'T');
}

/**
 * 列表的展示顺序（唯一实现：加载时用它判断是否为空，渲染时用它生成行）。
 * `startsAtDesc` = 最新的排前面（共享契约注明它用于维护视图），并列项由共享实现按 ID 兜底。
 */
function visibleRows(
  events: readonly WorkspaceEvent[],
  region: EventRegion | null,
  nowMs: number,
): WorkspaceEvent[] {
  // 墓碑行（`deletedAt` 非 null）不展示：服务端 SQL 已过滤，这里再兜一层。
  const alive = events.filter((event) => event.deletedAt === null);
  return sortEvents(filterEvents(alive, { region, nowMs }), 'startsAtDesc');
}

/** 把错误降级成可安全回显的一行文案；冲突用共享结构化冲突的可读描述。 */
function errorTextOf(error: unknown): string {
  if (error instanceof EventsPortError && error.conflict !== null) {
    return describeEventConflict(error.conflict);
  }
  if (error instanceof Error) {
    return error.message;
  }
  return '操作失败，请稍后重试。';
}

/** 表单的本地校验（唯一实现）。返回 null 表示可以提交。 */
function validateDraft(input: {
  readonly title: string;
  readonly description: string;
  readonly startsAt: number | null;
  readonly endsAt: number | null;
  readonly sourceUrl: string;
}): string | null {
  const title = input.title.trim();
  if (title.length === 0 || title.length > MAX_EVENT_TITLE_LENGTH) {
    return `标题必须为 1–${String(MAX_EVENT_TITLE_LENGTH)} 个字符`;
  }
  if (input.description.length > MAX_EVENT_DESCRIPTION_LENGTH) {
    return `描述最长 ${String(MAX_EVENT_DESCRIPTION_LENGTH)} 个字符`;
  }
  if (input.startsAt === null || input.endsAt === null) {
    return '开始时间与结束时间都必须填写合法的本地时间';
  }
  // 区间判定用共享纯函数（与数据库 CHECK、服务端校验同一份实现）。
  const range = validateEventRange({ startsAt: input.startsAt, endsAt: input.endsAt });
  if (!range.ok) {
    return range.reason === 'ends_before_starts' ? '结束时间不能早于开始时间' : '开始与结束时间必须是合法的毫秒时间';
  }
  const sourceUrl = input.sourceUrl.trim();
  if (sourceUrl.length > 0 && !isHttpsEventSourceUrl(sourceUrl)) {
    return `来源链接必须是 https URL（含主机名、不含用户名与密码、长度不超过 ${String(MAX_EVENT_SOURCE_URL_LENGTH)}）`;
  }
  return null;
}

export function EventsManageWidget(props: WidgetRuntimeProps) {
  const port = props.data;
  const { config, instanceId, reportAsyncError, reportReady, retryToken } = props;

  const [list, setList] = useState<ManageList>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ readonly id: string; readonly message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editEndValue, setEditEndValue] = useState('');
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (port === undefined) {
      reportAsyncError(new Error(MISSING_PORT_MESSAGE));
      return;
    }
    const parsedConfig = eventsManageConfigSchema.safeParse(config);
    if (!parsedConfig.success) {
      reportAsyncError(new Error('活动维护组件的配置不合法，已拒绝执行'));
      return;
    }
    const region = parsedConfig.data.region;
    let cancelled = false;

    void (async () => {
      try {
        const parsed = eventListResponseSchema.safeParse(
          // `phase: 'all'`：维护视图要看全部（含已结束），阶段筛选只是时间表那侧的偏好。
          await port.call(EVENTS_PORT_OPERATIONS.listPersonal, { region, phase: 'all' }),
        );
        if (!parsed.success) {
          throw new Error('个人活动列表的响应不符合共享契约，已丢弃');
        }
        if (cancelled) {
          return;
        }
        setList({ kind: 'loaded', events: parsed.data.events, serverTimeMs: parsed.data.serverTimeMs });
        // 刻意不报空态：这个组件始终有内容（新建表单），见文件头注释。
        reportReady();
      } catch (error) {
        if (!cancelled) {
          setList({ kind: 'failed' });
          reportAsyncError(error);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [config, port, reloadToken, reportAsyncError, reportReady, retryToken]);

  const parsedConfig = eventsManageConfigSchema.safeParse(config);
  if (port === undefined || !parsedConfig.success) {
    return null;
  }
  const { title } = parsedConfig.data;
  const configRegion = parsedConfig.data.region;
  // 下面的事件处理器是闭包，TS 的窄化不会自动带进去；这里显式取一个非空别名（渲染到这里
  // 已确认端口存在，因此这个别名与 props.data 是同一个对象）。
  const activePort = port;
  const fieldId = (name: string): string => `${instanceId}-events-${name}`;
  const rows = list.kind === 'loaded' ? visibleRows(list.events, configRegion, list.serverTimeMs) : [];
  const nowMs = list.kind === 'loaded' ? list.serverTimeMs : 0;

  function resetDraft(): void {
    setDraft(EMPTY_DRAFT);
    setFormError(null);
  }

  async function submitDraft(): Promise<void> {
    if (busy) {
      return;
    }
    const startsAt = localInputToUtcMs(draft.startsLocal);
    const endsAt = localInputToUtcMs(draft.endsLocal);
    const problem = validateDraft({
      title: draft.title,
      description: draft.description,
      startsAt,
      endsAt,
      sourceUrl: draft.sourceUrl,
    });
    if (problem !== null || startsAt === null || endsAt === null) {
      // 本地就地拒绝：**不发请求**（服务端仍会独立复核一次，这里只是不浪费一次往返）。
      setFormError(problem ?? '开始时间与结束时间都必须填写合法的本地时间');
      return;
    }
    const sourceUrl = draft.sourceUrl.trim();
    setBusy(true);
    setFormError(null);
    try {
      await activePort.call(EVENTS_PORT_OPERATIONS.create, {
        title: draft.title.trim(),
        description: draft.description,
        region: draft.region ?? configRegion ?? 'cn',
        startsAt,
        endsAt,
        sourceUrl: sourceUrl.length === 0 ? null : sourceUrl,
        // 刻意不传 verificationStatus：个人活动的来源是自述，默认「未验证」由服务端决定。
      });
      resetDraft();
      // 写入成功后重新拉取列表（列表响应有共享 Schema 校验），而不是把本地草稿当成已保存。
      setReloadToken((value) => value + 1);
    } catch (error) {
      // 写入失败只在这一处提示，不把整个 Widget 换成错误卡片：列表与表单仍然可用。
      setFormError(errorTextOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveEndTime(event: WorkspaceEvent): Promise<void> {
    if (busy) {
      return;
    }
    const endsAt = localInputToUtcMs(editEndValue);
    if (endsAt === null) {
      setRowError({ id: event.id, message: '请输入合法的结束时间' });
      return;
    }
    const range = validateEventRange({ startsAt: event.startsAt, endsAt });
    if (!range.ok) {
      setRowError({
        id: event.id,
        message: range.reason === 'ends_before_starts' ? '结束时间不能早于开始时间' : '结束时间必须是合法的毫秒时间',
      });
      return;
    }
    setBusy(true);
    setRowError(null);
    try {
      await activePort.call(EVENTS_PORT_OPERATIONS.update, {
        id: event.id,
        // CAS：只对「我看到的这一版」生效；服务器上是别的版本就会 409，绝不静默覆盖。
        expectedRevision: event.revision,
        patch: { endsAt },
      });
      setEditingId(null);
      setReloadToken((value) => value + 1);
    } catch (error) {
      setRowError({ id: event.id, message: errorTextOf(error) });
    } finally {
      setBusy(false);
    }
  }

  async function deleteEvent(event: WorkspaceEvent): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setRowError(null);
    try {
      await activePort.call(EVENTS_PORT_OPERATIONS.delete, {
        id: event.id,
        expectedRevision: event.revision,
      });
      setConfirmingDeleteId(null);
      setReloadToken((value) => value + 1);
    } catch (error) {
      setRowError({ id: event.id, message: errorTextOf(error) });
    } finally {
      setBusy(false);
    }
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void submitDraft();
  };

  return (
    <section aria-labelledby={`${instanceId}-events-manage-title`}>
      <h3 className="subsection-title" id={`${instanceId}-events-manage-title`}>
        {title}
      </h3>

      <form aria-label="新建活动" noValidate onSubmit={handleSubmit}>
        <label className="field" htmlFor={fieldId('title')}>
          <span className="field__label">标题</span>
          <input
            className="field__input"
            id={fieldId('title')}
            maxLength={MAX_EVENT_TITLE_LENGTH}
            type="text"
            value={draft.title}
            onChange={(event) => {
              setDraft({ ...draft, title: event.target.value });
            }}
          />
        </label>

        <label className="field" htmlFor={fieldId('region')}>
          <span className="field__label">区服</span>
          <select
            className="field__input"
            id={fieldId('region')}
            value={draft.region ?? configRegion ?? 'cn'}
            onChange={(event) => {
              // 只接受共享枚举里的值：非法值不可能进入状态（下拉本身也只提供这两项）。
              const next = EVENT_REGIONS.find((region) => region === event.target.value);
              if (next !== undefined) {
                setDraft({ ...draft, region: next });
              }
            }}
          >
            {EVENT_REGIONS.map((region) => (
              <option key={region} value={region}>
                {EVENT_REGION_LABELS[region]}
              </option>
            ))}
          </select>
        </label>

        <label className="field" htmlFor={fieldId('starts')}>
          <span className="field__label">开始时间（本地时间）</span>
          <input
            className="field__input"
            id={fieldId('starts')}
            type="datetime-local"
            value={draft.startsLocal}
            onChange={(event) => {
              setDraft({ ...draft, startsLocal: event.target.value });
            }}
          />
        </label>

        <label className="field" htmlFor={fieldId('ends')}>
          <span className="field__label">结束时间（本地时间）</span>
          <input
            className="field__input"
            id={fieldId('ends')}
            type="datetime-local"
            value={draft.endsLocal}
            onChange={(event) => {
              setDraft({ ...draft, endsLocal: event.target.value });
            }}
          />
        </label>

        <label className="field" htmlFor={fieldId('description')}>
          <span className="field__label">描述</span>
          <textarea
            className="field__input"
            id={fieldId('description')}
            maxLength={MAX_EVENT_DESCRIPTION_LENGTH}
            rows={3}
            value={draft.description}
            onChange={(event) => {
              setDraft({ ...draft, description: event.target.value });
            }}
          />
        </label>

        <label className="field" htmlFor={fieldId('source')}>
          <span className="field__label">来源链接（可选，必须是 https）</span>
          <input
            className="field__input"
            id={fieldId('source')}
            maxLength={MAX_EVENT_SOURCE_URL_LENGTH}
            type="url"
            value={draft.sourceUrl}
            onChange={(event) => {
              setDraft({ ...draft, sourceUrl: event.target.value });
            }}
          />
        </label>

        <p className="panel__toolbar">
          <button className="button" disabled={busy} type="submit">
            添加活动
          </button>
          <button className="button button--secondary" disabled={busy} type="button" onClick={resetDraft}>
            清空表单
          </button>
        </p>
        {formError === null ? null : (
          <p className="notice notice--error" role="alert">
            {formError}
          </p>
        )}
      </form>

      <h4 className="subsection-title">我的活动</h4>
      {list.kind === 'failed' ? null : rows.length === 0 ? (
        <p className="panel__muted">
          {list.kind === 'loading' ? '正在加载个人活动…' : '还没有个人活动，用上面的表单添加第一条。'}
        </p>
      ) : (
        <ul aria-label="个人活动列表" className="module-list">
          {rows.map((event) => (
            <li className="module-card" key={event.id}>
              <h5 className="module-card__title">{event.title}</h5>
              <p className="module-card__badges">
                <span className="badge">{EVENT_PHASE_LABELS[eventPhase(event, nowMs)]}</span>
                <span className="badge">{EVENT_REGION_LABELS[event.region]}</span>
                {/* 个人活动是用户自述，一律标注未验证（ADR-0004 D9）：不声称来源已被核实。 */}
                <span className="tag tag--warn">{EVENTS_MESSAGES.unverifiedBadge}</span>
              </p>
              <p className="module-card__meta">
                {formatLocalMinute(event.startsAt)} — {formatLocalMinute(event.endsAt)} · revision {String(event.revision)}
              </p>
              {event.description.trim() === '' ? null : <p className="module-card__meta">{event.description}</p>}
              {event.sourceUrl === null ? (
                <p className="module-card__meta">无来源</p>
              ) : (
                <p className="module-card__meta">
                  {/* 纯文本渲染 + 固定 rel：来源 URL 只当数据，不是 HTML/脚本注入点。 */}
                  <a href={event.sourceUrl} rel="noreferrer noopener" target="_blank">
                    {event.sourceUrl}
                  </a>
                </p>
              )}

              <div className="module-card__actions">
                {editingId === event.id ? (
                  <>
                    <label className="field field--inline" htmlFor={fieldId(`end-${event.id}`)}>
                      <span className="field__label">新的结束时间</span>
                      <input
                        className="field__input"
                        id={fieldId(`end-${event.id}`)}
                        type="datetime-local"
                        value={editEndValue}
                        onChange={(event_) => {
                          setEditEndValue(event_.target.value);
                        }}
                      />
                    </label>
                    <button
                      className="button button--small"
                      disabled={busy}
                      type="button"
                      onClick={() => {
                        void saveEndTime(event);
                      }}
                    >
                      保存结束时间
                    </button>
                    <button
                      className="button button--small button--secondary"
                      type="button"
                      onClick={() => {
                        setEditingId(null);
                        setRowError(null);
                      }}
                    >
                      取消编辑
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="button button--small"
                      type="button"
                      onClick={() => {
                        setEditingId(event.id);
                        setEditEndValue(toLocalInputValue(event.endsAt));
                        setRowError(null);
                      }}
                    >
                      编辑结束时间
                    </button>
                    {confirmingDeleteId === event.id ? (
                      <>
                        <span className="module-card__hint">确认删除「{event.title}」？删除是墓碑，会同步到其他设备。</span>
                        <button
                          className="button button--small button--danger"
                          disabled={busy}
                          type="button"
                          onClick={() => {
                            void deleteEvent(event);
                          }}
                        >
                          确认删除
                        </button>
                        <button
                          className="button button--small button--secondary"
                          type="button"
                          onClick={() => {
                            setConfirmingDeleteId(null);
                          }}
                        >
                          取消删除
                        </button>
                      </>
                    ) : (
                      <button
                        className="button button--small button--danger"
                        type="button"
                        onClick={() => {
                          setConfirmingDeleteId(event.id);
                          setRowError(null);
                        }}
                      >
                        删除
                      </button>
                    )}
                  </>
                )}
              </div>
              {rowError !== null && rowError.id === event.id ? (
                <p className="notice notice--error" role="alert">
                  {rowError.message}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="panel__muted">{EVENTS_MESSAGES.manualOnly}</p>
    </section>
  );
}
