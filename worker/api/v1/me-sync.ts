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
 * `{seq, entityType, entityId, op, revision, updatedAt, payload}`，`payload` 显式给出，
 * 墓碑时为 `null`；并带同一快照读出的 `meta`，以及**显式**的 `resetRequired`）。
 * 构造后立即用 Schema 解析一次：若失败说明服务端有契约 bug，宁可 500 也不要发出一个
 * 客户端解析不了的半成品响应。注意 `resetRequired` 是**必填**布尔：
 * 服务层两种情况都必须给出（本文件不做默认值填充，也不吞掉它），
 * 因为「要不要先读权威快照」是客户端唯一的、不可推导的安全依据。
 *
 * 游标（v2 = **数据库单调变更序号**，不是时间戳）：
 * - `since` 缺省 = **重置协议**：服务端**不返回历史变更**，而是返回
 *   `resetRequired: true`、`changes: []`、`nextCursor = v2:<本工作空间当前水位>`、
 *   `meta.watermark = 该水位`。客户端必须先 `GET` 一次权威快照（导航/工作台）并替换本地状态，
 *   再把游标设为该 `nextCursor` 取增量。理由见 `sync-api.ts`：变更流的 `payload` 是
 *   **当前**实体内容，把历史日志重放到「已经是当前状态」的本地副本上会误删已恢复的行
 *   （例如「导入 → 删除 → 显式恢复」之后，历史里的 delete 会把已恢复的链接删掉）。
 * - `since=v2:<seq>` = 只取 seq **大于**该值的真实增量（`resetRequired: false`）；
 * - `since=v1:<毫秒>` = **422 `cursor_version_unsupported`**：旧版时间戳游标的语义已经变了，
 *   把毫秒值当 seq 解释会静默漏变更或重放，因此明确要求客户端丢弃本地游标做一次全量重建
 *   （也可以直接不传 `since`，走重置协议）；
 * - 其他损坏输入（`v2:abc` / `abc` / 空串 …）= **422 `cursor_malformed`**。
 * 两者都绝不「猜成 0」——那会静默触发一次全量拉取，并被客户端写回本地水位。
 * - `limit` 缺省取 `SYNC_DEFAULT_LIMIT`；非整数或超出 `1..SYNC_MAX_LIMIT` = **422**。
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

/** 游标问题的结构化原因（放进 422 的 `details.reason`，客户端据此程序化处理）。 */
const CURSOR_REASON = {
  unsupported_version: 'cursor_version_unsupported',
  malformed: 'cursor_malformed',
} as const;

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

    // 游标解析放在路由层：只有这里能把它变成 422（服务层拿到的是已解析的 seq）。
    // `since` 缺省 ⇒ `cursor = null` ⇒ 服务层走**重置协议**（不返回历史，只给稳定水位）。
    // 绝不把缺省/损坏输入当成 0：`0` 会真的把整段历史投递出去，正是本轮修的 P1 缺陷。
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
          { reason: CURSOR_REASON[decoded.reason] },
        );
      }
      cursor = decoded.seq;
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
