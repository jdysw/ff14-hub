/**
 * `/api/v1/me/sync/changes` —— 跨设备变更/水位（阶段 04：HUB-051 / ADR-0004 D7）。
 *
 * 安全前提：
 * - 挂载在 `meRoutes` 之下，先经 `deviceAuth()`；未授权一律 401。
 * - 水位只描述**本工作空间**的行；作用域只取自 `c.get('workspaceId')`（认证结果），
 *   绝不接受客户端提交的 workspace id，因此拿 A 的凭证拿不到 B 的任何变更。
 * - 这是**只读**端点：不写任何表、不施加任何副作用、不做墓碑 GC。
 *
 * 契约：响应严格符合 `syncChangesResponseSchema`（每条 change 恰好
 * `{entityType, entityId, op, revision, updatedAt, payload}`，`payload` 显式给出，
 * 墓碑时为 `null`）。构造后立即用 Schema 解析一次：若失败说明服务端有契约 bug，
 * 宁可 500 也不要发出一个客户端解析不了的半成品响应。
 *
 * 游标：`since` 缺失 = 首次全量（从 0 开始）；非法游标返回 **422**（`validation_failed`），
 * 绝不「猜成 0」——那会静默触发一次全量拉取，并被客户端写回本地水位。
 */
import {
  ApiError,
  DEFAULT_ERROR_MESSAGE,
  SYNC_DEFAULT_LIMIT,
  SYNC_MAX_LIMIT,
  SYNC_MESSAGES,
  decodeSyncCursor,
  syncChangesResponseSchema,
} from '@ff14-hub/shared';
import type { Hono } from 'hono';
import { noStoreJson } from '../../lib/response';
import { createSyncService } from '../../modules/sync/service';
import type { AppBindings } from '../../types';

/** 只接受十进制数字串（不接受 `1.5` / `1e2` / `+1` / 空串 / 负号）。 */
const LIMIT_PATTERN = /^\d+$/;

/**
 * 解析 `limit` 查询参数。
 *
 * 不合法一律 422（而不是截断到上限）：`limit=100000` 会让一个请求把 Worker 的
 * CPU/内存预算打穿（页大小同时是每请求的工作量上限），静默截断会让客户端以为
 * 「服务端确认只有这些变更」。
 */
function parseLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return SYNC_DEFAULT_LIMIT;
  }
  const reject = (): never => {
    const detail = `limit 必须是整数，允许范围 1..${String(SYNC_MAX_LIMIT)}`;
    throw new ApiError(
      'validation_failed',
      `${DEFAULT_ERROR_MESSAGE.validation_failed}（${detail}）`,
      `sync_limit_invalid:${detail}`,
    );
  };
  if (!LIMIT_PATTERN.test(raw)) {
    reject();
  }
  const limit = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > SYNC_MAX_LIMIT) {
    reject();
  }
  return limit;
}

/** 在 /me 子树里注册同步水位路由。 */
export function registerMeSyncRoutes(me: Hono<AppBindings>): void {
  me.get('/sync/changes', async (c) => {
    const rawSince = c.req.query('since');
    const limit = parseLimit(c.req.query('limit'));

    // 游标解析放在路由层：只有这里能把它变成 422（服务层拿到的是已解析的时间戳）。
    let cursor: number | null = null;
    if (rawSince !== undefined) {
      const decoded = decodeSyncCursor(rawSince);
      if (!decoded.ok) {
        const message =
          decoded.reason === 'unsupported_version'
            ? SYNC_MESSAGES.cursor_unsupported_version
            : SYNC_MESSAGES.cursor_malformed;
        throw new ApiError(
          'validation_failed',
          `${DEFAULT_ERROR_MESSAGE.validation_failed}（${message}）`,
          `sync_cursor_${decoded.reason}`,
        );
      }
      cursor = decoded.updatedAtMs;
    }

    const service = createSyncService({ db: c.env.DB });
    const response = await service.listChanges({
      workspaceId: c.get('workspaceId'),
      cursor,
      limit,
    });
    return noStoreJson(c, syncChangesResponseSchema.parse(response));
  });
}
