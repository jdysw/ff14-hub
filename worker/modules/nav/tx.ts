/**
 * 自由导航写入的原子幂等事务（HUB-048 / HUB-051；ADR-0004 D11）。
 *
 * 与 `worker/modules/workbench/tx.ts` 是**同构**的薄绑定：算法（认领 + attempt_token 守卫 +
 * 请求指纹 + 原子 batch + 重放短路）只有一份实现，在
 * `worker/modules/idempotency/ledger.ts`；这里只做两件事：
 *   1. 把账本表绑定为 `nav_operations` / `nav_operation_intents`；
 *   2. 把账本通用的 `reason: string` **显式收窄**成 `NavRejection`。
 *
 * 为什么必须收窄而不是断言：账本是被多个域共用的通用机制，它的失败原因是字符串。
 * 若直接 `as NavRejection`，账本将来新增/改名一个原因时，路由层会拿到一个不在
 * `ERROR_CODE_BY_NAV_REJECTION` 里的值并映射成 `undefined` 错误码（不可信的 500），
 * 而不是响亮的失败。用常量集合做运行期校验，未知字符串一律降级为 `persist_failed`。
 *
 * 结构化冲突（ADR-0004 D7）：`revision_conflict` 会**同时**携带 `conflict` 字段
 * （形状 = 共享 `navConflictSchema`，放进 409 的 `details.conflict`）。
 * 只有「针对某一行」的冲突才带它——集合级冲突（重排时的工作空间修订不符）没有
 * 「哪一行、哪个字段」可言，凭空编一个 entityId 就是伪造事实，因此那些冲突只给可读文案。
 */
import type { ApiErrorCode, NavConflict } from '@ff14-hub/shared';
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

// 账本本就与域无关的工具：原样再导出，与工作台保持同一套导入路径与导出名。
export { errorNameOf, fingerprintOf, guardedStatements };
export type { IdempotencyGuard, OperationRow };

/** 导航写入被拒绝的原因（路由层映射成统一错误契约；服务层不关心 HTTP）。 */
export type NavRejection =
  /** 链接不存在，或**不属于**本次认证得到的工作空间（越权不泄露存在性）。 */
  | 'link_not_found'
  /** 分组不存在，或不属于本次认证得到的工作空间。 */
  | 'group_not_found'
  /** 达到单工作空间链接上限（`MAX_NAV_LINKS_PER_WORKSPACE`）。 */
  | 'link_limit_reached'
  /** 达到单工作空间分组上限（`MAX_NAV_GROUPS_PER_WORKSPACE`）。 */
  | 'group_limit_reached'
  /** 单个链接的分组数量超过 `MAX_NAV_GROUPS_PER_LINK`。 */
  | 'too_many_groups_per_link'
  /** 乐观并发失败。**行级**冲突会带结构化 `details.conflict`。 */
  | 'revision_conflict'
  /** 重排给出的 ID 集合与当前活跃集合不一致（整体替换，绝不部分应用）。 */
  | 'reorder_set_mismatch'
  /** 导入预览已过期（工作空间导航修订号已经变化）。 */
  | 'import_preview_stale'
  | 'invalid_input'
  /** URL 不满足 `validateNavUrl`（非 https / 含凭证 / 无 host / 超长）。 */
  | 'invalid_url'
  | 'operation_id_reused'
  /** 同一个 operationId 换了目标/正文：意图变了，必须拒绝且零写入。 */
  | 'operation_payload_mismatch'
  | 'persist_failed';

/**
 * 全部合法拒绝原因的**运行期**清单。
 *
 * `satisfies readonly NavRejection[]` 保证它与联合类型同步：少写一个会在类型检查时报错，
 * 从而让「账本返回的原因能否被映射」永远可判定。
 */
export const NAV_REJECTIONS = [
  'link_not_found',
  'group_not_found',
  'link_limit_reached',
  'group_limit_reached',
  'too_many_groups_per_link',
  'revision_conflict',
  'reorder_set_mismatch',
  'import_preview_stale',
  'invalid_input',
  'invalid_url',
  'operation_id_reused',
  'operation_payload_mismatch',
  'persist_failed',
] as const satisfies readonly NavRejection[];

const NAV_REJECTION_SET: ReadonlySet<string> = new Set<string>(NAV_REJECTIONS);

/** 类型守卫：把一个任意字符串判定为 `NavRejection`（真正的收窄，不做无校验断言）。 */
export function isNavRejection(value: string): value is NavRejection {
  return NAV_REJECTION_SET.has(value);
}

/** 收窄账本原因；未知字符串降级为 `persist_failed`（绝不产出非法错误码）。 */
function narrowRejection(reason: string): NavRejection {
  return isNavRejection(reason) ? reason : 'persist_failed';
}

/** 拒绝原因 → 对外错误码的唯一映射（与 `errors.ts` 的错误码集合保持一致）。 */
export const ERROR_CODE_BY_NAV_REJECTION: Readonly<Record<NavRejection, ApiErrorCode>> = {
  // 越权与「不存在」都返回 404：不泄露某一行是否存在（ADR-0004 D2）。
  link_not_found: 'not_found',
  group_not_found: 'not_found',
  link_limit_reached: 'conflict',
  group_limit_reached: 'conflict',
  too_many_groups_per_link: 'conflict',
  revision_conflict: 'conflict',
  reorder_set_mismatch: 'conflict',
  import_preview_stale: 'conflict',
  invalid_input: 'validation_failed',
  invalid_url: 'validation_failed',
  operation_id_reused: 'conflict',
  operation_payload_mismatch: 'conflict',
  persist_failed: 'internal_error',
};

export interface NavFailure {
  readonly ok: false;
  readonly reason: NavRejection;
  readonly detail: string;
  /**
   * 可安全回显的结构化冲突（仅行级 revision 冲突有值）。
   * 路由层把它放进 `details.conflict`（ADR-0004 D7）：只含实体类型/ID/字段/两个修订号
   * 与处理方式，绝不含凭证、SQL 或内部路径。
   */
  readonly conflict?: NavConflict;
}

export interface NavSuccess<T> {
  readonly ok: true;
  readonly value: T;
  /** true 表示本次是**重放**：直接返回首次结果，没有施加任何副作用。 */
  readonly replayed: boolean;
}

export type NavResult<T> = NavSuccess<T> | NavFailure;

/** 构造一次拒绝。`conflict` 省略时**不产生该键**（保持响应形状最小）。 */
export function navFailure(reason: NavRejection, detail: string, conflict?: NavConflict): NavFailure {
  return conflict === undefined ? { ok: false, reason, detail } : { ok: false, reason, detail, conflict };
}

/** 待执行语句（`guardedStatements` 会统一追加「本次尝试」守卫并放进同一个 batch）。 */
export interface NavStatement {
  readonly sql: string;
  readonly binds: readonly unknown[];
}

/** 账本表绑定：导航与工作台共用同一算法，只换账本表（ADR-0004 D11）。 */
const navLedger = createLedger({
  operations: 'nav_operations',
  intents: 'nav_operation_intents',
});

/** 「本次尝试仍然持有认领」的守卫 SQL 片段（绑定顺序：workspaceId、operationId、token）。 */
export const NAV_GUARD_SQL: string = navLedger.guardSql;

/** 「本次尝试仍然持有认领」的守卫条件。重放（新 token）与抢输（没插进去）都不可能命中。 */
export function idempotencyGuard(input: {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly token: string;
}): IdempotencyGuard {
  return navLedger.idempotencyGuard(input);
}

/**
 * 导航操作的**类别标识**（幂等记录的 `kind`）。
 *
 * 集中定义的原因与工作台一致：类别字符串同时出现在 ①方法入口的幂等短路读取、
 * ②`runOperation` 的认领写入。两处各写一遍字面量就会漂移，漂移的后果是
 * 「重放被误判为 operationId 类别冲突（409）」——而重放恰恰是幂等最该生效的场景。
 */
export const NAV_OP_KINDS = {
  linkCreate: 'nav.link.create',
  linkUpdate: 'nav.link.update',
  linkDelete: 'nav.link.delete',
  linkReorder: 'nav.link.reorder',
  linkSetGroups: 'nav.link.set_groups',
  groupCreate: 'nav.group.create',
  groupUpdate: 'nav.group.update',
  groupDelete: 'nav.group.delete',
  groupReorder: 'nav.group.reorder',
  catalogImport: 'nav.catalog.import',
  importApply: 'nav.import.apply',
} as const;

/** 账本失败 → 导航失败（唯一的收窄点）。 */
function toNavFailure(failure: LedgerFailure): NavFailure {
  return { ok: false, reason: narrowRejection(failure.reason), detail: failure.detail };
}

/** 账本结果 → 导航结果（成功后形状完全一致，直接透传）。 */
function toNavResult<T>(result: LedgerResult<T>): NavResult<T> {
  return result.ok ? result : toNavFailure(result);
}

/**
 * 幂等**短路**：若同一个 operationId 已经成功提交过，直接返回首次结果。
 *
 * 必须在方法入口做：首次提交成功后各写入方法的前置条件（`expectedRevision` /
 * 活跃链接数 / 工作空间修订号）必然已经变化，只依赖认领语句会把「响应丢失后的原样重试」
 * 早退成 409，而幂等恰恰要在那一刻生效。
 */
export async function readNavReplay<T>(input: {
  readonly db: D1Database;
  readonly workspaceId: string;
  readonly operationId: string;
  readonly kind: string;
  /** 本次请求的指纹；与已存指纹不同即「同 ID 换了意图」，拒绝且零写入。 */
  readonly requestFingerprint: string;
}): Promise<NavResult<T> | null> {
  const replay = await navLedger.readReplay<T>(input);
  return replay === null ? null : toNavResult(replay);
}

/** 读取幂等记录（用于判定「重放」与「operationId 类别 / 意图冲突」）。 */
export async function readOperationRow(
  db: D1Database,
  workspaceId: string,
  operationId: string,
): Promise<OperationRow | null> {
  return await navLedger.readOperationRow(db, workspaceId, operationId);
}

export interface NavIdempotentWriteInput<T> {
  readonly db: D1Database;
  readonly workspaceId: string;
  readonly operationId: string;
  readonly kind: string;
  readonly requestFingerprint: string;
  readonly now: number;
  /** 认领语句的前置条件（不含前导 `WHERE`；留空表示「无额外前置条件」）。 */
  readonly preconditionSql: string;
  readonly preconditionBinds: readonly unknown[];
  /**
   * 用「本次尝试」的守卫构造变更语句。守卫里的 `attempt_token` 由账本在认领时生成，
   * 调用方不可能提前知道它，因此只能以回调形式交回给调用方拼 SQL。
   */
  readonly buildStatements: (guard: IdempotencyGuard) => readonly D1PreparedStatement[];
  /** 首次成功时写入并返回的结果；重放时返回首次存入的同一份 JSON。 */
  readonly result: T;
  /** 认领失败且不存在同 operationId 的记录时调用：重新读取状态，给出**精确**的拒绝原因。 */
  readonly explain: () => Promise<NavFailure | null>;
}

/**
 * 执行一次原子幂等写入。
 *
 * 返回 `replayed: true` 表示命中了已存在的同 operationId 且类别/指纹一致——
 * 此时**没有任何语句被执行**（batch 里认领插入 0 行，守卫全部不成立）。
 */
export async function runIdempotentWrite<T>(input: NavIdempotentWriteInput<T>): Promise<NavResult<T>> {
  return toNavResult(await navLedger.runIdempotentWrite<T>(input));
}
