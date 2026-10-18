/**
 * 备份 / 导入 / 恢复面板（阶段 03 / HUB-054）。
 *
 * 四条不可含糊的事实必须在界面上看得见：
 * 1. **导出是真实下载**：成功后同时触发浏览器下载（Blob + createObjectURL + `download` 的 `<a>`）
 *    并把序列化文本渲染到只读元素里（人眼核对 + 断言）。
 * 2. **导入先预览、再显式确认**：文件选择 → 预览（新增/替换/跳过计数、影响页面、未知模块、
 *    问题与警告）→ 点确认才带上 `previewRevision` **与 `previewToken`** 并 `confirm: true` 提交；
 *    有问题时**不写任何数据**。预览之后只要改了文件或改了导入模式，旧令牌立即作废、必须重新预览。
 * 3. **容量边界可见**：显示本次导出字节数与上限（48 KiB），而不是等失败才让人猜。
 * 4. **恢复用的是「点击时的工作台 revision」**：恢复到某个可恢复备份必须带当时看到的 revision，
 *    服务端据此拒绝会静默覆盖跨设备变更的旧请求（409 时提示重新读取备份列表）。
 *
 * 备份**只含工作台配置**：绝不含设备 Token、恢复密钥、WebDAV 凭证或任何服务端秘密。
 *
 * 结构说明（S3776）：组件函数只负责「读文件 / 切模式 / 组合各区块」，
 * 身份说明、导出、导入、备份列表各自是一个子组件，预览结果的渲染全部走纯函数，
 * 因此每个函数的认知复杂度都远低于门槛；`data-testid` 与 DOM 顺序保持与原实现一致。
 */
import { useState, type ChangeEvent } from 'react';
import { WORKBENCH_BACKUP_KIND, WORKBENCH_BACKUP_MAX_BYTES } from '@ff14-hub/shared';
import type {
  WorkbenchImportIssue,
  WorkbenchImportMode,
  WorkbenchImportPreview,
  WorkbenchImportUnknownModule,
} from '@ff14-hub/shared';
import type { BackupSummary } from './workbench-api';
import type { ImportPreviewState, WorkbenchBackupSize, WorkbenchController } from './use-workbench';

export interface BackupPanelProps {
  readonly state: WorkbenchController;
}

/**
 * 读取文件文本。
 *
 * 只用标准的 `Blob.text()`：不再保留 `FileReader#readAsText` 那条兼容分支
 * （两者等价，但 `FileReader` 的写法需要自己挂事件回调，标准 `Blob.text()` 更直接）。
 * 读取失败仍然只抛给调用方，由调用方转成可读文案。
 */
async function readFileText(file: File): Promise<string> {
  return await file.text();
}

const IMPORT_MODE_OPTIONS: readonly { readonly value: WorkbenchImportMode; readonly label: string }[] = [
  { value: 'merge', label: '合并导入（同名页面保留，逐条合并）' },
  { value: 'replace', label: '替换导入（服务端会先自动留一份可恢复备份）' },
];

export function BackupPanel(props: BackupPanelProps) {
  const { state } = props;
  const [mode, setMode] = useState<WorkbenchImportMode>('merge');
  const [fileError, setFileError] = useState<string | null>(null);

  /** 读取用户选择的文件：解析失败给出可读错误，**绝不抛异常**。 */
  async function handleFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (file === undefined) {
      return;
    }
    setFileError(null);
    // 换了文件 = 上一次预览的令牌（它绑定的 document）已经不代表用户确认过的内容。
    state.discardImportPreview();
    let text: string;
    try {
      text = await readFileText(file);
    } catch {
      setFileError('无法读取所选文件，请重新选择。');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setFileError('所选文件不是合法的 JSON，未发送预览请求。');
      return;
    }
    await state.previewImport(parsed, mode);
  }

  /** 改导入模式 = 换了一份「用户确认过的影响范围」：旧预览令牌必须作废，必须重新预览。 */
  function handleModeChange(next: WorkbenchImportMode): void {
    setMode(next);
    state.discardImportPreview();
  }

  return (
    <section className="workbench__panel" aria-labelledby="workbench-backup-title" id="workbench-backup">
      <h3 className="subsection-title" id="workbench-backup-title">
        备份 / 导入 / 恢复（仅工作台配置）
      </h3>
      <BackupIntro />
      <BackupExportToolbar state={state} />
      <BackupExportOutput state={state} />
      <ImportModeFieldset mode={mode} onChange={handleModeChange} />
      <ImportFileField
        error={fileError}
        onFile={(event) => {
          void handleFile(event);
        }}
      />
      <ImportPreviewSection
        preview={state.importPreview}
        busy={state.busy}
        onConfirm={() => {
          void state.confirmImport();
        }}
        onCancel={() => {
          state.cancelImport();
        }}
      />
      <BackupListSection state={state} />
    </section>
  );
}

/** 面板开头的身份与边界说明：备份里**只有**工作台配置。 */
function BackupIntro() {
  return (
    <p className="panel__muted">
      备份只包含页面、组件实例与布局，<strong>不含</strong>设备 Token、恢复密钥、WebDAV 凭证
      或任何服务端秘密；文档类型必须为 <code>{WORKBENCH_BACKUP_KIND}</code>。
      导出与导入共用同一个容量上限：{String(WORKBENCH_BACKUP_MAX_BYTES)} 字节（48 KiB）。
    </p>
  );
}

/** 导出 / 刷新备份列表的动作区，以及「最近一次导出的字节数」这条可见事实。 */
function BackupExportToolbar(props: { readonly state: WorkbenchController }) {
  const { state } = props;
  return (
    <>
      <div className="workbench__toolbar-group">
        <button
          type="button"
          className="button"
          data-testid="backup-export"
          disabled={state.busy}
          onClick={() => {
            void state.exportBackup();
          }}
        >
          导出备份（下载 JSON）
        </button>
        <button
          type="button"
          className="button button--secondary"
          disabled={state.busy}
          onClick={() => {
            void state.loadBackups();
          }}
        >
          刷新可恢复备份
        </button>
      </div>

      <ExportSizeNotice size={state.backupSize} />
    </>
  );
}

/** 导出容量边界：字节数与上限同时显示。 */
function ExportSizeNotice(props: { readonly size: WorkbenchBackupSize | null }) {
  const size = props.size;
  if (size === null) {
    return null;
  }
  return (
    <p className="workbench__status" data-testid="backup-size">
      最近一次导出：{size.byteLength} 字节 / 上限 {size.maxBytes} 字节
      {size.byteLength >= size.maxBytes ? '（已达上限：请减少页面或组件后再导出）' : ''}
    </p>
  );
}

/** 导出内容的只读回显（人眼核对 + 断言都读它）。 */
function BackupExportOutput(props: { readonly state: WorkbenchController }) {
  return (
    <label className="field">
      <span className="field__label">导出内容（只读，便于核对）</span>
      <textarea
        className="field__input field__input--code"
        data-testid="backup-export-output"
        readOnly
        rows={4}
        value={props.state.exportedJson ?? ''}
        placeholder="点击「导出备份」后，这里会显示导出的 JSON 文本。"
      />
    </label>
  );
}

/** 导入模式：模式是预览令牌绑定的一部分，因此切换必须走 `handleModeChange` 作废旧预览。 */
function ImportModeFieldset(props: {
  readonly mode: WorkbenchImportMode;
  readonly onChange: (mode: WorkbenchImportMode) => void;
}) {
  return (
    <fieldset className="workbench__fieldset">
      <legend className="field__label">导入模式</legend>
      {IMPORT_MODE_OPTIONS.map((option) => (
        <label key={option.value} className="field field--inline">
          <input
            type="radio"
            name="workbench-import-mode"
            value={option.value}
            checked={props.mode === option.value}
            onChange={() => {
              props.onChange(option.value);
            }}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** 文件选择 + 读取/解析失败的可读提示。 */
function ImportFileField(props: {
  readonly error: string | null;
  readonly onFile: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <>
      <label className="field">
        <span className="field__label">选择备份文件（.json）</span>
        <input
          type="file"
          className="field__input"
          data-testid="backup-import-file"
          accept="application/json,.json"
          onChange={props.onFile}
        />
      </label>

      {props.error === null ? null : (
        <p className="notice notice--error" role="alert" data-testid="import-file-error">
          {props.error}
        </p>
      )}
    </>
  );
}

/**
 * 预览结果：影响范围、未知模块、问题、警告与两个显式动作。
 * 没有预览结果时只显示一句解释，**不**渲染确认按钮（因此不可能「没预览就确认」）。
 */
function ImportPreviewSection(props: {
  readonly preview: ImportPreviewState | null;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const state = props.preview;
  if (state === null) {
    return (
      <p className="panel__muted">
        还没有预览结果：选择文件后会自动预览，<strong>预览不会写入任何数据</strong>。
      </p>
    );
  }
  const preview = state.preview;
  return (
    <div className="workbench__preview" data-testid="import-preview">
      <p className="workbench__status" data-testid="import-impact">
        {describeImpact(preview)}
      </p>

      <p className="panel__muted">{preview.confirmPrompt}</p>

      <h4 className="subsection-title">未知或未启用的模块</h4>
      <UnknownModuleList modules={preview.unknownModules} />

      <h4 className="subsection-title">问题（非空即不可导入）</h4>
      <ImportIssueList
        issues={preview.problems}
        testId="import-problem"
        emptyText="没有问题。"
        showPath
        showProblemCode
      />

      <h4 className="subsection-title">警告</h4>
      <ImportIssueList
        issues={preview.warnings}
        testId="import-warning"
        emptyText="没有警告。"
        showPath={false}
        showProblemCode={false}
      />

      <div className="workbench__toolbar-group">
        <button
          type="button"
          className="button button--danger"
          data-testid="import-confirm"
          disabled={!preview.importable || props.busy}
          title={
            preview.importable
              ? '确认导入（会带上 previewRevision 与 previewToken 提交）'
              : '存在致命问题，服务端不会执行任何写入'
          }
          onClick={props.onConfirm}
        >
          确认导入
        </button>
        <button
          type="button"
          className="button button--secondary"
          data-testid="import-cancel"
          onClick={props.onCancel}
        >
          取消导入
        </button>
      </div>
      <p className="workbench__status">
        预览校验令牌 previewRevision：<code>{preview.previewRevision}</code>
        （previewToken 会原样回显；若期间工作台被改动，导入会以 409 拒绝并要求重新预览）
      </p>
    </div>
  );
}

/**
 * 预览影响范围的一行人话（纯函数：把「可导入 / 模式 / 影响页面 / 计数」拼成可读文本，
 * 便于单独阅读与断言，也不让组件函数承担分支）。
 */
function describeImpact(preview: WorkbenchImportPreview): string {
  const counts = preview.counts;
  const modeLabel = preview.mode === 'merge' ? '合并' : '替换';
  const affected = preview.affectedPages.length === 0 ? '（无）' : preview.affectedPages.join('、');
  return [
    `可导入：${preview.importable ? '是' : '否'}`,
    `模式：${modeLabel}`,
    `影响页面：${affected}`,
    `新增页面 ${counts.pagesNew} / 替换 ${counts.pagesReplaced} / 跳过 ${counts.pagesSkipped}`,
    `新增组件 ${counts.instancesNew} / 替换 ${counts.instancesReplaced} / 跳过 ${counts.instancesSkipped}`,
  ].join(' · ');
}

/** 未知或未启用的模块：区分「已注册但未启用」与「完全未知」，因为处理建议不同。 */
function UnknownModuleList(props: { readonly modules: readonly WorkbenchImportUnknownModule[] }) {
  if (props.modules.length === 0) {
    return <p className="panel__muted">没有未知模块。</p>;
  }
  return (
    <ul className="workbench__list">
      {props.modules.map((item) => (
        <li
          key={item.moduleId}
          className="workbench__list-item"
          data-testid="import-unknown-module"
          data-module-id={item.moduleId}
        >
          <span>
            <code>{item.moduleId}</code> · 实例 {item.instanceCount} 个 ·{' '}
            {item.registered ? '已注册但未启用（这些实例会被跳过）' : '完全未知（不会隐式启用）'} · 组件：
            {item.widgetTypes.join('、')}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * 问题 / 警告共用同一形状的列表。
 * 只有「问题」带 `data-problem-code`（警告不是致命问题，不该被当成问题定位）。
 */
function ImportIssueList(props: {
  readonly issues: readonly WorkbenchImportIssue[];
  readonly testId: 'import-problem' | 'import-warning';
  readonly emptyText: string;
  readonly showPath: boolean;
  readonly showProblemCode: boolean;
}) {
  if (props.issues.length === 0) {
    return <p className="panel__muted">{props.emptyText}</p>;
  }
  return (
    <ul className="workbench__list">
      {props.issues.map((issue) => {
        const codeAttribute = props.showProblemCode ? { 'data-problem-code': issue.code } : {};
        return (
          <li key={`${issue.code}:${issue.detail}`} className="workbench__list-item" data-testid={props.testId} {...codeAttribute}>
            <span>
              <code>{issue.code}</code> {issue.detail}
              {props.showPath && issue.path !== undefined ? `（${issue.path}）` : ''}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** 可恢复备份区：标题 + 列表本体（三种状态各自一个提前返回，避免嵌套三元）。 */
function BackupListSection(props: { readonly state: WorkbenchController }) {
  return (
    <>
      <h4 className="subsection-title">可恢复备份</h4>
      <BackupListBody
        backups={props.state.backups}
        busy={props.state.busy}
        onRestore={(backupId) => {
          void props.state.restoreBackup(backupId);
        }}
      />
    </>
  );
}

function BackupListBody(props: {
  readonly backups: readonly BackupSummary[] | null;
  readonly busy: boolean;
  readonly onRestore: (backupId: string) => void;
}) {
  if (props.backups === null) {
    return <p className="panel__muted">点击「刷新可恢复备份」查看列表（最多保留最近 5 份）。</p>;
  }
  if (props.backups.length === 0) {
    return <p className="panel__muted">当前工作空间还没有可恢复备份。</p>;
  }
  return (
    <ul className="workbench__list">
      {props.backups.map((backup) => (
        <li key={backup.id} className="workbench__list-item" data-testid="backup-list-item" data-backup-id={backup.id}>
          <span>
            <code>{backup.id.slice(0, 8)}</code> ·{' '}
            {backup.kind === 'pre_import' ? '替换导入前自动留存' : '手动创建'} ·{' '}
            {new Date(backup.createdAt).toISOString()} · schema v{backup.schemaVersion} ·{' '}
            {backup.consumedAt === null ? '可恢复' : '已被使用过（不可重复套用）'}
          </span>
          <button
            type="button"
            className="button button--small button--danger"
            data-testid="backup-restore"
            data-backup-id={backup.id}
            disabled={props.busy || backup.consumedAt !== null}
            title={backup.consumedAt === null ? '恢复到该备份的状态' : '该备份已被使用过'}
            onClick={() => {
              props.onRestore(backup.id);
            }}
          >
            恢复
          </button>
        </li>
      ))}
    </ul>
  );
}
