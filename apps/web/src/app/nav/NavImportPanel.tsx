/**
 * 导航导入 / 导出面板（阶段 04 / HUB-007 · 008 · 047）。
 *
 * 五条不可含糊的事实必须在界面上看得见：
 * 1. **目录升级 ≠ 再导入**：每条目录条目都显示它相对「我的副本」的状态
 *    （`new` / `unchanged` / `user_modified` / `tombstoned`，用共享 `catalogUpgradePlan` +
 *    `navCatalogEntryState` 计算）。`tombstoned` 的条目**默认不勾选**，只有用户点
 *    「显式再次导入」时才可能恢复；`user_modified` 的条目默认不可被覆盖，
 *    除非用户另行勾选「覆盖我的修改」。
 * 2. **本地解析先行**：书签 HTML / 链接 JSON / 版本化配置一律先在本地用共享纯函数
 *    （`parseBookmarkHtml` / `parseNavImportDocument`）解析，逐项给出跳过原因，
 *    再由用户确认 apply。**外来 HTML 从不进入 DOM**：渲染出来的始终是解析后的**文本**。
 * 3. **普通链接导入 ≠ 恢复完整配置**（复核发现的真实缺陷）：带 `schemaVersion` 的导出文档
 *    走「恢复完整配置」——展示摘要（链接 / 分组 / 关系数量、导出时间、schemaVersion），
 *    经 preview → apply 提交**原样文档**，保留分组、多对多归属、收藏、状态与顺序。
 *    解析失败（未来版本 / 引用不完整 / 危险 URL）时**明确展示原因**，
 *    绝不降级成 links 导入（降级会静默丢掉分组与关系）。
 * 4. **文本里可能带着标签残片**：被跳过的条目会把原始 URL / 标题回显出来，
 *    因此这里把 `<` / `>` 转成全角字符再渲染 —— 即使某段文本里含有标签，
 *    页面上也不会出现任何真实的 HTML 标签文本。
 * 5. **导出可往返**：导出用共享 `buildNavExportDocument` 的形状，并把
 *    「读回校验」入口（共享 `parseNavExportDocument`）也做出来，证明往返稳定。
 */
import type { NavRegion } from '@ff14-hub/shared';
import { useMemo, useState, type ChangeEvent } from 'react';
import type { NavController, NavCatalogRow, NavLocalImport, NavRestoreSummary } from './use-nav';

export interface NavImportPanelProps {
  readonly state: NavController;
}

/** 区服文案（`both` 是「与区服无关」的通用条目，不是第三个区服）。 */
const REGION_TEXT: Readonly<Record<NavRegion, string>> = {
  cn: '国服',
  global: '国际服',
  both: '通用',
};

/** 把文本里的尖括号换成全角字符：外来 URL / 标题里的标签残片不会形成真实标签。 */
function neutralizeAngleBrackets(text: string): string {
  return text.replaceAll('<', '＜').replaceAll('>', '＞');
}

const CATALOG_STATE_LABELS: Readonly<Record<string, string>> = {
  new: '尚未导入',
  unchanged: '与目录一致',
  user_modified: '你已修改（默认不覆盖）',
  tombstoned: '你删除过（需显式再次导入）',
};

const SKIP_REASON_LABELS: Readonly<Record<string, string>> = {
  invalid_url: '地址形态不可用',
  unsupported_scheme: '只允许 https',
  missing_title: '缺少标题',
  too_many_items: '超过单次导入上限',
  duplicate: '同一地址重复出现',
  unsupported_document: '完整配置不能用普通链接导入',
};

/** 导入来源的可读名称。 */
const IMPORT_KIND_LABELS: Readonly<Record<NavLocalImport['kind'], string>> = {
  bookmarks: '书签 HTML',
  json: '结构化 JSON',
  restore: '完整导航配置（恢复）',
};

/**
 * 目录条目状态 → 中文标签。
 *
 * 保持「未知状态也不静默」：契约里出现新状态时显示原始值，而不是空字符串。
 */
function catalogStateLabel(state: string): string {
  return CATALOG_STATE_LABELS[state] ?? state;
}

export function NavImportPanel(props: NavImportPanelProps) {
  const { state } = props;
  const rows = state.catalogRows;
  const [jsonText, setJsonText] = useState('');
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [explicitReimport, setExplicitReimport] = useState(false);
  const [overwriteUserEdits, setOverwriteUserEdits] = useState(false);

  /**
   * 默认勾选集合：只包含**可安全导入**的条目。
   *
   * `user_modified` 与 `tombstoned` 的条目刻意不默认勾选：把「覆盖个人修改」或
   * 「复活墓碑」变成默认行为，等于让一次误点就丢掉用户自己的编辑（ADR-0004 D1）。
   *
   * 依赖刻意用「可勾选条目的 id 序列」这个**字符串**：`rows` 每次渲染都是新数组，
   * 直接依赖它会让用户在目录里勾选的选项被反复重置。
   */
  const selectableKey = rows
    .filter((row) => row.selectable)
    .map((row) => row.entry.id)
    .join('\u0000');
  const defaultSelected = useMemo<ReadonlySet<string>>(
    () => new Set(selectableKey.length === 0 ? [] : selectableKey.split('\u0000')),
    [selectableKey],
  );

  /**
   * 用户勾选（带来源键）。
   *
   * 为什么用「键 + 集合」而不是一个 `useEffect` 去同步默认值：effect 里同步 setState
   * 会造成级联渲染（`react-hooks/set-state-in-effect`），而且「目录刷新后重置选择」
   * 本来就是一个纯派生关系：键不匹配时直接用默认值即可。
   */
  const [selection, setSelection] = useState<{ readonly key: string; readonly ids: ReadonlySet<string> } | null>(null);
  const selected = selection !== null && selection.key === selectableKey ? selection.ids : defaultSelected;
  const setSelected = (ids: ReadonlySet<string>): void => {
    setSelection({ key: selectableKey, ids });
  };

  return (
    <section className="workbench__panel nav__import" aria-labelledby="nav-import-title" id="nav-import">
      <h3 className="subsection-title" id="nav-import-title">
        推荐目录 / 书签导入 / 导出
      </h3>
      <p className="panel__muted">
        推荐目录是**只读系统目录**（只有维护代码能写它）。导入是**完全独立**的个人副本：
        导入后你可以随意改名、删除、重排；目录升级只更新系统目录，不会覆盖你的改动，
        也不会复活你删掉的条目。
      </p>

      <CatalogSection
        state={state}
        rows={rows}
        selected={selected}
        setSelected={setSelected}
        explicitReimport={explicitReimport}
        setExplicitReimport={setExplicitReimport}
        overwriteUserEdits={overwriteUserEdits}
        setOverwriteUserEdits={setOverwriteUserEdits}
      />

      <BookmarkImportSection
        state={state}
        jsonText={jsonText}
        setJsonText={setJsonText}
        fileNotice={fileNotice}
        setFileNotice={setFileNotice}
      />

      <ExportSection state={state} />
    </section>
  );
}

/** 推荐目录：逐条显示来源、分类、区服、验证状态与相对个人副本的状态。 */
function CatalogSection(props: {
  readonly state: NavController;
  readonly rows: readonly NavCatalogRow[];
  readonly selected: ReadonlySet<string>;
  readonly setSelected: (next: ReadonlySet<string>) => void;
  readonly explicitReimport: boolean;
  readonly setExplicitReimport: (value: boolean) => void;
  readonly overwriteUserEdits: boolean;
  readonly setOverwriteUserEdits: (value: boolean) => void;
}) {
  const { state, rows } = props;
  const chosen = [...props.selected];

  function toggle(catalogId: string, checked: boolean): void {
    const next = new Set(props.selected);
    if (checked) {
      next.add(catalogId);
    } else {
      next.delete(catalogId);
    }
    props.setSelected(next);
  }

  return (
    <section className="nav__catalog" data-testid="nav-catalog" aria-labelledby="nav-catalog-title">
      <h4 className="subsection-title" id="nav-catalog-title">
        推荐目录
      </h4>
      <div className="nav__toolbar">
        <button
          type="button"
          className="button button--secondary"
          data-testid="nav-catalog-load"
          disabled={state.busy}
          onClick={() => {
            void state.loadCatalog();
          }}
        >
          加载 / 刷新推荐目录
        </button>
      </div>

      {state.catalogError === null ? null : (
        <p className="notice notice--error" data-testid="nav-catalog-error" role="alert">
          {state.catalogError}
        </p>
      )}

      {state.catalog === null ? (
        <p className="panel__muted" data-testid="nav-catalog-idle">
          还没有加载目录。点上面的按钮加载推荐目录（公开只读数据，不含你的个人链接）。
        </p>
      ) : rows.length === 0 ? (
        <p className="panel__muted" data-testid="nav-catalog-empty">
          当前推荐目录没有条目（这是一条事实，不是加载失败）。
        </p>
      ) : (
        <ul className="nav__list" data-testid="nav-catalog-list">
          {rows.map((row) => (
            <CatalogRowItem
              key={row.entry.id}
              row={row}
              checked={props.selected.has(row.entry.id)}
              onToggle={toggle}
            />
          ))}
        </ul>
      )}

      <label className="field field--inline">
        <input
          type="checkbox"
          data-testid="nav-catalog-explicit"
          checked={props.explicitReimport}
          onChange={(event) => {
            props.setExplicitReimport(event.target.checked);
          }}
        />
        <span>
          显式再次导入（<strong>这会恢复你删除过的条目</strong>；不勾选时被删除的条目保持删除）
        </span>
      </label>

      <label className="field field--inline">
        <input
          type="checkbox"
          data-testid="nav-catalog-overwrite"
          checked={props.overwriteUserEdits}
          onChange={(event) => {
            props.setOverwriteUserEdits(event.target.checked);
          }}
        />
        <span>覆盖我的修改（默认不覆盖：目录升级不会动你改过的副本）</span>
      </label>

      <div className="nav__toolbar">
        <button
          type="button"
          className="button"
          data-testid="nav-catalog-import"
          disabled={state.busy}
          onClick={() => {
            void state.importCatalog({
              catalogIds: chosen,
              explicitReimport: props.explicitReimport,
              overwriteUserEdits: props.overwriteUserEdits,
            });
          }}
        >
          导入选中的 {chosen.length} 条目录条目
        </button>
        <button
          type="button"
          className="button button--secondary"
          data-testid="nav-catalog-select-all"
          onClick={() => {
            props.setSelected(new Set(rows.filter((row) => row.selectable).map((row) => row.entry.id)));
          }}
        >
          全选可安全导入的条目
        </button>
      </div>
    </section>
  );
}

/** 单条目录条目：分类 / 区服 / 来源链接 / 核对状态 / 相对个人副本的状态。 */
function CatalogRowItem(props: {
  readonly row: NavCatalogRow;
  readonly checked: boolean;
  readonly onToggle: (catalogId: string, checked: boolean) => void;
}) {
  const { entry } = props.row;
  const tombstoned = props.row.state === 'tombstoned';
  return (
    <li
      className="nav__item"
      data-testid="nav-catalog-entry"
      data-catalog-id={entry.id}
      data-catalog-state={props.row.state}
    >
      <p className="nav__item-title">
        <span className="nav__icon" aria-hidden="true">
          {entry.icon}
        </span>{' '}
        <label className="field field--inline">
          <input
            type="checkbox"
            data-testid="nav-catalog-select"
            checked={props.checked}
            onChange={(event) => {
              props.onToggle(entry.id, event.target.checked);
            }}
          />
          <span>{entry.title}</span>
        </label>
        <span className="tag" data-testid="nav-catalog-state">
          {catalogStateLabel(props.row.state)}
        </span>
      </p>
      <p className="nav__item-meta">
        <code>{entry.url}</code>
        <span className="tag" data-testid="nav-catalog-category">
          {entry.category}
        </span>
        <span className="tag">{REGION_TEXT[entry.region] ?? entry.region}</span>
        <span className="tag tag--muted" data-testid="nav-catalog-verified">
          {entry.verificationStatus === 'verified' ? '目录条目已核对' : '目录条目未核对'}
        </span>
      </p>
      {entry.description.length === 0 ? null : <p className="nav__item-description">{entry.description}</p>}
      <p className="panel__muted">
        来源：
        <a href={entry.sourceUrl} rel="noreferrer noopener" target="_blank">
          {entry.sourceName.length === 0 ? entry.sourceUrl : entry.sourceName}
        </a>
        {' · '}版本 {entry.sourceVersion}
        {' · '}核对时间 {new Date(entry.verifiedAt).toISOString()}
      </p>
      <p className="panel__muted" data-testid="nav-catalog-decision">
        {props.row.defaultActionReason}
        {tombstoned
          ? '（要恢复它，请勾选上面的「显式再次导入」）'
          : props.row.state === 'user_modified'
            ? '（要覆盖它，请勾选上面的「覆盖我的修改」）'
            : ''}
      </p>
      {tombstoned ? (
        <button
          type="button"
          className="button button--small button--danger"
          data-testid="nav-catalog-reimport"
          onClick={() => {
            props.onToggle(entry.id, true);
          }}
        >
          显式再次导入（恢复我删除过的条目）
        </button>
      ) : null}
    </li>
  );
}

/** 书签 HTML / 链接 JSON / 完整配置恢复：本地解析 → 逐项预览（含跳过原因）→ 确认 apply。 */
function BookmarkImportSection(props: {
  readonly state: NavController;
  readonly jsonText: string;
  readonly setJsonText: (value: string) => void;
  readonly fileNotice: string | null;
  readonly setFileNotice: (value: string | null) => void;
}) {
  const { state } = props;
  const local = state.localImport;
  const preview = state.importPreview;
  const isRestore = local?.kind === 'restore';
  const parseFailed = local !== null && local.error !== null;

  /** 读文件：解析失败只显示可读提示，绝不抛异常，也绝不把文件内容插进 DOM。 */
  async function handleFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (file === undefined) {
      return;
    }
    props.setFileNotice(null);
    let text: string;
    try {
      text = await file.text();
    } catch {
      props.setFileNotice('无法读取所选文件，请重新选择。');
      return;
    }
    const kind = file.name.toLowerCase().endsWith('.json') ? 'json' : 'bookmarks';
    state.previewLocalImport({ kind, sourceName: file.name, text });
  }

  return (
    <section className="nav__import-file" data-testid="nav-import-file" aria-labelledby="nav-import-file-title">
      <h4 className="subsection-title" id="nav-import-file-title">
        导入：书签 / 链接 JSON / 恢复完整配置（先预览，再确认）
      </h4>
      <p className="panel__muted">
        解析在你的浏览器里完成：只把 <code>&lt;A HREF&gt;</code> 与文件夹名当**数据**读，
        其余标签一律忽略，脚本块整体丢弃。<strong>预览不会写入任何数据</strong>。
        本应用导出的 JSON（带 schemaVersion）会被识别为**完整导航配置**，
        走恢复流程以保留分组、多对多归属、收藏、状态与顺序。
      </p>

      <label className="field">
        <span className="field__label">选择书签文件（.html / .htm）或 JSON（.json，链接列表或完整配置）</span>
        <input
          type="file"
          className="field__input"
          data-testid="nav-import-file-input"
          accept=".html,.htm,.json,text/html,application/json"
          onChange={(event) => {
            void handleFile(event);
          }}
        />
      </label>
      {props.fileNotice === null ? null : (
        <p className="notice notice--error" role="alert" data-testid="nav-import-file-error">
          {props.fileNotice}
        </p>
      )}

      <label className="field">
        <span className="field__label">
          或者直接粘贴 JSON（{'{ "links": [ … ] }'} / 裸数组 / 本应用导出的完整配置）
        </span>
        <textarea
          className="field__input field__input--code"
          data-testid="nav-import-json-text"
          rows={4}
          value={props.jsonText}
          onChange={(event) => {
            props.setJsonText(event.target.value);
          }}
        />
      </label>
      <div className="nav__toolbar">
        <button
          type="button"
          className="button button--secondary"
          data-testid="nav-import-json-parse"
          disabled={props.jsonText.trim().length === 0}
          onClick={() => {
            state.previewLocalImport({ kind: 'json', sourceName: '粘贴的 JSON 文本', text: props.jsonText });
          }}
        >
          本地解析粘贴的 JSON
        </button>
        <button
          type="button"
          className="button button--secondary"
          data-testid="nav-import-clear"
          onClick={() => {
            state.clearLocalImport();
            props.setJsonText('');
          }}
        >
          清空导入草稿
        </button>
      </div>

      {/* 目标分组只对**普通链接导入**有意义：恢复完整配置自带分组归属，指定目标分组会扭曲它。 */}
      {isRestore ? null : (
        <label className="field">
          <span className="field__label">导入到分组（可选）</span>
          <select
            className="field__input"
            data-testid="nav-import-target-group"
            value={state.importTargetGroupId ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              state.setImportTargetGroup(value.length === 0 ? null : value);
            }}
          >
            <option value="">不指定（用条目自带的分组名）</option>
            {state.activeGroups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <LocalImportPreview state={state} />

      {local === null ? null : (
        <div className="nav__toolbar">
          <button
            type="button"
            className="button"
            data-testid="nav-import-preview"
            // 解析失败（未来版本 / 引用不完整 / 危险 URL）时**禁止**进入预览：
            // 唯一正确的出路是让用户看到原因并改用正确的导入方式。
            disabled={state.busy || parseFailed || (!isRestore && local.items.length === 0)}
            onClick={() => {
              void state.previewImport();
            }}
          >
            {isRestore && local.summary !== null
              ? `提交服务端预览（恢复完整配置：${String(local.summary.linkCount)} 条链接 / ${String(local.summary.groupCount)} 个分组 / ${String(local.summary.membershipCount)} 条关系）`
              : `提交服务端预览（${String(local.items.length)} 条）`}
          </button>
        </div>
      )}

      {preview === null ? null : (
        <div className="nav__preview" data-testid="nav-import-preview-result">
          <p className="nav__item-meta" data-testid="nav-import-preview-summary">
            服务端重新校验后：可写入 <code>{preview.preview.items.length}</code> 条 · 跳过{' '}
            <code>{preview.preview.skipped.length}</code> 条 · 预览修订{' '}
            <code>{preview.expectedRevision}</code>
          </p>
          <SkippedList skipped={preview.preview.skipped} testId="nav-import-server-skipped" />
          <div className="nav__toolbar">
            <button
              type="button"
              className="button button--danger"
              data-testid="nav-import-apply"
              // restore 模式按「完整文档」落地：items 为空是正常的（它本来就不走 items）。
              disabled={state.busy || (!isRestore && preview.preview.items.length === 0)}
              onClick={() => {
                void state.applyImport();
              }}
            >
              {isRestore ? '确认恢复完整配置（保留分组 / 关系 / 收藏 / 状态 / 顺序）' : `确认导入（${String(preview.preview.items.length)} 条）`}
            </button>
            <button
              type="button"
              className="button button--secondary"
              data-testid="nav-import-discard"
              onClick={() => {
                state.discardImportPreview();
              }}
            >
              取消导入
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** 本地解析结果：完整配置显示摘要；链接列表逐项列出条目与**被跳过**的条目（含原因）。 */
function LocalImportPreview(props: { readonly state: NavController }) {
  const local = props.state.localImport;
  if (local === null) {
    return (
      <p className="panel__muted" data-testid="nav-import-local-idle">
        还没有本地解析结果：选择文件或粘贴 JSON 后会在本地解析，不会写入任何数据。
      </p>
    );
  }
  const isRestore = local.kind === 'restore';
  return (
    <div className="nav__preview" data-testid="nav-import-local">
      <p className="nav__item-meta" data-testid="nav-import-local-summary">
        来源：{local.sourceName}（{IMPORT_KIND_LABELS[local.kind]}）
        {isRestore ? '' : ` · 可导入 ${String(local.items.length)} 条 · 跳过 ${String(local.skipped.length)} 条`}
      </p>

      {local.error === null ? null : (
        <p className="notice notice--error" role="alert" data-testid="nav-import-local-error">
          这份输入不能用于导入：{neutralizeAngleBrackets(local.error)}。
          {isRestore ? '' : '它不会被降级成普通链接导入（那会静默丢掉分组与归属关系）。'}
        </p>
      )}

      {local.summary === null ? null : <RestoreSummary summary={local.summary} />}

      {isRestore ? null : (
        <>
          <h5 className="subsection-title">将被导入</h5>
          {local.items.length === 0 ? (
            <p className="panel__muted">没有任何条目可导入。</p>
          ) : (
            <ul className="nav__list" data-testid="nav-import-item-list">
              {local.items.map((item) => (
                <li className="nav__item" key={item.url} data-testid="nav-import-item">
                  <p className="nav__item-title">{neutralizeAngleBrackets(item.title)}</p>
                  <p className="nav__item-meta">
                    <code>{neutralizeAngleBrackets(item.url)}</code>
                    {item.groupName === undefined ? null : <span className="tag">{item.groupName}</span>}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <h5 className="subsection-title">被跳过（逐项说明原因）</h5>
          <SkippedList skipped={local.skipped} testId="nav-import-local-skipped" />
        </>
      )}
    </div>
  );
}

/**
 * 完整配置的摘要：数量 / 导出时间 / schemaVersion。
 *
 * 这些数字全部来自**文档本身**（不是推断）：恢复前让用户看清「要恢复什么」，
 * 以及「保留哪些语义」（分组、多对多、收藏、状态、顺序）。
 */
function RestoreSummary(props: { readonly summary: NavRestoreSummary }) {
  const summary = props.summary;
  return (
    <div className="nav__restore" data-testid="nav-restore-summary">
      <p className="nav__item-meta" data-testid="nav-restore-counts">
        完整导航配置：链接 <code>{summary.linkCount}</code> 条 · 分组 <code>{summary.groupCount}</code> 个 ·
        成员关系 <code>{summary.membershipCount}</code> 条
      </p>
      <p className="panel__muted" data-testid="nav-restore-meta">
        schemaVersion <code>{summary.schemaVersion}</code> · 导出时间{' '}
        <code>{new Date(summary.exportedAt).toISOString()}</code>
      </p>
      <p className="panel__muted">
        恢复会保留分组、多对多归属、收藏、状态与自定义顺序；服务端会把文档里的 ID
        重新映射到当前工作空间，因此不会与其它工作空间的数据串在一起。
      </p>
    </div>
  );
}

/** 跳过列表：原因、说明、以及（经中性化处理的）原始标题 / URL。 */
function SkippedList(props: {
  readonly skipped: readonly { readonly reason: string; readonly detail: string; readonly title: string | null; readonly url: string | null }[];
  readonly testId: string;
}) {
  if (props.skipped.length === 0) {
    return <p className="panel__muted">没有跳过任何条目。</p>;
  }
  return (
    <ul className="nav__list" data-testid={props.testId}>
      {props.skipped.map((item, index) => (
        <li className="nav__item" key={`${item.reason}:${String(index)}`} data-testid="nav-import-skipped-item">
          <p className="nav__item-meta">
            <span className="tag tag--warn" data-testid="nav-import-skip-reason">
              {SKIP_REASON_LABELS[item.reason] ?? item.reason}
            </span>
            <span>{neutralizeAngleBrackets(item.detail)}</span>
          </p>
          {item.title === null && item.url === null ? null : (
            <p className="panel__muted">
              {item.title === null ? null : <span>标题：{neutralizeAngleBrackets(item.title)} </span>}
              {item.url === null ? null : <code>{neutralizeAngleBrackets(item.url)}</code>}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** 导出与读回校验：证明导出文档能被共享 `parseNavExportDocument` 读回。 */
function ExportSection(props: { readonly state: NavController }) {
  const { state } = props;
  const [readBackText, setReadBackText] = useState('');
  return (
    <section className="nav__export" data-testid="nav-export" aria-labelledby="nav-export-title">
      <h4 className="subsection-title" id="nav-export-title">
        导出（JSON，不含任何凭证）
      </h4>
      <div className="nav__toolbar">
        <button
          type="button"
          className="button"
          data-testid="nav-export-run"
          disabled={state.busy || state.snapshot === null}
          onClick={() => {
            void state.exportDocument();
          }}
        >
          导出导航（下载 JSON）
        </button>
      </div>
      {state.exportNotice === null ? null : (
        <p className="notice notice--ok" data-testid="nav-export-notice" role="status">
          {state.exportNotice}
        </p>
      )}

      <label className="field">
        <span className="field__label">导出内容（只读，便于核对）</span>
        <textarea
          className="field__input field__input--code"
          data-testid="nav-export-output"
          readOnly
          rows={5}
          value={state.exportedJson ?? ''}
          placeholder="点击「导出导航」后，这里会显示导出的 JSON 文本。"
        />
      </label>

      <label className="field">
        <span className="field__label">读回校验（粘贴一段导出 JSON）</span>
        <textarea
          className="field__input field__input--code"
          data-testid="nav-export-readback-input"
          rows={3}
          value={readBackText}
          onChange={(event) => {
            setReadBackText(event.target.value);
          }}
        />
      </label>
      <div className="nav__toolbar">
        <button
          type="button"
          className="button button--secondary"
          data-testid="nav-export-readback"
          onClick={() => {
            state.readBackExport(readBackText);
          }}
        >
          读回校验
        </button>
        <button
          type="button"
          className="button button--secondary"
          data-testid="nav-export-copy"
          disabled={state.exportedJson === null}
          onClick={() => {
            setReadBackText(state.exportedJson ?? '');
            state.readBackExport(state.exportedJson ?? '');
          }}
        >
          用刚导出的内容做读回校验
        </button>
      </div>
      {state.exportReadBack === null ? null : (
        <p className="panel__muted" data-testid="nav-export-readback-result" role="status">
          {state.exportReadBack}
        </p>
      )}
    </section>
  );
}
