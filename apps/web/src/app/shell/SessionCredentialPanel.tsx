/**
 * 会话凭证入口（HUB-050 的「最小会话凭证入口」）。
 *
 * 安全前提：
 * - 输入框是 `type="password"`，且**不**回显已保存的凭证；界面只显示「是否已保存」。
 * - 令牌只进会话内存（见 session-credentials.ts），禁止进入 URL 与日志。
 * - 刻意不做「完整身份界面」：初始化向导、配对、恢复、设备管理 UI 属于后续阶段。
 */
import type { SessionCredentialStore } from '../modules/session-credentials';
import { useSession } from '../modules/session-credentials';

export interface SessionCredentialPanelProps {
  readonly store: SessionCredentialStore;
  /** 保存成功后跳到模块管理视图，减少来回点击。 */
  readonly onSaved?: (() => void) | undefined;
}

export function SessionCredentialPanel(props: SessionCredentialPanelProps) {
  // 只订阅快照（代际 + 是否已认证）：明文凭证从不进入组件的 props/state。
  const session = useSession(props.store);
  const saved = session.authenticated;

  return (
    <section className="panel" aria-labelledby="credential-title">
      <h2 id="credential-title">会话凭证（仅本次会话内存）</h2>
      <p className="panel__muted">
        模块的启停、卸载、恢复与设置修改都需要真实设备凭证。凭证只保存在本页面的内存里：
        <strong>不写入浏览器存储、不进 URL、不写日志、也不进入组件的 props/state</strong>，
        刷新页面即失效。匿名状态下只能浏览公开模块目录与无敏感演示。
      </p>
      <p className="panel__muted">
        当前会话代际：<code>#{String(session.generation)}</code>
        。保存新凭证或清除凭证都会推进代际，并立刻清空旧会话的私有模块状态与 Host 实例，
        滞后返回的旧请求结果会被丢弃。
      </p>
      <form
        className="credential-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const value = data.get('token');
          if (typeof value === 'string') {
            props.store.set(value);
            // 提交后立刻清空输入框内容，避免凭证停留在 DOM 里。
            event.currentTarget.reset();
            props.onSaved?.();
          }
        }}
      >
        <label className="field" htmlFor="session-token">
          <span className="field__label">设备令牌（Bearer）</span>
          <input
            id="session-token"
            name="token"
            type="password"
            className="field__input"
            autoComplete="off"
            spellCheck={false}
            placeholder="ffh_dev_…"
            aria-describedby="session-token-hint"
          />
        </label>
        <div className="credential-form__actions">
          <button type="submit" className="button">
            保存到会话内存
          </button>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              props.store.clear();
            }}
          >
            清除凭证
          </button>
        </div>
      </form>
      <p id="session-token-hint" className="panel__muted" role="status">
        {saved ? '当前状态：已保存凭证（不显示内容）。' : '当前状态：未保存凭证，模块私有状态不可读写。'}
      </p>
    </section>
  );
}
