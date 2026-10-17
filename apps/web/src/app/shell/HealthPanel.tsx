import { API_V1_PREFIX, type ApiErrorBody, type HealthResponse } from '@ff14-hub/shared';
import { useEffect, useState } from 'react';
import { createApiClient } from '../../lib/api-client';

/**
 * 同域 API 连通性面板。
 *
 * 为什么阶段 01 就要有它：它验证的是**调用链本身**
 * （同域部署 → Worker 路由 → Zod 契约 → D1 就绪探针 → 统一错误结构），
 * 而不是任何业务功能。规划 6.1 允许用非真实业务数据的占位 Shell 验证调用链。
 */

const client = createApiClient();

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly health: HealthResponse }
  | { readonly kind: 'error'; readonly status: number; readonly error: ApiErrorBody };

export function HealthPanel() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await client.health();
      if (cancelled) {
        return;
      }
      setState(
        result.ok
          ? { kind: 'ok', health: result.data }
          : { kind: 'error', status: result.status, error: result.error },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="panel" aria-labelledby="health-title">
      <h2 id="health-title">API 连通性</h2>
      <p className="panel__endpoint">
        <code>GET {API_V1_PREFIX}/health</code>
      </p>

      {state.kind === 'loading' && <p role="status">正在检查……</p>}

      {state.kind === 'ok' && (
        <dl className="kv">
          <dt>服务状态</dt>
          <dd>
            <span className={`badge badge--${state.health.status}`}>{state.health.status}</span>
          </dd>
          <dt>数据库</dt>
          <dd>
            <span className={`badge badge--${state.health.database}`}>{state.health.database}</span>
          </dd>
          <dt>服务</dt>
          <dd>
            {state.health.service} v{state.health.version}
          </dd>
          <dt>环境</dt>
          <dd>{state.health.environment}</dd>
          <dt>服务端时间（UTC 毫秒）</dt>
          <dd>{state.health.nowUtcMs}</dd>
        </dl>
      )}

      {state.kind === 'error' && (
        <div role="alert" className="alert">
          <p>
            请求失败（HTTP {state.status}）：{state.error.message}
          </p>
          <p className="alert__meta">
            错误码 <code>{state.error.code}</code> · 请求 ID <code>{state.error.requestId}</code>
          </p>
        </div>
      )}
    </section>
  );
}
