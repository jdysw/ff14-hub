/**
 * 工作台写入的原子幂等事务（HUB-045 / HUB-046 / HUB-054）。
 *
 * 本文件现在是**薄绑定**：算法（认领 + attempt_token 守卫 + 请求指纹 + 原子 batch +
 * 重放短路）只有一份实现，在 `worker/modules/idempotency/ledger.ts`
 * （ADR-0004 D11）。这里只做两件事：
 *   1. 把账本表绑定为 `workbench_operations` / `workbench_operation_intents`；
 *   2. 把账本通用的 `reason: string` **显式收窄**成 `WorkbenchRejection`。
 *
 * 为什么必须收窄而不是直接断言：账本是被两个域共用的通用机制，它的失败原因是字符串。
 * 若这里直接 `as WorkbenchRejection`，那么账本将来新增/改名一个原因时，
 * 路由层会拿到一个不在 `ERROR_CODE_BY_WORKBENCH_REJECTION` 里的值，
 * 映射成 `undefined` 错误码而不是响亮的失败。因此用常量集合做运行期校验，
 * 未知字符串一律降级为 `persist_failed`（宁可报内部错误，也不返回不可信的成功）。
 *
 * 语义要点（完整推导见 ledger.ts 的文件头；导出名与语义与阶段 03 完全一致）：
 * - **认领**：`INSERT INTO workbench_operations ... SELECT ... WHERE <全部前置条件>
 *   ON CONFLICT (workspace_id, operation_id) DO NOTHING`。
 * - **守卫**：每条变更语句都带 `attempt_token` 守卫。重放会生成**新的** token，
 *   因此守卫不成立；并发抢输方因为 `ON CONFLICT DO NOTHING` 没插进去、
 *   其**全部语句同样不生效**（不是只跳过第一条）。
 * - **指纹**：`readWorkbenchReplay` 先短路；同 ID 换 kind → `operation_id_reused`，
 *   同 kind 换指纹 → `operation_payload_mismatch`，两者都零写入。
 *   空指纹（迁移前写入的旧行）保守拒绝，要求客户端换新的 operationId。
 * - **收尾**：finalize 必须影响 1 行，否则如实报 `persist_failed`（事务已提交，
 *   无法回滚，但绝不能返回不可信的成功）。
 * - **回滚**：batch 抛错（约束冲突等）时整个事务回滚，什么都没提交。
 */
import type { ApiErrorCode } from '@ff14-hub/shared';
import {
  createLedger,
  errorNameOf,
  fingerprintOf,
  guardedStatements,
  type IdempotencyGuard,
  type LedgerFailure,
  type LedgerResult,
  type OperationRow,
} from '../idempotency/ledger';

// 账本本就与域无关的三件工具：原样再导出，保持阶段 03 的导入路径与导出名不变。
export { errorNameOf, fingerprintOf, guardedStatements };
// 类型同样原样再导出（`import type` + `export type` 以兼容 verbatimModuleSyntax）。
export type { IdempotencyGuard, OperationRow };

/** 工作台写入被拒绝的原因（路由层映射成统一错误契约，服务层不关心 HTTP）。 */
export type WorkbenchRejection =
  | 'page_not_found'
  | 'widget_not_found'
  | 'page_limit_reached'
  | 'widget_limit_reached'
  | 'widget_unknown'
  | 'widget_single_instance'
  | 'widget_config_too_large'
  | 'widget_config_invalid'
  | 'module_not_ready'
  | 'layout_revision_conflict'
  | 'revision_conflict'
  | 'layout_invalid'
  | 'operation_id_reused'
  /** 同一个 operationId 换了目标/正文：意图变了，必须拒绝且零写入。 */
  | 'operation_payload_mismatch'
  | 'duplicate_slug'
  | 'backup_not_found'
  | 'backup_consumed'
  | 'backup_revision_conflict'
  | 'import_not_importable'
  | 'import_preview_stale'
  | 'import_too_large'
  | 'export_too_large'
  | 'export_inconsistent'
  | 'invalid_input'
  | 'persist_failed';

/**
 * 全部合法拒绝原因的**运行期**清单。
 *
 * `satisfies readonly WorkbenchRejection[]` 保证它与上面的联合类型同步：
 * 少写一个会在类型检查时报错，从而让「账本返回的原因能否被映射」永远可判定。
 */
export const WORKBENCH_REJECTIONS = [
  'page_not_found',
  'widget_not_found',
  'page_limit_reached',
  'widget_limit_reached',
  'widget_unknown',
  'widget_single_instance',
  'widget_config_too_large',
  'widget_config_invalid',
  'module_not_ready',
  'layout_revision_conflict',
  'revision_conflict',
  'layout_invalid',
  'operation_id_reused',
  'operation_payload_mismatch',
  'duplicate_slug',
  'backup_not_found',
  'backup_consumed',
  'backup_revision_conflict',
  'import_not_importable',
  'import_preview_stale',
  'import_too_large',
  'export_too_large',
  'export_inconsistent',
  'invalid_input',
  'persist_failed',
] as const satisfies readonly WorkbenchRejection[];

const WORKBENCH_REJECTION_SET: ReadonlySet<string> = new Set<string>(WORKBENCH_REJECTIONS);

/** 类型守卫：把一个任意字符串判定为 `WorkbenchRejection`（真正的收窄，不做无校验断言）。 */
export function isWorkbenchRejection(value: string): value is WorkbenchRejection {
  return WORKBENCH_REJECTION_SET.has(value);
}

/** 收窄账本原因；未知字符串降级为 `persist_failed`（绝不产出非法错误码）。 */
function narrowRejection(reason: string): WorkbenchRejection {
  return isWorkbenchRejection(reason) ? reason : 'persist_failed';
}

/** 拒绝原因 → 对外错误码的唯一映射（与 `errors.ts` 的错误码集合保持一致）。 */
export const ERROR_CODE_BY_WORKBENCH_REJECTION: Readonly<Record<WorkbenchRejection, ApiErrorCode>> = {
  page_not_found: 'not_found',
  widget_not_found: 'not_found',
  page_limit_reached: 'conflict',
  widget_limit_reached: 'conflict',
  widget_unknown: 'validation_failed',
  widget_single_instance: 'conflict',
  widget_config_too_large: 'payload_too_large',
  widget_config_invalid: 'validation_failed',
  module_not_ready: 'conflict',
  layout_revision_conflict: 'conflict',
  revision_conflict: 'conflict',
  layout_invalid: 'validation_failed',
  operation_id_reused: 'conflict',
  operation_payload_mismatch: 'conflict',
  duplicate_slug: 'conflict',
  backup_not_found: 'not_found',
  backup_consumed: 'conflict',
  backup_revision_conflict: 'conflict',
  import_not_importable: 'validation_failed',
  import_preview_stale: 'conflict',
  import_too_large: 'payload_too_large',
  export_too_large: 'payload_too_large',
  export_inconsistent: 'conflict',
  invalid_input: 'validation_failed',
  persist_failed: 'internal_error',
};

export interface WorkbenchFailure {
  readonly ok: false;
  readonly reason: WorkbenchRejection;
  readonly detail: string;
}

export interface WorkbenchSuccess<T> {
  readonly ok: true;
  readonly value: T;
  /** true 表示本次是**重放**：直接返回首次结果，没有施加任何副作用。 */
  readonly replayed: boolean;
}

export type WorkbenchResult<T> = WorkbenchSuccess<T> | WorkbenchFailure;

export function workbenchFailure(reason: WorkbenchRejection, detail: string): WorkbenchFailure {
  return { ok: false, reason, detail };
}

/** 账本表绑定：工作台与导航共用同一算法，只换账本表（ADR-0004 D11）。 */
const workbenchLedger = createLedger({
  operations: 'workbench_operations',
  intents: 'workbench_operation_intents',
});

/**
 * 「本次尝试仍然持有认领」的守卫 SQL 片段。绑定顺序：workspaceId、operationId、token。
 * 取自本工作台账本的绑定，因此表名与守卫语句永远一致。
 */
export const GUARD_SQL: string = workbenchLedger.guardSql;

/**
 * 「本次尝试仍然持有认领」的守卫条件。
 * 只比对 `attempt_token`，因此重放（新 token）与抢输（没插进去）都不可能命中。
 */
export function idempotencyGuard(input: {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly token: string;
}): IdempotencyGuard {
  return workbenchLedger.idempotencyGuard(input);
}

/**
 * 工作台操作的**类别标识**（幂等记录的 `kind`）。
 *
 * 集中定义的原因：同一个 operationId 只允许对应同一类别，而类别字符串同时出现在
 * ①方法入口的「幂等短路」读取、②`runOperation` 的认领写入。
 * 两处各写一遍字面量就会漂移，漂移的后果是「重放被误判为 operationId 类别冲突（409）」。
 */
export const WORKBENCH_OP_KINDS = {
  pageCreate: 'page.create',
  pageUpdate: 'page.update',
  pageDelete: 'page.delete',
  pageRestore: 'page.restore',
  widgetAdd: 'widget.add',
  widgetDuplicate: 'widget.duplicate',
  widgetUpdate: 'widget.update',
  widgetDelete: 'widget.delete',
  templateReplacePage: 'template.replace_page',
  templateResetWorkspace: 'template.reset_workspace',
  importMerge: 'workbench.import.merge',
  importReplace: 'workbench.import.replace',
  backupRestore: 'workbench.backup.restore',
} as const;

/** 布局保存按断点区分类别（同一 operationId 不可能同时是 desktop 与 mobile 的保存）。 */
export function layoutSaveKind(breakpoint: string): string {
  return `layout.save.${breakpoint}`;
}

/** 账本失败 → 工作台失败（唯一的收窄点）。 */
function toWorkbenchFailure(failure: LedgerFailure): WorkbenchFailure {
  return { ok: false, reason: narrowRejection(failure.reason), detail: failure.detail };
}

/** 账本结果 → 工作台结果（成功后形状完全一致，直接透传）。 */
function toWorkbenchResult<T>(result: LedgerResult<T>): WorkbenchResult<T> {
  return result.ok ? result : toWorkbenchFailure(result);
}

/**
 * 幂等**短路**：若同一个 operationId 已经成功提交过，直接返回首次结果。
 *
 * 必须在方法入口做：首次提交成功后各写入方法的前置条件（`baseRevision` /
 * `expectedRevision` / 实例 `revision`）必然已经变化，只依赖认领语句会把
 * 「响应丢失后的原样重试」早退成 409，而幂等恰恰要在那一刻生效。
 */
export async function readWorkbenchReplay<T>(input: {
  readonly db: D1Database;
  readonly workspaceId: string;
  readonly operationId: string;
  readonly kind: string;
  /** 本次请求的指纹；与已存指纹不同即「同 ID 换了意图」，拒绝且零写入。 */
  readonly requestFingerprint: string;
}): Promise<WorkbenchResult<T> | null> {
  const replay = await workbenchLedger.readReplay<T>(input);
  return replay === null ? null : toWorkbenchResult(replay);
}

/** 读取幂等记录（用于判定「重放」与「operationId 类别 / 意图冲突」）。 */
export async function readOperationRow(
  db: D1Database,
  workspaceId: string,
  operationId: string,
): Promise<OperationRow | null> {
  return await workbenchLedger.readOperationRow(db, workspaceId, operationId);
}

export interface IdempotentWriteInput<T> {
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
  readonly explain: () => Promise<WorkbenchFailure | null>;
}

/**
 * 执行一次原子幂等写入。
 *
 * 返回 `replayed: true` 表示命中了已存在的同 operationId 且类别/指纹一致——
 * 此时**没有任何语句被执行**（batch 里认领插入 0 行，守卫全部不成立）。
 */
export async function runIdempotentWrite<T>(input: IdempotentWriteInput<T>): Promise<WorkbenchResult<T>> {
  return toWorkbenchResult(await workbenchLedger.runIdempotentWrite<T>(input));
}
