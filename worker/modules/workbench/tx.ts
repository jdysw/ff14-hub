/**
 * 工作台写入的**原子幂等事务**骨架（HUB-045 / HUB-046 / HUB-054）。
 *
 * 为什么需要这一层（复核要求：状态/布局/实例提交不能半成功，重放不能重复施加副作用）：
 *
 * 一次工作台写入由三部分组成，必须在**同一个 D1 batch（同一个事务）**里完成：
 *   1. **认领**：`INSERT INTO workbench_operations ... SELECT ... WHERE <全部前置条件>
 *      ON CONFLICT (workspace_id, operation_id) DO NOTHING`；
 *   2. **变更**：若干条写入语句；
 *   3. **收尾**：把真实结果写回 `result_json` 并清空 `attempt_token`。
 *
 * 每条变更语句都带同一个守卫：
 *   `EXISTS (SELECT 1 FROM workbench_operations
 *             WHERE workspace_id = ? AND operation_id = ? AND attempt_token = ?)`
 *
 * 这个守卫同时解决两个问题，且都不依赖「读-判-写」之间的时间窗：
 * - **并发/抢输**：另一个请求先插入了同一 operationId（token 不同）→ 本次认领插入 0 行
 *   → 守卫查不到自己的 token → 所有变更语句都不生效。
 * - **重放**：客户端用同一个 operationId 重试时，服务端生成**新的随机 token**，
 *   它永远不会等于已存行的 token（已存行在收尾时已置空）→ 变更语句同样不生效，
 *   直接返回首次的结果。
 *
 * 为什么不用 `changes() = 1` 链：链式 `changes()` 只反映**紧邻的上一条语句**，
 * 而工作台里有大量「可能影响 0 行」的语句（清掉旧默认页、删除不存在的布局行）。
 * 一旦中间某条影响 0 行，后续语句就会被误跳过。token 守卫与行数无关，因此更稳。
 *
 * 失败回滚：D1 的 `batch()` 是单个事务；任意一条语句违反约束（唯一/FK/CHECK）都会
 * 让**整个 batch** 回滚，因此不会留下半完成状态。测试用真实的约束冲突验证这一点。
 */
import type { ApiErrorCode } from '@ff14-hub/shared';

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
  | 'duplicate_slug'
  | 'backup_not_found'
  | 'import_not_importable'
  | 'import_preview_stale'
  | 'import_too_large'
  | 'export_too_large'
  | 'invalid_input'
  | 'persist_failed';

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
  duplicate_slug: 'conflict',
  backup_not_found: 'not_found',
  import_not_importable: 'validation_failed',
  import_preview_stale: 'conflict',
  import_too_large: 'payload_too_large',
  export_too_large: 'payload_too_large',
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

/** 守卫 SQL 片段与它的绑定值。拼接时必须原样追加到语句的 WHERE 条件之后。 */
export interface IdempotencyGuard {
  readonly sql: string;
  readonly binds: readonly string[];
}

/** 「本次尝试仍然持有认领」的守卫 SQL 片段。绑定顺序：workspaceId、operationId、token。 */
export const GUARD_SQL = `EXISTS (SELECT 1 FROM workbench_operations g
                                 WHERE g.workspace_id = ? AND g.operation_id = ? AND g.attempt_token = ?)`;

/**
 * 「本次尝试仍然持有认领」的守卫条件。
 * 只比对 `attempt_token`，因此重放（新 token）与抢输（没插进去）都不可能命中。
 */
export function idempotencyGuard(input: {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly token: string;
}): IdempotencyGuard {
  return {
    sql: GUARD_SQL,
    binds: [input.workspaceId, input.operationId, input.token],
  };
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

/**
 * 幂等**短路**：若同一个 operationId 已经成功提交过，直接返回首次结果。
 *
 * 为什么必须在方法入口做，而不能只依赖认领语句：
 * 各写入方法在进入 `runIdempotentWrite` 之前会先读状态并做「新鲜度」判断
 * （布局的 `baseRevision`、页面的 `expectedRevision`、实例的 `revision`）。
 * 首次提交成功后这些前置条件**必然已经变化**，于是重试会被早退成 409，
 * 客户端拿不到首次结果——而那恰恰是幂等最该生效的场景（响应丢失后的重试）。
 *
 * 安全性：只按「认证得到的 workspaceId + 客户端给的 operationId」查一行，
 * 命中的结果本身就是该工作空间首次提交的响应，不含任何跨工作空间数据。
 *
 * 返回 null 表示「没有可短路的重放，继续走正常写入路径」。
 */
export async function readWorkbenchReplay<T>(input: {
  readonly db: D1Database;
  readonly workspaceId: string;
  readonly operationId: string;
  readonly kind: string;
}): Promise<WorkbenchResult<T> | null> {
  const existing = await readOperationRow(input.db, input.workspaceId, input.operationId);
  if (existing === null) {
    return null;
  }
  if (existing.kind !== input.kind) {
    return workbenchFailure('operation_id_reused', `operationId 已用于 ${existing.kind} 操作`);
  }
  if (existing.attempt_token !== null) {
    // batch 是原子的，因此外部不应观测到未收尾的行；观测到就如实报告，不猜结果。
    return workbenchFailure('persist_failed', '存在未收尾的幂等记录');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing.result_json);
  } catch {
    return workbenchFailure('persist_failed', '幂等记录已损坏');
  }
  return { ok: true, value: parsed as T, replayed: true };
}

export interface OperationRow {
  readonly kind: string;
  readonly result_json: string;
  readonly attempt_token: string | null;
}

/** 读取幂等记录（用于判定「重放」与「operationId 类别冲突」）。 */
export async function readOperationRow(
  db: D1Database,
  workspaceId: string,
  operationId: string,
): Promise<OperationRow | null> {
  return await db
    .prepare('SELECT kind, result_json, attempt_token FROM workbench_operations WHERE workspace_id = ? AND operation_id = ?')
    .bind(workspaceId, operationId)
    .first<OperationRow>();
}

export interface IdempotentWriteInput<T> {
  readonly db: D1Database;
  readonly workspaceId: string;
  readonly operationId: string;
  /** 操作类别。同一个 operationId 用于不同类别时判为冲突（不允许静默当重放）。 */
  readonly kind: string;
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
   * 之所以是回调而不是现成数组：守卫里的 `attempt_token` 由本函数在认领时生成，
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
 * 返回 `replayed: true` 表示命中了已存在的同 operationId 且类别一致——
 * 此时**没有任何语句被执行**（batch 里认领插入 0 行，守卫全部不成立）。
 */
export async function runIdempotentWrite<T>(input: IdempotentWriteInput<T>): Promise<WorkbenchResult<T>> {
  const token = crypto.randomUUID();
  const resultJson = JSON.stringify(input.result);

  const claim = input.db
    .prepare(
      `INSERT INTO workbench_operations (workspace_id, operation_id, kind, result_json, created_at, attempt_token)
       SELECT ?, ?, ?, '', ?, ?
        WHERE (${input.preconditionSql === '' ? '1 = 1' : input.preconditionSql})
       ON CONFLICT (workspace_id, operation_id) DO NOTHING`,
    )
    .bind(input.workspaceId, input.operationId, input.kind, input.now, token, ...input.preconditionBinds);

  const finalize = input.db
    .prepare(
      `UPDATE workbench_operations SET result_json = ?, attempt_token = NULL
        WHERE workspace_id = ? AND operation_id = ? AND attempt_token = ?`,
    )
    .bind(resultJson, input.workspaceId, input.operationId, token);

  let batchResults: D1Result[];
  try {
    batchResults = await input.db.batch([
      claim,
      ...input.buildStatements({ sql: GUARD_SQL, binds: [input.workspaceId, input.operationId, token] }),
      finalize,
    ]);
  } catch (error) {
    // 约束冲突等：整个 batch 已回滚，什么都没提交。如实报告，绝不假装成功。
    return workbenchFailure('persist_failed', `写入事务失败：${errorNameOf(error)}`);
  }

  const claimed = (batchResults[0]?.meta.changes ?? 0) === 1;
  if (claimed) {
    // 收尾必须成功更新 1 行；否则说明守卫/语句构造有误，属于内部不一致。
    const finalized = batchResults[batchResults.length - 1]?.meta.changes ?? 0;
    if (finalized !== 1) {
      // 事务已提交，无法回滚；但必须让调用方知道结果不可信，而不是返回成功。
      return workbenchFailure('persist_failed', '幂等收尾未生效（内部不一致）');
    }
    return { ok: true, value: input.result, replayed: false };
  }

  // 认领失败：重放（同类别）或类别冲突，或前置条件不满足。
  const existing = await readOperationRow(input.db, input.workspaceId, input.operationId);
  if (existing !== null) {
    if (existing.kind !== input.kind) {
      return workbenchFailure('operation_id_reused', `operationId 已用于 ${existing.kind} 操作`);
    }
    if (existing.attempt_token !== null) {
      // 事务是原子的，因此外部不应观测到未收尾的行。真观测到了就如实报告，不猜结果。
      return workbenchFailure('persist_failed', '存在未收尾的幂等记录');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing.result_json);
    } catch {
      return workbenchFailure('persist_failed', '幂等记录已损坏');
    }
    return { ok: true, value: parsed as T, replayed: true };
  }

  const explained = await input.explain();
  return explained ?? workbenchFailure('persist_failed', '认领失败且无法解释');
}

/** 错误名（把错误对象降级成可安全回显的一小段文本，绝不回显堆栈）。 */
export function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * 把若干语句合成一组 batch 语句，并统一追加「本次尝试」守卫。
 * 之所以集中在这里：守卫的绑定顺序很容易写错，集中一处可被测试覆盖。
 */
export function guardedStatements(
  db: D1Database,
  guard: IdempotencyGuard,
  statements: readonly { readonly sql: string; readonly binds: readonly unknown[] }[],
): D1PreparedStatement[] {
  return statements.map((statement) =>
    db.prepare(`${statement.sql} AND ${guard.sql}`).bind(...statement.binds, ...guard.binds),
  );
}
