/**
 * 备份 / 导入 / 恢复面板（阶段 03 / HUB-054）。
 *
 * 三条不可含糊的事实必须在界面上看得见：
 * 1. **导出是真实下载**：成功后同时触发浏览器下载（Blob + createObjectURL + `download` 的 `<a>`）
 *    并把序列化文本渲染到只读元素里（人眼核对 + 断言）。
 * 2. **导入先预览、再显式确认**：文件选择 → 预览（新增/替换/跳过计数、影响页面、未知模块、
 *    问题与警告）→ 点确认才 `confirm: true` + `previewRevision` 提交；有问题时**不写任何数据**。
 * 3. **容量边界可见**：显示本次导出字节数与上限（48 KiB），而不是等失败才让人猜。
 *
 * 备份**只含工作台配置**：绝不含设备 Token、恢复密钥、WebDAV 凭证或任何服务端秘密。
 */
import { useRef, useState, type ChangeEvent } from 'react';
import { WORKBENCH_BACKUP_KIND, WORKBENCH_BACKUP_MAX_BYTES } from '@ff14-hub/shared';
import type { WorkbenchImportMode } from '@ff14-hub/shared';
import type { WorkbenchController } from './use-workbench';

export interface BackupPanelProps {
  readonly state: WorkbenchController;
}

/**
 * 读取文件文本。
 * 优先用 `Blob.text()`；老环境（以及部分 DOM 实现）没有它时退回 `FileReader`，
 * 两条路径失败都只抛给调用方，由调用方转成可读文案。
 */
async function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') {
    return await file.text();
  }
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => {
      reject(new Error('读取失败'));
    };
    reader.readAsText(file);
  });
}

export function BackupPanel(props: BackupPanelProps) {
  const { state } = props;
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<WorkbenchImportMode>('merge');
  const [fileError, setFileError] = useState<string | null>(null);
  const preview = state.importPreview;

  /** 读取用户选择的文件：解析失败给出可读错误，**绝不抛异常**。 */
  async function handleFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (file === undefined) {
      return;
    }
    setFileError(null);
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

  return (
    <section className="workbench__panel" aria-labelledby="workbench-backup-title" id="workbench-backup">
      <h3 className="subsection-title" id="workbench-backup-title">
        备份 / 导入 / 恢复（仅工作台配置）
      </h3>
      <p className="panel__muted">
        备份只包含页面、组件实例与布局，<strong>不含</strong>设备 Token、恢复密钥、WebDAV 凭证
        或任何服务端秘密；文档类型必须为 <code>{WORKBENCH_BACKUP_KIND}</code>。
        导出与导入共用同一个容量上限：{String(WORKBENCH_BACKUP_MAX_BYTES)} 字节（48 KiB）。
      </p>

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

      {state.backupSize === null ? null : (
        <p className="workbench__status" data-testid="backup-size">
          最近一次导出：{state.backupSize.byteLength} 字节 / 上限 {state.backupSize.maxBytes} 字节
          {state.backupSize.byteLength >= state.backupSize.maxBytes
            ? '（已达上限：请减少页面或组件后再导出）'
            : ''}
        </p>
      )}

      <label className="field">
        <span className="field__label">导出内容（只读，便于核对）</span>
        <textarea
          className="field__input field__input--code"
          data-testid="backup-export-output"
          readOnly
          rows={4}
          value={state.exportedJson ?? ''}
          placeholder="点击「导出备份」后，这里会显示导出的 JSON 文本。"
        />
      </label>

      <fieldset className="workbench__fieldset">
        <legend className="field__label">导入模式</legend>
        {(
          [
            { value: 'merge', label: '合并导入（同名页面保留，逐条合并）' },
            { value: 'replace', label: '替换导入（服务端会先自动留一份可恢复备份）' },
          ] as const
        ).map((option) => (
          <label key={option.value} className="field field--inline">
            <input
              type="radio"
              name="workbench-import-mode"
              value={option.value}
              checked={mode === option.value}
              onChange={() => {
                setMode(option.value);
              }}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>

      <label className="field">
        <span className="field__label">选择备份文件（.json）</span>
        <input
          ref={fileRef}
          type="file"
          className="field__input"
          data-testid="backup-import-file"
          accept="application/json,.json"
          onChange={(event) => {
            void handleFile(event);
          }}
        />
      </label>

      {fileError === null ? null : (
        <p className="notice notice--error" role="alert" data-testid="import-file-error">
          {fileError}
        </p>
      )}

      {preview === null ? (
        <p className="panel__muted">
          还没有预览结果：选择文件后会自动预览，<strong>预览不会写入任何数据</strong>。
        </p>
      ) : (
        <div className="workbench__preview" data-testid="import-preview">
          <p className="workbench__status" data-testid="import-impact">
            可导入：{preview.preview.importable ? '是' : '否'} · 模式：
            {preview.preview.mode === 'merge' ? '合并' : '替换'} · 影响页面：
            {preview.preview.affectedPages.length === 0 ? '（无）' : preview.preview.affectedPages.join('、')} ·
            新增页面 {preview.preview.counts.pagesNew} / 替换 {preview.preview.counts.pagesReplaced} / 跳过{' '}
            {preview.preview.counts.pagesSkipped} · 新增组件 {preview.preview.counts.instancesNew} / 替换{' '}
            {preview.preview.counts.instancesReplaced} / 跳过 {preview.preview.counts.instancesSkipped}
          </p>

          <p className="panel__muted">{preview.preview.confirmPrompt}</p>

          <h4 className="subsection-title">未知或未启用的模块</h4>
          {preview.preview.unknownModules.length === 0 ? (
            <p className="panel__muted">没有未知模块。</p>
          ) : (
            <ul className="workbench__list">
              {preview.preview.unknownModules.map((item) => (
                <li key={item.moduleId} className="workbench__list-item" data-testid="import-unknown-module" data-module-id={item.moduleId}>
                  <span>
                    <code>{item.moduleId}</code> · 实例 {item.instanceCount} 个 ·{' '}
                    {item.registered ? '已注册但未启用（这些实例会被跳过）' : '完全未知（不会隐式启用）'} · 组件：
                    {item.widgetTypes.join('、')}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <h4 className="subsection-title">问题（非空即不可导入）</h4>
          {preview.preview.problems.length === 0 ? (
            <p className="panel__muted">没有问题。</p>
          ) : (
            <ul className="workbench__list">
              {preview.preview.problems.map((issue) => (
                <li key={`${issue.code}:${issue.detail}`} className="workbench__list-item" data-testid="import-problem" data-problem-code={issue.code}>
                  <span>
                    <code>{issue.code}</code> {issue.detail}
                    {issue.path === undefined ? '' : `（${issue.path}）`}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <h4 className="subsection-title">警告</h4>
          {preview.preview.warnings.length === 0 ? (
            <p className="panel__muted">没有警告。</p>
          ) : (
            <ul className="workbench__list">
              {preview.preview.warnings.map((issue) => (
                <li key={`${issue.code}:${issue.detail}`} className="workbench__list-item" data-testid="import-warning">
                  <span>
                    <code>{issue.code}</code> {issue.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="workbench__toolbar-group">
            <button
              type="button"
              className="button button--danger"
              data-testid="import-confirm"
              disabled={!preview.preview.importable || state.busy}
              title={
                preview.preview.importable
                  ? '确认导入（会带上 previewRevision 提交）'
                  : '存在致命问题，服务端不会执行任何写入'
              }
              onClick={() => {
                void state.confirmImport();
              }}
            >
              确认导入
            </button>
            <button
              type="button"
              className="button button--secondary"
              data-testid="import-cancel"
              onClick={() => {
                state.cancelImport();
              }}
            >
              取消导入
            </button>
          </div>
          <p className="workbench__status">
            预览校验令牌 previewRevision：<code>{preview.preview.previewRevision}</code>
            （若期间工作台被改动，导入会以 409 拒绝并要求重新预览）
          </p>
        </div>
      )}

      <h4 className="subsection-title">可恢复备份</h4>
      {state.backups === null ? (
        <p className="panel__muted">点击「刷新可恢复备份」查看列表（最多保留最近 5 份）。</p>
      ) : state.backups.length === 0 ? (
        <p className="panel__muted">当前工作空间还没有可恢复备份。</p>
      ) : (
        <ul className="workbench__list">
          {state.backups.map((backup) => (
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
                disabled={state.busy || backup.consumedAt !== null}
                title={backup.consumedAt === null ? '恢复到该备份的状态' : '该备份已被使用过'}
                onClick={() => {
                  void state.restoreBackup(backup.id);
                }}
              >
                恢复
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
