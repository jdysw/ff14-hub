/**
 * 个人活动写入的原子幂等事务（HUB-011 / ADR-0004 D11）。
 *
 * 本文件是**薄绑定**，与 `worker/modules/workbench/tx.ts` 同构：
 * 算法（认领 + attempt_token 守卫 + 请求指纹 + 原子 batch + 重放短路）只有一份实现，
 * 在 `worker/modules/idempotency/ledger.ts`。这里只做两件事：
 *   1. 把账本表绑定为 `event_operations` / `event_operation_intents`
 *      （迁移 0010；刻意与 workbench / nav 分表，避免 kind 命名空间跨域误伤）；
 *   2. 把账本通用的 `reason: string` **显式收窄**成 `EventRejection`。
 *
 * 为什么必须收窄而不是直接断言（与工作台同一条理由）：账本是被多个域共用的通用机制，
 * 它的失败原因是字符串。若直接 `as EventRejection`，账本将来新增/改名一个原因时，
 * 路由层会拿到一个不在 `ERROR_CODE_BY_EVENT_REJECTION` 里的值，映射成 `undefined`
 * 错误码而不是响亮的失败。因此用运行期常量集合校验，未知字符串一律降级为
 * `persist_failed`（宁可报内部错误，也不返回不可信的成功）。
 *
 * 语义要点（完整推导见 ledger.ts 文件头）：
 * - **认领**：`INSERT INTO event_operations ... SELECT ... WHERE <全部前置条件>
 *   ON CONFLICT (workspace_id, operation_id) DO NOTHING`。
 * - **守卫**：每条变更语句都带 `attempt_token` 守卫。重放会生成**新的** token，
 *   因此守卫不成立；并发抢输方因为 `ON CONFLICT DO NOTHING` 没插进去，
 *   其**全部语句同样不生效**（不是只跳过第一条）。
 * - **指纹**：`readEventReplay` 先短路；同 ID 换 kind → `operation_id_reused`，
 *   同 kind 换指纹 → `operation_payload_mismatch`，两者都**零写入**。
 * - **回滚**：batch 抛错（约束冲突等）时整个事务回滚，什么都没提交。
 */
import type { ApiErrorCode } from '@ff14-hub/shared';
import {
  EVENT_LEDGER_SQL,
  createLedger,
  errorNameOf,
  fingerprintOf,
  guardedStatements,
  type IdempotencyGuard,
  type LedgerFailure,
  type LedgerResult,
  type OperationRow,
} from '../idempotency/ledger';

// 账本本就与域无关的三件工具：原样再导出，让服务层的导入路径集中在本模块。
export { errorNameOf, fingerprintOf, guardedStatements };
// 类型同样原样再导出（`import type` + `export type` 以兼容 verbatimModuleSyntax）。
export type { IdempotencyGuard, OperationRow };

/** 个人活动写入被拒绝的原因（路由层映射成统一错误契约，服务层不关心 HTTP）。 */
export type EventRejection =
  /** 活动不存在、不属于本工作空间，或已是墓碑（ADR-0004 D9：越权返回 404，不泄露存在性）。 */
  | 'event_not_found'
  /** `expectedRevision` 与库中当前值不一致：不盲目覆盖，返回结构化冲突。 */
  | 'revision_conflict'
  /** 每工作空间个人活动数达到上限：**冲突**而不是静默丢弃本次提交。 */
  | 'event_limit_reached'
  /** 输入不合法（区服、区间、标题/描述长度、来源链接、operationId…）。 */
  | 'invalid_input'
  /** 同一个 operationId 被用于另一类操作（例如先 create 再 update）。 */
  | 'operation_id_reused'
  /** 同一个 operationId 换了目标/正文/expectedRevision：意图变了，拒绝且零写入。 */
  | 'operation_payload_mismatch'
  /** 事务本身失败或收尾不一致：如实报内部错误，绝不假装成功。 */
  | 'persist_failed';

/**
 * 全部合法拒绝原因的**运行期**清单。
 *
 * `satisfies readonly EventRejection[]` 保证它与上面的联合类型同步：
 * 少写一个会在类型检查时报错，从而让「账本返回的原因能否被映射」永远可判定。
 */
export const EVENT_REJECTIONS = [
  'event_not_found',
  'revision_conflict',
  'event_limit_reached',
  'invalid_input',
  'operation_id_reused',
  'operation_payload_mismatch',
  'persist_failed',
] as const satisfies readonly EventRejection[];

const EVENT_REJECTION_SET: ReadonlySet<string> = new Set<string>(EVENT_REJECTIONS);

/** 类型守卫：把一个任意字符串判定为 `EventRejection`（真正的收窄，不做无校验断言）。 */
export function isEventRejection(value: string): value is EventRejection {
  return EVENT_REJECTION_SET.has(value);
}

/** 收窄账本原因；未知字符串降级为 `persist_failed`（绝不产出非法错误码）。 */
function narrowRejection(reason: string): EventRejection {
  return isEventRejection(reason) ? reason : 'persist_failed';
}

/** 拒绝原因 → 对外错误码的唯一映射（与 `errors.ts` 的错误码集合保持一致）。 */
export const ERROR_CODE_BY_EVENT_REJECTION: Readonly<Record<EventRejection, ApiErrorCode>> = {
  event_not_found: 'not_found',
  revision_conflict: 'conflict',
  event_limit_reached: 'conflict',
  invalid_input: 'validation_failed',
  operation_id_reused: 'conflict',
  operation_payload_mismatch: 'conflict',
  persist_failed: 'internal_error',
};

export interface EventFailure {
  readonly ok: false;
  readonly reason: EventRejection;
  readonly detail: string;
  /**
   * 可安全回显的结构化细节（目前只有 revision 冲突使用它）。
   *
   * 为什么放在失败结果里而不是让路由再查一次库：冲突的「当前 revision」必须在
   * 判定冲突的**同一处**读出（否则两次读取之间可能又变了，客户端会拿到错误基数）。
   * 该字段只允许放可安全回显的内容（实体 ID、revision、可选处理方式），
   * 绝不放入凭证、SQL 或内部路径。
   */
  readonly details?: unknown;
}

export interface EventSuccess<T> {
  readonly ok: true;
  readonly value: T;
  /** true 表示本次是**重放**：直接返回首次结果，没有施加任何副作用。 */
  readonly replayed: boolean;
}

export type EventResult<T> = EventSuccess<T> | EventFailure;

export function eventFailure(reason: EventRejection, detail: string, details?: unknown): EventFailure {
  return details === undefined ? { ok: false, reason, detail } : { ok: false, reason, detail, details };
}

/**
 * 个人活动操作的**类别标识**（幂等记录的 `kind`）。
 *
 * 集中定义的原因：同一个 operationId 只允许对应同一类别，而类别字符串同时出现在
 * ①方法入口的「幂等短路」读取、②`runOperation` 的认领写入。
 * 两处各写一遍字面量就会漂移，漂移的后果是「重放被误判为操作类别冲突（409）」。
 */
export const EVENT_OP_KINDS = {
  create: 'event.create',
  update: 'event.update',
  delete: 'event.delete',
} as const;

/** 账本表绑定：活动模块只换账本表，算法与工作台/导航完全共用（ADR-0004 D11）。 */
const eventLedger = createLedger(EVENT_LEDGER_SQL);

/**
 * 「本次尝试仍然持有认领」的守卫 SQL 片段。绑定顺序：workspaceId、operationId、token。
 * 取自本模块账本的绑定，因此表名与守卫语句永远一致。
 */
export const GUARD_SQL: string = eventLedger.guardSql;

/** 「本次尝试仍然持有认领」的守卫条件（只比对 attempt_token）。 */
export function idempotencyGuard(input: {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly token: string;
}): IdempotencyGuard {
  return eventLedger.idempotencyGuard(input);
}

/** 账本失败 → 活动失败（唯一的收窄点）。 */
function toEventFailure(failure: LedgerFailure): EventFailure {
  return { ok: false, reason: narrowRejection(failure.reason), detail: failure.detail };
}

/** 账本结果 → 活动结果（成功后形状完全一致，直接透传）。 */
function toEventResult<T>(result: LedgerResult<T>): EventResult<T> {
  return result.ok ? result : toEventFailure(result);
}

/**
 * 幂等**短路**：若同一个 operationId 已经成功提交过，直接返回首次结果。
 *
 * 必须在方法入口做：首次提交成功后各写入方法的前置条件（行数上限、`expectedRevision`、
 * 墓碑标记）必然已经变化，只依赖认领语句会把「响应丢失后的原样重试」早退成 409，
 * 而幂等恰恰要在那一刻生效。
 */
export async function readEventReplay<T>(input: {
  readonly db: D1Database;
  readonly workspaceId: string;
  readonly operationId: string;
  readonly kind: string;
  /** 本次请求的指纹；与已存指纹不同即「同 ID 换了意图」，拒绝且零写入。 */
  readonly requestFingerprint: string;
}): Promise<EventResult<T> | null> {
  const replay = await eventLedger.readReplay<T>(input);
  return replay === null ? null : toEventResult(replay);
}

/** 读取幂等记录（用于判定「重放」与「operationId 类别 / 意图冲突」）。 */
export async function readOperationRow(
  db: D1Database,
  workspaceId: string,
  operationId: string,
): Promise<OperationRow | null> {
  return await eventLedger.readOperationRow(db, workspaceId, operationId);
}

export interface EventWriteInput<T> {
  readonly db: D1Database;
  readonly workspaceId: string;
  readonly operationId: string;
  /** 操作类别。同一个 operationId 用于不同类别时判为冲突（不允许静默当重放）。 */
  readonly kind: string;
  /** 请求指纹（见 `fingerprintOf`）：同一个 operationId 换意图时判为冲突。 */
  readonly requestFingerprint: string;
  readonly now: number;
  /**
   * 认领语句的**前置条件**（不含前导 `WHERE`）。
   * 留空字符串表示「无额外前置条件」——此时用 `1 = 1`。
   * 参数占位符按出现顺序追加在操作元数据之后。
   */
  readonly preconditionSql: string;
  readonly preconditionBinds: readonly unknown[];
  /**
   * 用「本次尝试」的守卫构造变更语句。
   * 之所以是回调而不是现成数组：守卫里的 `attempt_token` 由账本在认领时生成，
   * 调用方不可能提前知道它。把 token 交给调用方拼 SQL 是唯一不会写错顺序的做法。
   */
  readonly buildStatements: (guard: IdempotencyGuard) => readonly D1PreparedStatement[];
  /** 首次成功时写入并返回的结果；重放时返回首次存入的同一份 JSON。 */
  readonly result: T;
  /**
   * 认领失败且不存在同 operationId 的记录时调用：重新读取状态，给出**精确**的拒绝原因。
   * 返回 null 表示无法解释（按 `persist_failed` 处理，不猜）。
   */
  readonly explain: () => Promise<EventFailure | null>;
}

/**
 * 执行一次原子幂等写入。
 *
 * 返回 `replayed: true` 表示命中了已存在的同 operationId 且类别/指纹一致——
 * 此时**没有任何语句被执行**（batch 里认领插入 0 行，守卫全部不成立）。
 */
export async function runIdempotentWrite<T>(input: EventWriteInput<T>): Promise<EventResult<T>> {
  return toEventResult(await eventLedger.runIdempotentWrite<T>(input));
}
