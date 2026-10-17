/**
 * 模块管理界面（HUB-050 的可视化验收入口）。
 *
 * 它证明的是**真实联动**，而不是好看的静态页：
 * - 模块目录来自 `GET /api/v1/modules/catalog`（匿名可读，公开元数据）。
 * - 模块状态来自 `GET /api/v1/me/modules`（真实设备鉴权）；没有凭证时状态不可读写。
 * - 启停 / 卸载 / 恢复 / 保存设置都走 `PATCH /api/v1/me/modules/:id`，
 *   并带上 `expectedRevision` 防静默覆盖；成功后就地显示服务端返回的副作用说明。
 * - 「清数据」按钮刻意保留并调用 purge：让 501 拒绝在界面上是可见事实，而不是口头承诺。
 */
import {
  MODULE_STATUS_HINTS,
  MODULE_STATUS_LABELS,
  type ModuleDescriptor,
  type ModuleMutationResponse,
  type ModuleSupportedAction,
  type WorkspaceModuleStatus,
} from '@ff14-hub/shared';
import { useState } from 'react';
import type { ModuleState } from '../modules/use-module-state';

export interface ModuleManagerPanelProps {
  readonly moduleState: ModuleState;
  readonly hasCredential: boolean;
  /** 变更成功后通知外层（例如卸载后清理当前 Host 实例）。 */
  readonly onMutated?: ((moduleId: string, response: ModuleMutationResponse) => void) | undefined;
  readonly onRequestCredential?: (() => void) | undefined;
}

interface Notice {
  readonly kind: 'ok' | 'error';
  readonly text: string;
}

function actionLabel(action: ModuleSupportedAction): string {
  switch (action) {
    case 'enable':
      return '启用';
    case 'disable':
      return '停用';
    case 'uninstall':
      return '卸载';
    case 'restore':
      return '恢复';
  }
}

function primaryActions(status: WorkspaceModuleStatus['status']): readonly ModuleSupportedAction[] {
  switch (status) {
    case 'not_installed':
      return ['enable'];
    case 'enabled':
      return ['disable', 'uninstall'];
    case 'disabled':
      return ['enable', 'uninstall'];
    case 'uninstalled':
      return ['restore'];
  }
}

export function ModuleManagerPanel(props: ModuleManagerPanelProps) {
  const { moduleState, hasCredential } = props;
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [settingsDrafts, setSettingsDrafts] = useState<Record<string, string>>({});

  async function runAction(moduleId: string, action: ModuleSupportedAction, revision: number): Promise<void> {
    setBusy(`${moduleId}:${action}`);
    setNotice(null);
    const outcome = await moduleState.mutate(moduleId, { action, expectedRevision: revision });
    setBusy(null);
    if (!outcome.ok) {
      setNotice({ kind: 'error', text: `操作被拒绝：${outcome.message}` });
      if (outcome.conflict) {
        // 409 表示本地 revision 已过期：刷新后用户可以基于最新状态重试。
        moduleState.reload();
      }
      return;
    }
    setNotice({ kind: 'ok', text: outcome.response.effect.message });
    props.onMutated?.(moduleId, outcome.response);
  }

  async function saveSettings(module: ModuleDescriptor, status: WorkspaceModuleStatus): Promise<void> {
    const draft = settingsDrafts[module.id] ?? JSON.stringify(status.settings, null, 2);
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch {
      setNotice({ kind: 'error', text: '设置不是合法的 JSON，未提交。' });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setNotice({ kind: 'error', text: '设置必须是一个 JSON 对象，未提交。' });
      return;
    }
    setBusy(`${module.id}:settings`);
    setNotice(null);
    const outcome = await moduleState.mutate(module.id, {
      settings: parsed as Record<string, unknown>,
      expectedRevision: status.revision,
      settingsVersion: module.settingsSchemaVersion,
    });
    setBusy(null);
    if (!outcome.ok) {
      setNotice({ kind: 'error', text: `设置未保存：${outcome.message}` });
      if (outcome.conflict) {
        moduleState.reload();
      }
      return;
    }
    setNotice({ kind: 'ok', text: outcome.response.effect.message });
    // 清空草稿：让输入框重新从服务端返回的设置派生。
    setSettingsDrafts((current) => {
      const next = { ...current };
      delete next[module.id];
      return next;
    });
    props.onMutated?.(module.id, outcome.response);
  }

  async function requestPurge(moduleId: string): Promise<void> {
    setBusy(`${moduleId}:purge`);
    setNotice(null);
    // 服务端在**校验 revision 之前**就拒绝 purge，因此这里用 0 也不会变成「先改状态再拒绝」。
    const result = await moduleState.mutate(moduleId, { expectedRevision: 0, action: 'purge' });
    setBusy(null);
    setNotice(
      result.ok
        ? { kind: 'ok', text: '意外地执行了清数据（本阶段不应发生）。' }
        : { kind: 'error', text: `清数据被明确拒绝（没有删除任何数据）：${result.message}` },
    );
  }

  return (
    <section className="panel" aria-labelledby="modules-title">
      <h2 id="modules-title">模块管理</h2>
      <p className="panel__muted">
        目录：<code>GET /api/v1/modules/catalog</code>（匿名可读）。
        状态：<code>GET /api/v1/me/modules</code>（设备鉴权）。
        变更：<code>PATCH /api/v1/me/modules/:id</code>，必须携带 <code>expectedRevision</code>。
      </p>

      {moduleState.error !== null ? (
        <p className="notice notice--error" role="alert">
          {moduleState.error}
        </p>
      ) : null}

      {!hasCredential ? (
        <p className="notice notice--warn" role="status">
          尚未保存设备凭证：目录可以浏览，但私有状态无法读取，也无法启停模块。
          {props.onRequestCredential !== undefined ? (
            <button type="button" className="button button--small" onClick={props.onRequestCredential}>
              去填写会话凭证
            </button>
          ) : null}
        </p>
      ) : null}

      {notice !== null ? (
        <p className={notice.kind === 'ok' ? 'notice notice--ok' : 'notice notice--error'} role="status">
          {notice.text}
        </p>
      ) : null}

      <div className="panel__toolbar">
        <button
          type="button"
          className="button button--secondary button--small"
          onClick={() => {
            moduleState.reload();
          }}
        >
          刷新模块状态
        </button>
        <span className="panel__muted">
          {moduleState.loading ? '加载中…' : `已加载 ${String(moduleState.catalog.length)} 个模块定义`}
        </span>
      </div>

      <ul className="module-list">
        {moduleState.catalog.map((module) => {
          const status = moduleState.statuses[module.id];
          const current = status?.status ?? 'not_installed';
          const revision = status?.revision ?? 0;
          const settingsVersion = status?.settingsVersion ?? 0;
          return (
            <li
              key={module.id}
              className="module-card"
              data-testid="module-card"
              data-module-id={module.id}
              data-status={current}
            >
              <header className="module-card__header">
                <h3 className="module-card__title">{module.displayName}</h3>
                <p className="module-card__meta">
                  <code>{module.id}</code> · v{module.version}
                </p>
                <p className="module-card__badges">
                  <span className="tag tag--status">{MODULE_STATUS_LABELS[current]}</span>
                  <span className="tag">revision {String(revision)}</span>
                  {settingsVersion !== module.settingsSchemaVersion ? (
                    <span className="tag tag--warn">设置版本 {String(settingsVersion)}</span>
                  ) : null}
                </p>
              </header>

              <p className="module-card__hint">{MODULE_STATUS_HINTS[current]}</p>

              <dl className="module-card__facts">
                <dt>能力</dt>
                <dd>{module.capabilities.length === 0 ? '（未申请能力）' : module.capabilities.join('、')}</dd>
                <dt>组件</dt>
                <dd>
                  {module.widgets
                    .map((widget) => `${widget.displayName}${widget.allowMultiple ? '（可多实例）' : '（单实例）'}`)
                    .join('、')}
                </dd>
              </dl>

              <div className="module-card__actions">
                {primaryActions(current).map((action) => (
                  <button
                    key={action}
                    type="button"
                    className="button button--small"
                    disabled={!hasCredential || busy !== null}
                    onClick={() => {
                      void runAction(module.id, action, revision);
                    }}
                  >
                    {actionLabel(action)}
                  </button>
                ))}
                <button
                  type="button"
                  className="button button--small button--secondary"
                  disabled={!hasCredential || busy !== null}
                  onClick={() => {
                    void requestPurge(module.id);
                  }}
                >
                  清数据（本阶段被拒绝）
                </button>
              </div>

              <details className="module-card__settings">
                <summary>模块设置（JSON）与版本</summary>
                <p className="panel__muted">
                  当前设置版本 {String(settingsVersion)}，组件契约版本 {String(module.settingsSchemaVersion)}。
                  保存时会带上这两个版本与 <code>expectedRevision</code>；服务端校验不通过会返回 409/422。
                </p>
                <label className="field">
                  <span className="field__label">设置 JSON（{module.displayName}）</span>
                  <textarea
                    className="field__input field__input--code"
                    rows={4}
                    spellCheck={false}
                    value={settingsDrafts[module.id] ?? JSON.stringify(status?.settings ?? {}, null, 2)}
                    onChange={(event) => {
                      const value = event.target.value;
                      setSettingsDrafts((drafts) => ({ ...drafts, [module.id]: value }));
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="button button--small"
                  disabled={!hasCredential || busy !== null || status === undefined}
                  onClick={() => {
                    if (status !== undefined) {
                      void saveSettings(module, status);
                    }
                  }}
                >
                  保存设置
                </button>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
