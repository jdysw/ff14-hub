/**
 * `events-upcoming`：活动时间表（阶段 04 / HUB-011，Widget 类型见共享 `EVENTS_WIDGET_IDS.upcoming`）。
 *
 * 边界（ADR-0004 D8 / D9）：
 * - 组件**拿不到** Token、fetch 目标与缓存；它只能通过 Host 注入的 `ModuleDataPort`
 *   按本模块声明过的操作名取数。缺少端口时**拒绝执行**（绝不自行 fetch）。
 * - 「什么算未开始 / 进行中 / 已结束」「怎么筛」「怎么排序」全部调用共享纯函数
 *   （`eventPhase` / `filterEvents` / `sortEvents`），组件里没有第二份判定，
 *   因此界面显示与服务端逻辑不可能漂移。
 * - 不伪造：个人活动一律标注「未验证来源」（用户自述不构成证据，ADR-0004 D9）；
 *   没有数据时报告空态并显示共享的诚实文案，而不是编造活动。
 *
 * 本文件同时导出**本模块共用的展示辅助**（区服/阶段文案、本地时间格式、缺端口文案）：
 * 阶段 04 的模块文件清单固定（不新增第三个文件），而这两个组件必须共用同一份实现，
 * 否则同一句文案/同一个格式会在两处各写一遍并逐渐漂移。
 */
import {
  EVENTS_MESSAGES,
  eventListResponseSchema,
  eventPhase,
  eventsUpcomingConfigSchema,
  filterEvents,
  publicEventListResponseSchema,
  sortEvents,
  type EventPhase,
  type EventRegion,
  type EventVerificationStatus,
} from '@ff14-hub/shared';
import { useEffect, useState } from 'react';
import { EVENTS_PORT_OPERATIONS } from './events-data-port';
import type { ModuleDataPort, WidgetRuntimeProps } from '../widgets/types';

/** 区服徽章文案。键取自共享 `EVENT_REGIONS`：新增区服时 TS 会在这里报错，不会被漏掉。 */
export const EVENT_REGION_LABELS: Readonly<Record<EventRegion, string>> = {
  cn: '国服',
  global: '国际服',
};

/** 阶段徽章文案。`ended` 直接引用共享文案，避免同一句话两处各写一遍。 */
export const EVENT_PHASE_LABELS: Readonly<Record<EventPhase, string>> = {
  upcoming: '未开始',
  active: '进行中',
  ended: EVENTS_MESSAGES.endedBadge,
};

/**
 * 缺少模块数据端口时的降级文案（唯一实现；测试直接断言这句话）。
 * 为什么是「拒绝执行」而不是自己 fetch：组件一旦能取数，端口层的门禁复检与作用域约束
 * 就形同虚设（ADR-0004 D8）。
 */
export const MISSING_PORT_MESSAGE = '该组件缺少模块数据端口，已拒绝执行';

/**
 * 把 UTC 毫秒渲染成**浏览器本地时间** `YYYY-MM-DD HH:mm`。
 *
 * 不用 `toLocaleString`：格式随语言环境变化，同一份数据在不同设备上不可对齐。
 * 不用 `toISOString`：那显示的是 UTC，用户会把它当成自己的本地时间（显示错误的开服时间
 * 比不显示更糟）。
 */
export function formatLocalMinute(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * 来源链接的打开方式：阶段 04 固定**新标签页**。
 * 为什么写成常量而不是配置项：共享配置契约（`EVENTS_UPCOMING_CONFIG_VERSION = 1`）里没有该字段，
 * 而它是 `.strict()` 的——自行加字段会让既有实例的配置校验失败。
 * 活动来源是外部站点，覆盖当前工作台会丢掉用户上下文，因此默认新标签页。
 */
const SOURCE_LINK_TARGET = '_blank' as const;

/** 个人活动与公共来源活动共有的最小形状（两者都满足它，因此可以合并排序）。 */
interface EventLike {
  readonly id: string;
  readonly region: EventRegion;
  readonly title: string;
  readonly description: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly sourceUrl: string | null;
  readonly verificationStatus: EventVerificationStatus;
}

interface UpcomingItem extends EventLike {
  /** 来源：工作空间私有的个人活动，还是公共来源表的活动。 */
  readonly origin: 'personal' | 'public';
}

interface UpcomingView {
  /** 阶段判定的基准时刻：用服务端的 `serverTimeMs`，避免设备时钟偏差改变筛选结果。 */
  readonly nowMs: number;
  readonly items: readonly UpcomingItem[];
}

/**
 * 组件的视图状态。
 * `failed` 与 `loading` 必须分开：失败后还显示「正在加载…」就是在骗用户
 * （真实原因由 Host 的错误卡片给出，组件本身不再渲染内容）。
 */
type UpcomingState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'loaded'; readonly view: UpcomingView };

function toUpcomingItem(origin: 'personal' | 'public', event: EventLike): UpcomingItem {
  return {
    id: `${origin}:${event.id}`,
    origin,
    region: event.region,
    title: event.title,
    description: event.description,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    sourceUrl: event.sourceUrl,
    verificationStatus: event.verificationStatus,
  };
}

/**
 * 读取公共来源活动（只是**补充**）：本阶段公共表为空，因此拿不到、或响应不合契约时
 * 一律降级为「没有公共来源」，绝不让它把个人活动列表整体判成失败。
 */
async function loadPublicEvents(port: ModuleDataPort, region: EventRegion | null): Promise<readonly EventLike[]> {
  try {
    const parsed = publicEventListResponseSchema.safeParse(
      await port.call(EVENTS_PORT_OPERATIONS.listPublic, { region }),
    );
    return parsed.success ? parsed.data.events : [];
  } catch {
    // 公共来源不是本组件的主数据；这里刻意不上报错误（主数据的失败才走 reportAsyncError）。
    return [];
  }
}

export function EventsUpcomingWidget(props: WidgetRuntimeProps) {
  const port = props.data;
  const { config, reportAsyncError, reportEmpty, reportReady, retryToken } = props;
  const [state, setState] = useState<UpcomingState>({ kind: 'loading' });

  useEffect(() => {
    if (port === undefined) {
      reportAsyncError(new Error(MISSING_PORT_MESSAGE));
      return;
    }
    const parsedConfig = eventsUpcomingConfigSchema.safeParse(config);
    if (!parsedConfig.success) {
      reportAsyncError(new Error('活动时间表的配置不合法，已拒绝执行'));
      return;
    }
    const options = parsedConfig.data;
    let cancelled = false;

    void (async () => {
      try {
        const parsed = eventListResponseSchema.safeParse(
          await port.call(EVENTS_PORT_OPERATIONS.listPersonal, { region: options.region, phase: options.phase }),
        );
        if (!parsed.success) {
          throw new Error('个人活动列表的响应不符合共享契约，已丢弃');
        }
        const publicEvents = await loadPublicEvents(port, options.region);
        if (cancelled) {
          return;
        }
        const nowMs = parsed.data.serverTimeMs;
        const merged: UpcomingItem[] = [
          // 墓碑行（`deletedAt` 非 null）不是可展示内容：服务端 SQL 已过滤，这里再兜一层，
          // 避免把「已删除但仍在同步流里」的活动显示成仍然存在。
          ...parsed.data.events.filter((event) => event.deletedAt === null).map((event) => toUpcomingItem('personal', event)),
          ...publicEvents.map((event) => toUpcomingItem('public', event)),
        ];
        const visible = sortEvents(
          filterEvents(merged, {
            region: options.region,
            phase: options.phase === 'all' ? null : options.phase,
            nowMs,
          }),
          'startsAt',
        ).slice(0, options.limit);

        setState({ kind: 'loaded', view: { nowMs, items: visible } });
        if (visible.length === 0) {
          reportEmpty();
        } else {
          reportReady();
        }
      } catch (error) {
        if (!cancelled) {
          setState({ kind: 'failed' });
          reportAsyncError(error);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [config, port, reportAsyncError, reportEmpty, reportReady, retryToken]);

  const parsedConfig = eventsUpcomingConfigSchema.safeParse(config);
  if (port === undefined || !parsedConfig.success) {
    // 没有端口 / 配置不合法：不渲染任何数据（错误已通过 reportAsyncError 交给 Host 展示）。
    return null;
  }

  const { title } = parsedConfig.data;
  // 失败时不渲染内容（原因由 Host 的错误卡片说明），加载中才显示等待文案。
  const body =
    state.kind === 'loading' ? (
      <p className="panel__muted">正在加载活动…</p>
    ) : state.kind === 'failed' ? null : state.view.items.length === 0 ? (
      <p className="panel__muted">{EVENTS_MESSAGES.publicEmpty}</p>
    ) : (
      <ul className="module-list" aria-label="活动列表">
        {state.view.items.map((item) => (
          <li className="module-card" key={item.id}>
            <h4 className="module-card__title">{item.title}</h4>
            <p className="module-card__badges">
              <span className="badge">{EVENT_PHASE_LABELS[eventPhase(item, state.view.nowMs)]}</span>
              <span className="badge">{EVENT_REGION_LABELS[item.region]}</span>
              {item.origin === 'personal' || item.verificationStatus === 'unverified' ? (
                // 个人活动是**用户自述**，一律标注未验证（即使服务端存了 verified 也不改口：
                // 自述不构成证据，ADR-0004 D9）。
                <span className="tag tag--warn">{EVENTS_MESSAGES.unverifiedBadge}</span>
              ) : null}
            </p>
            <p className="module-card__meta">
              {formatLocalMinute(item.startsAt)} — {formatLocalMinute(item.endsAt)}
              {item.origin === 'public' ? '（公共来源）' : ''}
            </p>
            <p className="module-card__meta">
              {item.sourceUrl === null ? (
                '无来源'
              ) : (
                // 纯文本渲染 + 固定 rel：来源 URL 只当数据，绝不是 HTML/脚本注入点。
                <a href={item.sourceUrl} rel="noreferrer noopener" target={SOURCE_LINK_TARGET}>
                  {item.sourceUrl}
                </a>
              )}
            </p>
          </li>
        ))}
      </ul>
    );

  return (
    <section aria-labelledby={`${props.instanceId}-events-upcoming-title`}>
      <h3 className="subsection-title" id={`${props.instanceId}-events-upcoming-title`}>
        {title}
      </h3>
      {body}
      <p className="panel__muted">{EVENTS_MESSAGES.manualOnly}</p>
    </section>
  );
}
