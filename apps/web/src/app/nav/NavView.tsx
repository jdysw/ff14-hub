/**
 * 完整导航视图（阶段 04 / HUB-007 · 008 · 009 · 047 · 048）——「导航」系统级入口的内容。
 *
 * 定位：本组件是**纯展示**，全部状态与动作来自 `use-nav` 的 `NavController`。
 * 只有一处例外：分组改名输入框有自己的本地文本（那是「正在输入什么」的瞬时状态，
 * 不是导航数据；提交后仍然落到 `renameGroup` 上）。
 *
 * 不可含糊的四条：
 * 1. **空态不隐藏功能**：没有任何链接时显式给出「从推荐目录导入 / 新建链接」两个入口，
 *    而不是把整块界面收起来（那会让用户以为功能不存在）。
 * 2. **标题里的图标是纯文本**：直接 `{icon}` 渲染，**不用** `dangerouslySetInnerHTML`。
 *    图标是用户可控字符串，一旦当 HTML 用就等于把注入面重新打开（ADR-0004 D3）。
 * 3. **草稿与冲突可见**：编辑中遇到远程变化时横幅明确说明「草稿已保留、服务端上是
 *    revision N」，并提供「基于最新修订保存 / 放弃草稿并重新载入」两个显式出口。
 * 4. **链接必须由用户显式点击才打开**：`target="_blank"` 一律带
 *    `rel="noreferrer noopener"`，避免 `window.opener` 反向控制本页。
 */
import {
  NAV_OPEN_MODES,
  NAV_REGIONS,
  NAV_SORT_MODES,
  type NavLinkView,
  type NavRegion,
  type NavSortMode,
} from '@ff14-hub/shared';
import { useEffect, useRef, useState } from 'react';
import { NavImportPanel } from './NavImportPanel';
import { registerPrivateDraftSource } from '../pwa/draft-registry';
import { hostOf, localUrlError, type NavController, type NavLinkFormValues } from './use-nav';

/** 区服徽章的文案（`both` 是「与区服无关」的通用条目，不是第三个区服）。 */
const REGION_LABELS: Readonly<Record<NavRegion, string>> = {
  cn: '国服',
  global: '国际服',
  both: '通用',
};

const SORT_LABELS: Readonly<Record<NavSortMode, string>> = {
  manual: '个人顺序',
  title: '标题',
  recent: '最近修改',
  favorite: '收藏优先',
};

const STATUS_LABELS = { active: '使用中', archived: '已归档' } as const;

const OPEN_MODE_LABELS = { new_tab: '新标签页', same_tab: '当前标签页' } as const;

export interface NavViewProps {
  readonly state: NavController;
}

export function NavView(props: NavViewProps) {
  const { state } = props;
  const [groupNameDraft, setGroupNameDraft] = useState('');

  /**
   * 把「是否有未保存草稿」登记给 PWA 更新提示（HUB-012）。
   *
   * 为什么用 ref + 空依赖登记：登记只在挂载时发生一次（避免每次草稿变化都重登记），
   * 而判定函数读的是 ref 里的最新值——这样 Service Worker 的更新提示能问到一个**当下**的答案。
   */
  const draftOpenRef = useRef(state.draft !== null);
  useEffect(() => {
    draftOpenRef.current = state.draft !== null;
  }, [state.draft]);
  useEffect(() => registerPrivateDraftSource(() => draftOpenRef.current), []);

  return (
    <section className="panel nav" data-testid="nav-view" aria-labelledby="nav-title">
      <h2 id="nav-title">个人导航</h2>
      <p className="panel__muted">
        链接、分组与顺序都是你自己的数据（服务端只接受 https 地址）。推荐目录是**只读**系统目录：
        目录升级不会覆盖你改过的条目，也不会复活你删掉的条目——只有你对同一条显式再次导入时才会。
      </p>

      {state.error === null ? null : (
        <p className="notice notice--error" data-testid="nav-error" role="alert">
          {state.error}
        </p>
      )}
      {state.notice === null ? null : (
        <p className="notice notice--ok" data-testid="nav-notice" role="status">
          {state.notice}
        </p>
      )}

      <ConflictBanner state={state} />

      {state.status === 'loading' ? (
        <p className="panel__muted" role="status">
          正在加载导航数据…
        </p>
      ) : null}
      {state.status === 'error' ? (
        <div className="nav__toolbar">
          <button
            type="button"
            className="button"
            data-testid="nav-retry"
            onClick={() => {
              void state.reload();
            }}
          >
            重新加载导航
          </button>
        </div>
      ) : null}

      <NavFilterBar state={state} />
      <SyncBar state={state} />
      <LinkDraftForm state={state} />
      <LinkListSection state={state} />
      <GroupSection state={state} groupNameDraft={groupNameDraft} setGroupNameDraft={setGroupNameDraft} />
      <NavImportPanel state={state} />
    </section>
  );
}

/**
 * 409 / 远程变化冲突横幅。
 *
 * 两种来源都走这里：服务端返回结构化 409（`state.conflict`），或后台刷新让快照修订前进
 * （草稿上的 `conflicted`）。两者的共同要求是**保留本地草稿**并让用户显式选择。
 */
function ConflictBanner(props: { readonly state: NavController }) {
  const { state } = props;
  const draft = state.draft;
  const remoteConflict = state.conflict;
  if (draft === null || (!draft.conflicted && remoteConflict === null)) {
    return null;
  }
  const serverRevision = remoteConflict?.conflict?.currentRevision ?? draft.serverRevision;
  return (
    <div className="nav__banner" data-testid="nav-conflict" role="alertdialog" aria-label="导航编辑冲突">
      <p className="nav__banner-title">
        编辑期间该工作空间的导航数据已被其他设备修改
        {serverRevision === null ? '' : `，服务器上是 revision ${String(serverRevision)}`}
      </p>
      <p className="panel__muted">
        <strong>你的本地草稿仍然保留</strong>，不会被自动覆盖，也不会被自动重试。
        {remoteConflict === null ? '' : `服务端返回：${remoteConflict.message}（${remoteConflict.code}）。`}
        你基于的修订：<code>{draft.baseRevision}</code>。
      </p>
      {state.draftRemoteNotice === null ? null : (
        <p className="notice notice--warn" data-testid="nav-draft-remote-notice" role="status">
          {state.draftRemoteNotice}
        </p>
      )}
      <div className="nav__toolbar">
        <button
          type="button"
          className="button"
          data-testid="nav-conflict-adopt"
          onClick={() => {
            state.acknowledgeConflict();
          }}
        >
          基于最新修订保存（保留我的草稿）
        </button>
        <button
          type="button"
          className="button button--secondary"
          data-testid="nav-conflict-discard"
          onClick={() => {
            state.cancelDraft();
            void state.reload();
          }}
        >
          放弃草稿并重新载入
        </button>
      </div>
    </div>
  );
}

/** 跨设备同步的手动入口：轮询在后台自动跑（挂载 / 窗口聚焦 / 间隔），这里给出显式动作。 */
function SyncBar(props: { readonly state: NavController }) {
  return (
    <div className="nav__toolbar" data-testid="nav-sync-bar">
      <button
        type="button"
        className="button button--small button--secondary"
        data-testid="nav-sync-now"
        onClick={() => {
          // 显式同步：与后台轮询走同一个游标，因此不会重复应用已经处理过的变更。
          void props.state.syncNow();
        }}
      >
        立即同步其它设备的改动
      </button>
      <span className="panel__muted">
        同步只应用变更，<strong>不会</strong>覆盖正在编辑的草稿。
      </span>
    </div>
  );
}

/** 搜索 / 分组 / 区服 / 收藏 / 排序。全部控件都有 `<label>`，键盘可达。 */
function NavFilterBar(props: { readonly state: NavController }) {
  const { state } = props;
  const filter = state.filter;
  return (
    <fieldset className="nav__filters" data-testid="nav-filters">
      <legend className="field__label">搜索与筛选</legend>

      <label className="field">
        <span className="field__label">关键词（标题 / 别名 / 描述 / 标签）</span>
        <input
          type="search"
          className="field__input"
          data-testid="nav-filter-text"
          value={filter.text ?? ''}
          onChange={(event) => {
            const value = event.target.value;
            state.patchFilter(value.length === 0 ? { text: undefined } : { text: value });
          }}
        />
      </label>

      <label className="field">
        <span className="field__label">分组</span>
        <select
          className="field__input"
          data-testid="nav-filter-group"
          value={filter.groupId ?? ''}
          onChange={(event) => {
            const value = event.target.value;
            state.patchFilter(value.length === 0 ? { groupId: undefined } : { groupId: value });
          }}
        >
          <option value="">全部分组</option>
          {state.activeGroups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field__label">区服</span>
        <select
          className="field__input"
          data-testid="nav-filter-region"
          value={filter.region ?? ''}
          onChange={(event) => {
            const value = event.target.value;
            state.patchFilter(
              value.length === 0 ? { region: undefined } : { region: value as NavRegion },
            );
          }}
        >
          <option value="">全部区服</option>
          {NAV_REGIONS.map((region) => (
            <option key={region} value={region}>
              {REGION_LABELS[region]}
            </option>
          ))}
        </select>
      </label>

      <label className="field field--inline">
        <input
          type="checkbox"
          data-testid="nav-filter-favorites"
          checked={filter.favoritesOnly === true}
          onChange={(event) => {
            const checked = event.target.checked;
            state.patchFilter(checked ? { favoritesOnly: true } : { favoritesOnly: undefined });
          }}
        />
        <span>只看收藏</span>
      </label>

      <label className="field">
        <span className="field__label">排序</span>
        <select
          className="field__input"
          data-testid="nav-sort"
          value={state.sort}
          onChange={(event) => {
            state.setSort(event.target.value as NavSortMode);
          }}
        >
          {NAV_SORT_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {SORT_LABELS[mode]}
            </option>
          ))}
        </select>
      </label>
    </fieldset>
  );
}

/**
 * 新建 / 编辑链接表单。
 *
 * 表单只在有草稿时渲染（没有草稿 = 用户没有正在进行的编辑）。
 * 提交前做**共享判定**的 URL 校验：`javascript:` 这类输入就地报错且不发请求。
 */
function LinkDraftForm(props: { readonly state: NavController }) {
  const { state } = props;
  const draft = state.draft;
  const [urlTouched, setUrlTouched] = useState(false);
  if (draft === null) {
    return (
      <div className="nav__toolbar">
        <button
          type="button"
          className="button"
          data-testid="nav-new-link"
          onClick={() => {
            setUrlTouched(false);
            state.startCreateLink();
          }}
        >
          新建链接
        </button>
      </div>
    );
  }
  const values = draft.values;
  const urlError = urlTouched ? localUrlError(values.url) : null;
  const isEdit = draft.mode === 'edit';
  return (
    <div className="nav__form" data-testid="nav-link-form" data-mode={draft.mode}>
      <h3 className="subsection-title">{isEdit ? '编辑链接' : '新建链接'}</h3>

      <label className="field">
        <span className="field__label">标题（必填）</span>
        <input
          className="field__input"
          data-testid="nav-link-title"
          value={values.title}
          onChange={(event) => {
            state.updateDraft({ title: event.target.value });
          }}
        />
      </label>

      <label className="field">
        <span className="field__label">地址（只接受 https://）</span>
        <input
          className="field__input"
          data-testid="nav-link-url"
          value={values.url}
          aria-invalid={urlError !== null}
          onBlur={() => {
            setUrlTouched(true);
          }}
          onChange={(event) => {
            state.updateDraft({ url: event.target.value });
          }}
        />
      </label>
      {urlError === null ? null : (
        <p className="notice notice--error" data-testid="nav-link-url-error" role="alert">
          链接地址不可用：{urlError}（未发出任何请求）
        </p>
      )}

      <label className="field">
        <span className="field__label">描述</span>
        <textarea
          className="field__input"
          data-testid="nav-link-description"
          rows={2}
          value={values.description}
          onChange={(event) => {
            state.updateDraft({ description: event.target.value });
          }}
        />
      </label>

      <label className="field">
        <span className="field__label">标签（逗号分隔）</span>
        <input
          className="field__input"
          data-testid="nav-link-tags"
          value={values.tags}
          onChange={(event) => {
            state.updateDraft({ tags: event.target.value });
          }}
        />
      </label>

      <label className="field">
        <span className="field__label">别名（供搜索，逗号分隔）</span>
        <input
          className="field__input"
          data-testid="nav-link-aliases"
          value={values.aliases}
          onChange={(event) => {
            state.updateDraft({ aliases: event.target.value });
          }}
        />
      </label>

      <label className="field">
        <span className="field__label">图标（纯文本，例如 emoji）</span>
        <input
          className="field__input"
          data-testid="nav-link-icon"
          value={values.icon}
          onChange={(event) => {
            state.updateDraft({ icon: event.target.value });
          }}
        />
      </label>

      <label className="field">
        <span className="field__label">打开方式</span>
        <select
          className="field__input"
          data-testid="nav-link-open-mode"
          value={values.openMode}
          onChange={(event) => {
            state.updateDraft({ openMode: event.target.value as NavLinkFormValues['openMode'] });
          }}
        >
          {NAV_OPEN_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {OPEN_MODE_LABELS[mode]}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field__label">区服</span>
        <select
          className="field__input"
          data-testid="nav-link-region"
          value={values.region}
          onChange={(event) => {
            state.updateDraft({ region: event.target.value as NavRegion });
          }}
        >
          {NAV_REGIONS.map((region) => (
            <option key={region} value={region}>
              {REGION_LABELS[region]}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field__label">状态</span>
        <select
          className="field__input"
          data-testid="nav-link-status"
          value={values.status}
          onChange={(event) => {
            state.updateDraft({ status: event.target.value as NavLinkFormValues['status'] });
          }}
        >
          <option value="active">{STATUS_LABELS.active}</option>
          <option value="archived">{STATUS_LABELS.archived}</option>
        </select>
      </label>

      <label className="field field--inline">
        <input
          type="checkbox"
          data-testid="nav-link-favorite"
          checked={values.isFavorite}
          onChange={(event) => {
            state.updateDraft({ isFavorite: event.target.checked });
          }}
        />
        <span>收藏</span>
      </label>

      {/*
        多选分组：`multiple` 的原生 `<select>` 不需要拖拽库也能表达「一个链接属于多个分组」，
        而且键盘与屏幕阅读器都能操作（避免为了这个需求引入依赖）。
      */}
      <label className="field">
        <span className="field__label">所属分组（可多选，按住 Ctrl / Command 多选）</span>
        <select
          className="field__input nav__group-select"
          data-testid="nav-link-groups"
          multiple
          value={[...values.groupIds]}
          onChange={(event) => {
            const selected = [...event.target.selectedOptions].map((option) => option.value);
            state.updateDraft({ groupIds: selected });
          }}
        >
          {state.activeGroups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
      </label>

      <div className="nav__toolbar">
        <button
          type="button"
          className="button"
          data-testid="nav-link-submit"
          disabled={state.busy}
          onClick={() => {
            setUrlTouched(true);
            if (localUrlError(values.url) !== null || values.title.trim().length === 0) {
              // 标题与 URL 是服务端也会拒绝的硬约束：这里就地说明，不发请求。
              return;
            }
            void (isEdit ? state.updateLink() : state.createLink());
          }}
        >
          {isEdit ? '保存修改' : '创建链接'}
        </button>
        <button
          type="button"
          className="button button--secondary"
          data-testid="nav-link-cancel"
          onClick={() => {
            state.cancelDraft();
          }}
        >
          取消编辑
        </button>
      </div>
      {values.title.trim().length === 0 ? (
        <p className="panel__muted">标题不能为空（服务端同样拒绝空标题）。</p>
      ) : null}
    </div>
  );
}

/** 链接列表：空态显式保留功能入口。 */
function LinkListSection(props: { readonly state: NavController }) {
  const { state } = props;
  const snapshot = state.snapshot;
  const totalActive = snapshot === null ? 0 : snapshot.links.filter((link) => link.deletedAt === null).length;

  if (snapshot === null) {
    return null;
  }

  if (totalActive === 0) {
    return (
      <section className="nav__empty" data-testid="nav-empty" aria-label="空导航">
        <h3 className="subsection-title">还没有任何链接</h3>
        <p className="panel__muted">
          这是合法状态，不是功能缺失：你仍然可以新建链接，或从推荐目录导入一批常用站点。
        </p>
        <div className="nav__toolbar">
          <button
            type="button"
            className="button"
            data-testid="nav-empty-create"
            onClick={() => {
              state.startCreateLink();
            }}
          >
            新建链接
          </button>
          <button
            type="button"
            className="button button--secondary"
            data-testid="nav-empty-catalog"
            onClick={() => {
              void state.loadCatalog();
            }}
          >
            从推荐目录导入
          </button>
        </div>
      </section>
    );
  }

  if (state.visibleLinks.length === 0) {
    return (
      <p className="panel__muted" data-testid="nav-no-match">
        当前筛选条件下没有匹配的链接（共 {totalActive} 条链接）。清空筛选即可看到它们。
      </p>
    );
  }

  return (
    <ul className="nav__list" data-testid="nav-link-list">
      {state.visibleLinks.map((link, index) => (
        <LinkRow
          key={link.id}
          link={link}
          state={state}
          isFirst={index === 0}
          isLast={index === state.visibleLinks.length - 1}
        />
      ))}
    </ul>
  );
}

/** 单条链接。标题是真正的链接（新标签页时带 `rel="noreferrer noopener"`）。 */
function LinkRow(props: {
  readonly link: NavLinkView;
  readonly state: NavController;
  readonly isFirst: boolean;
  readonly isLast: boolean;
}) {
  const { link, state } = props;
  const groupNames = link.groupNames.length === 0 ? '未分组' : link.groupNames.join('、');
  return (
    <li className="nav__item" data-testid="nav-link-item" data-link-id={link.id} data-status={link.status}>
      <p className="nav__item-title">
        <span className="nav__icon" aria-hidden="true">
          {link.icon}
        </span>{' '}
        <a
          href={link.url}
          {...(link.openMode === 'new_tab'
            ? { target: '_blank', rel: 'noreferrer noopener' }
            : { rel: 'noreferrer noopener' })}
          data-testid="nav-link-anchor"
        >
          {link.title}
        </a>
        {link.isFavorite ? (
          <span className="tag tag--status" data-testid="nav-link-favorite-mark">
            收藏
          </span>
        ) : null}
      </p>
      <p className="nav__item-meta">
        <code data-testid="nav-link-host">{hostOf(link.url)}</code>
        <span className="tag" data-testid="nav-link-region">
          {REGION_LABELS[link.region]}
        </span>
        <span className="tag">{STATUS_LABELS[link.status]}</span>
        <span className="tag tag--muted" data-testid="nav-link-open-mode">
          {OPEN_MODE_LABELS[link.openMode]}
        </span>
        <span className="tag tag--muted" data-testid="nav-link-groups">
          {groupNames}
        </span>
        {/* 阶段 04 不做服务端探测：状态一律如实显示「未探测」，绝不伪造在线状态（D4）。 */}
        <span className="tag tag--muted" data-testid="nav-link-health">
          {link.health === 'unknown' ? '未探测' : link.health}
        </span>
      </p>
      {link.description.length === 0 ? null : <p className="nav__item-description">{link.description}</p>}
      {link.tags.length === 0 ? null : (
        <p className="nav__item-tags">
          {link.tags.map((tag) => (
            <span key={tag} className="tag">
              {tag}
            </span>
          ))}
        </p>
      )}
      <div className="nav__toolbar">
        <button
          type="button"
          className="button button--small"
          data-testid="nav-link-edit"
          onClick={() => {
            state.startEditLink(link.id);
          }}
        >
          编辑
        </button>
        <button
          type="button"
          className="button button--small"
          data-testid="nav-link-toggle-favorite"
          aria-pressed={link.isFavorite}
          onClick={() => {
            void state.toggleFavorite(link.id);
          }}
        >
          {link.isFavorite ? '取消收藏' : '收藏'}
        </button>
        <button
          type="button"
          className="button button--small"
          data-testid="nav-link-move-up"
          disabled={props.isFirst}
          onClick={() => {
            void state.moveLink(link.id, -1);
          }}
        >
          上移
        </button>
        <button
          type="button"
          className="button button--small"
          data-testid="nav-link-move-down"
          disabled={props.isLast}
          onClick={() => {
            void state.moveLink(link.id, 1);
          }}
        >
          下移
        </button>
        <button
          type="button"
          className="button button--small button--danger"
          data-testid="nav-link-delete"
          onClick={() => {
            void state.deleteLink(link.id);
          }}
        >
          删除
        </button>
      </div>
    </li>
  );
}

/** 分组：新建 / 改名 / 删除 / 重排。删除分组不删链接（链接是独立数据）。 */
function GroupSection(props: {
  readonly state: NavController;
  readonly groupNameDraft: string;
  readonly setGroupNameDraft: (value: string) => void;
}) {
  const { state } = props;
  return (
    <section className="nav__groups" data-testid="nav-groups" aria-labelledby="nav-groups-title">
      <h3 className="subsection-title" id="nav-groups-title">
        分组（一个链接可以属于多个分组）
      </h3>
      <label className="field">
        <span className="field__label">新分组名称</span>
        <input
          className="field__input"
          data-testid="nav-group-new-name"
          value={props.groupNameDraft}
          onChange={(event) => {
            props.setGroupNameDraft(event.target.value);
          }}
        />
      </label>
      <div className="nav__toolbar">
        <button
          type="button"
          className="button"
          data-testid="nav-group-create"
          disabled={state.busy || props.groupNameDraft.trim().length === 0}
          onClick={() => {
            const name = props.groupNameDraft.trim();
            void state.createGroup(name).then(() => {
              props.setGroupNameDraft('');
            });
          }}
        >
          新建分组
        </button>
      </div>

      {state.activeGroups.length === 0 ? (
        <p className="panel__muted" data-testid="nav-groups-empty">
          还没有分组。分组是可选的：链接可以只靠自己存在。
        </p>
      ) : (
        <ul className="nav__list" data-testid="nav-group-list">
          {state.activeGroups.map((group, index) => (
            <li className="nav__item" key={group.id} data-testid="nav-group-item" data-group-id={group.id}>
              <GroupRow
                groupId={group.id}
                name={group.name}
                isFirst={index === 0}
                isLast={index === state.activeGroups.length - 1}
                state={state}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 分组的单行编辑（改名输入是本地瞬时状态，提交时才落到控制器）。 */
function GroupRow(props: {
  readonly groupId: string;
  readonly name: string;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly state: NavController;
}) {
  const [name, setName] = useState(props.name);
  return (
    <>
      <label className="field">
        <span className="field__label">{`分组「${props.name}」的名称`}</span>
        <input
          className="field__input"
          data-testid="nav-group-name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </label>
      <div className="nav__toolbar">
        <button
          type="button"
          className="button button--small"
          data-testid="nav-group-rename"
          disabled={props.state.busy || name.trim().length === 0}
          onClick={() => {
            void props.state.renameGroup(props.groupId, name.trim());
          }}
        >
          保存名称
        </button>
        <button
          type="button"
          className="button button--small"
          data-testid="nav-group-move-up"
          disabled={props.isFirst}
          onClick={() => {
            void props.state.moveGroup(props.groupId, -1);
          }}
        >
          上移
        </button>
        <button
          type="button"
          className="button button--small"
          data-testid="nav-group-move-down"
          disabled={props.isLast}
          onClick={() => {
            void props.state.moveGroup(props.groupId, 1);
          }}
        >
          下移
        </button>
        <button
          type="button"
          className="button button--small button--danger"
          data-testid="nav-group-delete"
          onClick={() => {
            void props.state.deleteGroup(props.groupId);
          }}
        >
          删除分组
        </button>
      </div>
    </>
  );
}

