/**
 * 幂等账本的**单一实现**（HUB-048 / HUB-051；ADR-0004 D11）。
 *
 * 为什么把算法提取到独立模块（而不是每个域各写一份）：
 * 工作台（阶段 03）与导航（阶段 04）需要的是**同一个**机制——
 * 「认领 + attempt_token 守卫 + 请求指纹 + 原子 batch + 重放短路」。
 * 第二份实现迟早会与第一份漂移（守卫绑定顺序、指纹判定、回滚语义每一处都是坑），
 * 而漂移在这类代码里的表现是「重放重复施加副作用」或「并发双写」——最不该出错的地方。
 * 因此这里只保留一份实现，两个域各自绑定自己的账本表。
 *
 * 为什么账本表分域、算法却只有一份：每个域的 `kind` 命名空间不同
 * （`page.update` 与 `nav.link.update`），混在一张表里会让
 * 「同一 operationId 换了意图」的判定跨域误伤。因此每个域有**自己的**账本表，
 * 但**算法只有这一份**：SQL 以字面量提供（见 `LedgerSql` 与三个 `*_LEDGER_SQL`），
 * 编排逻辑（认领 → 变更 → 收尾、重放短路、指纹比对、失败解释）全部共用。
 *
 * 为什么 SQL 是字面量而不是把表名拼进去（复核修正）：把**标识符**拼进 SQL 会让整条语句
 * 变成"动态构造的 SQL"，安全静态分析会把它标成需要人工复核的注入风险点；
 * 而表名本来就不可能参数化，所以正确做法就是每个域写自己的字面量 SQL。
 *
 * 一次幂等写入由三部分组成，必须在**同一个 D1 batch（同一个事务）**里完成：
 *   1. **认领**：`INSERT INTO <operations> ... SELECT ... WHERE <全部前置条件>
 *      ON CONFLICT (workspace_id, operation_id) DO NOTHING`；
 *   2. **变更**：若干条写入语句；
 *   3. **收尾**：把真实结果写回 `result_json` 并清空 `attempt_token`。
 *
 * 每条变更语句都带同一个守卫：
 *   `EXISTS (SELECT 1 FROM <operations> g
 *             WHERE g.workspace_id = ? AND g.operation_id = ? AND g.attempt_token = ?)`
 *
 * 这个守卫同时解决两个问题，且都不依赖「读-判-写」之间的时间窗：
 * - **并发/抢输**：另一个请求先插入了同一 operationId（token 不同）→ 本次认领插入 0 行
 *   （`ON CONFLICT DO NOTHING`）→ 守卫查不到自己的 token → **它的全部语句同样不生效**。
 * - **重放**：客户端用同一个 operationId 重试时，服务端生成**新的随机 token**，
 *   它永远不会等于已存行的 token（已存行在收尾时已置空）→ 变更语句同样不生效，
 *   直接返回首次的结果（`replayed: true`）。
 *
 * 为什么不用 `changes() = 1` 链：链式 `changes()` 只反映**紧邻的上一条语句**，
 * 而真实域里有大量「可能影响 0 行」的语句（清掉旧默认页、删除不存在的布局行）。
 * 一旦中间某条影响 0 行，后续语句就会被误跳过。token 守卫与行数无关，因此更稳。
 *
 * 失败回滚：D1 的 `batch()` 是单个事务；任意一条语句违反约束（唯一/FK/CHECK）都会
 * 让**整个 batch** 回滚（含认领行与指纹行），因此不会留下半完成状态。
 * 收尾语句必须影响 1 行；否则事务虽已提交，也必须如实报告 `persist_failed`
 * （而不是返回一个不可信的成功）。
 *
 * 指纹判定的两条边界（`fingerprintMatches`）：空指纹表示「本迁移之前写入的旧行」——
 * 既不当作匹配，也不当作冲突的强证据，而是保守拒绝并要求客户端换一个新的
 * operationId 重试。类别 / 指纹不一致分别返回 `operation_id_reused` /
 * `operation_payload_mismatch`，两者都是**零写入**。
 */
import { stableStringify } from '../../lib/util';

/**
 * 账本的两张表名。
 *
 * 工作台绑定 `workbench_operations` / `workbench_operation_intents`；
 * 导航绑定 `nav_operations` / `nav_operation_intents`。算法与语义完全一致。
 */
/**
 * 一个域的账本 SQL（**全部是字面量**）。
 *
 * 为什么把 SQL 拆成字面量而不是把表名当参数插进去（复核修正）：
 * 用 `${tables.operations}` 这样的模板把**标识符**拼进 SQL，会让整条语句变成"动态构造的 SQL"——
 * 安全静态分析（SonarCloud）会把它标成需要人工复核的注入风险点，而这类风险点会让质量门失败。
 * 表名本来就不可能参数化（SQLite 不支持参数化标识符），因此正确做法是：每个域写**自己的字面量**，
 * 算法仍然只有一份（`createLedger`），只是 SQL 文本由调用方以字面量提供。
 *
 * 认领语句被拆成「前置条件之前 / 之后」两段：中间夹的是**域提供的 SQL 条件片段**
 * （例如「页面属于本工作空间且 revision 匹配」），它是代码常量而非用户输入——
 * 真正来自用户的值一律走绑定参数。
 */
export interface LedgerSql {
  /** 守卫片段：`EXISTS (SELECT 1 FROM <本域 operations> ... )`，绑定顺序 workspaceId、operationId、token。 */
  readonly guardSql: string;
  /** 读取幂等记录（结果 + 指纹）。绑定顺序：workspaceId、operationId。 */
  readonly readRowSql: string;
  /** 认领语句的前半段（到前置条件前的 `WHERE (` 为止）。 */
  readonly claimPrefix: string;
  /** 认领语句的后半段（闭合前置条件的 `)` 之后的部分）。 */
  readonly claimSuffix: string;
  /** 指纹插入语句（到 `WHERE ` 为止，之后追加守卫片段）。 */
  readonly claimIntentPrefix: string;
  /** 收尾：写回结果并清空本次 token。 */
  readonly finalizeSql: string;
}

/** 工作台账本（`workbench_operations`）。 */
export const WORKBENCH_LEDGER_SQL: LedgerSql = {
  guardSql: `EXISTS (SELECT 1 FROM workbench_operations g
                     WHERE g.workspace_id = ? AND g.operation_id = ? AND g.attempt_token = ?)`,
  readRowSql: `SELECT o.kind, o.result_json, o.attempt_token,
                      COALESCE(i.request_fingerprint, '') AS request_fingerprint
                 FROM workbench_operations o
                 LEFT JOIN workbench_operation_intents i
                        ON i.workspace_id = o.workspace_id AND i.operation_id = o.operation_id
                WHERE o.workspace_id = ? AND o.operation_id = ?`,
  claimPrefix: `INSERT INTO workbench_operations
                        (workspace_id, operation_id, kind, result_json, created_at, attempt_token)
                 SELECT ?, ?, ?, '', ?, ?
                  WHERE (`,
  claimSuffix: `) ON CONFLICT (workspace_id, operation_id) DO NOTHING`,
  claimIntentPrefix: `INSERT INTO workbench_operation_intents
                              (workspace_id, operation_id, kind, request_fingerprint, created_at)
                       SELECT ?, ?, ?, ?, ?
                        WHERE `,
  finalizeSql: `UPDATE workbench_operations SET result_json = ?, attempt_token = NULL
                 WHERE workspace_id = ? AND operation_id = ? AND attempt_token = ?`,
};

/** 导航账本（`nav_operations`）。 */
export const NAV_LEDGER_SQL: LedgerSql = {
  guardSql: `EXISTS (SELECT 1 FROM nav_operations g
                     WHERE g.workspace_id = ? AND g.operation_id = ? AND g.attempt_token = ?)`,
  readRowSql: `SELECT o.kind, o.result_json, o.attempt_token,
                      COALESCE(i.request_fingerprint, '') AS request_fingerprint
                 FROM nav_operations o
                 LEFT JOIN nav_operation_intents i
                        ON i.workspace_id = o.workspace_id AND i.operation_id = o.operation_id
                WHERE o.workspace_id = ? AND o.operation_id = ?`,
  claimPrefix: `INSERT INTO nav_operations
                        (workspace_id, operation_id, kind, result_json, created_at, attempt_token)
                 SELECT ?, ?, ?, '', ?, ?
                  WHERE (`,
  claimSuffix: `) ON CONFLICT (workspace_id, operation_id) DO NOTHING`,
  claimIntentPrefix: `INSERT INTO nav_operation_intents
                              (workspace_id, operation_id, kind, request_fingerprint, created_at)
                       SELECT ?, ?, ?, ?, ?
                        WHERE `,
  finalizeSql: `UPDATE nav_operations SET result_json = ?, attempt_token = NULL
                 WHERE workspace_id = ? AND operation_id = ? AND attempt_token = ?`,
};

/** 活动账本（`event_operations`）。 */
export const EVENT_LEDGER_SQL: LedgerSql = {
  guardSql: `EXISTS (SELECT 1 FROM event_operations g
                     WHERE g.workspace_id = ? AND g.operation_id = ? AND g.attempt_token = ?)`,
  readRowSql: `SELECT o.kind, o.result_json, o.attempt_token,
                      COALESCE(i.request_fingerprint, '') AS request_fingerprint
                 FROM event_operations o
                 LEFT JOIN event_operation_intents i
                        ON i.workspace_id = o.workspace_id AND i.operation_id = o.operation_id
                WHERE o.workspace_id = ? AND o.operation_id = ?`,
  claimPrefix: `INSERT INTO event_operations
                        (workspace_id, operation_id, kind, result_json, created_at, attempt_token)
                 SELECT ?, ?, ?, '', ?, ?
                  WHERE (`,
  claimSuffix: `) ON CONFLICT (workspace_id, operation_id) DO NOTHING`,
  claimIntentPrefix: `INSERT INTO event_operation_intents
                              (workspace_id, operation_id, kind, request_fingerprint, created_at)
                       SELECT ?, ?, ?, ?, ?
                        WHERE `,
  finalizeSql: `UPDATE event_operations SET result_json = ?, attempt_token = NULL
                 WHERE workspace_id = ? AND operation_id = ? AND attempt_token = ?`,
};

/** 账本写入被拒绝的原因。域层（如工作台）负责把它收窄成自己的枚举。 */
export interface LedgerFailure {
  readonly ok: false;
  readonly reason: string;
  readonly detail: string;
}

export interface LedgerSuccess<T> {
  readonly ok: true;
  readonly value: T;
  /** true 表示本次是**重放**：直接返回首次结果，没有施加任何副作用。 */
  readonly replayed: boolean;
}

export type LedgerResult<T> = LedgerSuccess<T> | LedgerFailure;

/** 守卫 SQL 片段与它的绑定值。拼接时必须原样追加到语句的 WHERE 条件之后。 */
export interface IdempotencyGuard {
  readonly sql: string;
  readonly binds: readonly string[];
}

/**
 * 幂等记录的读取形状。
 *
 * `request_fingerprint` 通过 LEFT JOIN 指纹表取得；早期（无指纹）的行
 * `COALESCE` 成空串，由 `fingerprintMatches` 保守处理。
 */
export interface OperationRow {
  readonly kind: string;
  readonly result_json: string;
  readonly attempt_token: string | null;
  readonly request_fingerprint: string;
}

export interface LedgerWriteInput<T> {
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
   * 之所以是回调而不是现成数组：守卫里的 `attempt_token` 由本模块在认领时生成，
   * 调用方不可能提前知道它。把 token 交给调用方拼 SQL 是唯一不会写错顺序的做法。
   */
  readonly buildStatements: (guard: IdempotencyGuard) => readonly D1PreparedStatement[];
  /** 首次成功时写入并返回的结果；重放时返回首次存入的同一份 JSON。 */
  readonly result: T;
  /**
   * 认领失败且不存在同 operationId 的记录时调用：重新读取状态，给出**精确**的拒绝原因。
   * 返回 null 表示无法解释（按 `persist_failed` 处理，不猜）。
   */
  readonly explain: () => Promise<LedgerFailure | null>;
}

/**
 * 一个域绑定到自己的账本表之后的幂等接口。
 *
 * 两个域（工作台 / 导航）拿到的是**同一个**算法，只是表名不同。
 */
export interface Ledger {
  /** 该账本表绑定的守卫 SQL 片段（绑定顺序：workspaceId、operationId、token）。 */
  readonly guardSql: string;
  /** 「本次尝试仍然持有认领」的守卫条件。 */
  idempotencyGuard(input: {
    readonly workspaceId: string;
    readonly operationId: string;
    readonly token: string;
  }): IdempotencyGuard;
  /**
   * 幂等**短路**：若同一个 operationId 已经成功提交过，直接返回首次结果；
   * 无记录返回 null（继续走正常写入路径）；类别 / 指纹冲突返回精确失败。
   */
  readReplay<T>(input: {
    readonly db: D1Database;
    readonly workspaceId: string;
    readonly operationId: string;
    readonly kind: string;
    /** 本次请求的指纹；与已存指纹不同即「同 ID 换了意图」，拒绝且零写入。 */
    readonly requestFingerprint: string;
  }): Promise<LedgerResult<T> | null>;
  /** 读取幂等记录（用于判定「重放」与「operationId 类别 / 意图冲突」）。 */
  readOperationRow(db: D1Database, workspaceId: string, operationId: string): Promise<OperationRow | null>;
  /** 执行一次原子幂等写入。 */
  runIdempotentWrite<T>(input: LedgerWriteInput<T>): Promise<LedgerResult<T>>;
  /** 把若干语句合成一组 batch 语句，并统一追加「本次尝试」守卫。 */
  guardedStatements(
    db: D1Database,
    guard: IdempotencyGuard,
    statements: readonly { readonly sql: string; readonly binds: readonly unknown[] }[],
  ): D1PreparedStatement[];
}

/**
 * 指纹比对。
 *
 * 空字符串表示「本迁移之前写入的旧行，没有指纹」：这时**不**当成匹配，
 * 也不当成冲突的强证据——保守做法是要求客户端换一个新的 operationId 重试
 * （旧行本来也没有可用的首次结果可以复用，因为它可能来自不同实现）。
 */
function fingerprintMatches(stored: string, provided: string): boolean {
  return stored.length > 0 && stored === provided;
}

/**
 * 计算一次「意图」的**请求指纹**。
 *
 * 为什么必须把意图绑进幂等键：只按 `(workspace, operationId, kind)` 判定重放是不够的——
 * 同一个 `kind` 可以指向不同目标（`page.update` 对 A 页 / B 页）、
 * `layout.save` 的 kind 只有断点（不含 page）、同一个 operationId 换一份 body
 * 也会被当成重放。指纹覆盖「目标 ID + 动作 + 正文 + 预期 revision + 断点」，因此：
 * 完全相同的请求 → 返回首次结果；指纹不同 → 拒绝且**零写入**。
 *
 * 刻意使用 SHA-256（而不是自定义哈希）：这只是去重指纹、不含秘密，
 * 但用标准摘要可以避免「弱哈希被误用于安全目的」这类隐患，也让跨进程结果必然一致。
 */
export async function fingerprintOf(kind: string, payload: unknown): Promise<string> {
  const canonical = `${kind}\u0000${stableStringify(payload)}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 错误名（把错误对象降级成可安全回显的一小段文本，绝不回显堆栈）。 */
export function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * 把若干语句合成一组 batch 语句，并统一追加「本次尝试」守卫。
 * 之所以集中在这里：守卫的绑定顺序很容易写错，集中一处可被测试覆盖。
 *
 * 顺序是「语句自己的绑定在前、守卫绑定在后」——调用方的 SQL 里
 * 先出现自己的占位符，再出现追加的 `EXISTS (...)`，两者必须一致。
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

/** 绑定一个域自己的账本 SQL（字面量），返回该域的幂等接口。 */
export function createLedger(sql: LedgerSql): Ledger {
  const { guardSql, readRowSql, claimPrefix, claimSuffix, claimIntentPrefix, finalizeSql } = sql;

  /**
   * 「本次尝试仍然持有认领」的守卫条件。
   * 只比对 `attempt_token`，因此重放（新 token）与抢输（没插进去）都不可能命中。
   */
  function idempotencyGuard(input: {
    readonly workspaceId: string;
    readonly operationId: string;
    readonly token: string;
  }): IdempotencyGuard {
    return {
      sql: guardSql,
      binds: [input.workspaceId, input.operationId, input.token],
    };
  }

  /**
   * 读取幂等记录（用于判定「重放」与「operationId 类别 / 意图冲突」）。
   *
   * 指纹单独一张表（见迁移 0007 / 0008 的文件头说明：迁移必须可重放，
   * 因此不能给既有表加列）。早期版本写入的行没有指纹 → COALESCE 成空串，
   * 域层按「无法判定」保守处理。
   */
  async function readOperationRow(
    db: D1Database,
    workspaceId: string,
    operationId: string,
  ): Promise<OperationRow | null> {
    return await db.prepare(readRowSql).bind(workspaceId, operationId).first<OperationRow>();
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
  async function readReplay<T>(input: {
    readonly db: D1Database;
    readonly workspaceId: string;
    readonly operationId: string;
    readonly kind: string;
    readonly requestFingerprint: string;
  }): Promise<LedgerResult<T> | null> {
    const existing = await readOperationRow(input.db, input.workspaceId, input.operationId);
    if (existing === null) {
      return null;
    }
    if (existing.kind !== input.kind) {
      return {
        ok: false,
        reason: 'operation_id_reused',
        detail: `operationId 已用于 ${existing.kind} 操作`,
      };
    }
    if (!fingerprintMatches(existing.request_fingerprint, input.requestFingerprint)) {
      return {
        ok: false,
        reason: 'operation_payload_mismatch',
        detail: '同一 operationId 的请求内容与首次不同，已拒绝（零写入）',
      };
    }
    if (existing.attempt_token !== null) {
      // batch 是原子的，因此外部不应观测到未收尾的行；观测到就如实报告，不猜结果。
      return { ok: false, reason: 'persist_failed', detail: '存在未收尾的幂等记录' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing.result_json);
    } catch {
      return { ok: false, reason: 'persist_failed', detail: '幂等记录已损坏' };
    }
    return { ok: true, value: parsed as T, replayed: true };
  }

  /**
   * 执行一次原子幂等写入。
   *
   * 返回 `replayed: true` 表示命中了已存在的同 operationId 且类别/指纹一致——
   * 此时**没有任何语句被执行**（batch 里认领插入 0 行，守卫全部不成立）。
   */
  async function runIdempotentWrite<T>(input: LedgerWriteInput<T>): Promise<LedgerResult<T>> {
    const token = crypto.randomUUID();
    const resultJson = JSON.stringify(input.result);

    const claim = input.db
      .prepare(`${claimPrefix}${input.preconditionSql === '' ? '1 = 1' : input.preconditionSql}${claimSuffix}`)
      .bind(input.workspaceId, input.operationId, input.kind, input.now, token, ...input.preconditionBinds);

    // 指纹与认领**同批写入**（守卫绑定到本次 token）：
    // 抢输/重放时守卫不成立，因此这一条不会覆盖已有指纹，也不会在重放时被重复插入。
    const claimIntent = input.db
      .prepare(`${claimIntentPrefix}${guardSql}`)
      .bind(
        input.workspaceId,
        input.operationId,
        input.kind,
        input.requestFingerprint,
        input.now,
        input.workspaceId,
        input.operationId,
        token,
      );

    const finalize = input.db
      .prepare(finalizeSql)
      .bind(resultJson, input.workspaceId, input.operationId, token);

    let batchResults: D1Result[];
    try {
      batchResults = await input.db.batch([
        claim,
        claimIntent,
        ...input.buildStatements({ sql: guardSql, binds: [input.workspaceId, input.operationId, token] }),
        finalize,
      ]);
    } catch (error) {
      // 约束冲突等：整个 batch 已回滚，什么都没提交。如实报告，绝不假装成功。
      return { ok: false, reason: 'persist_failed', detail: `写入事务失败：${errorNameOf(error)}` };
    }

    const claimed = (batchResults[0]?.meta.changes ?? 0) === 1;
    if (claimed) {
      // 收尾必须成功更新 1 行；否则说明守卫/语句构造有误，属于内部不一致。
      const finalized = batchResults[batchResults.length - 1]?.meta.changes ?? 0;
      if (finalized !== 1) {
        // 事务已提交，无法回滚；但必须让调用方知道结果不可信，而不是返回成功。
        return { ok: false, reason: 'persist_failed', detail: '幂等收尾未生效（内部不一致）' };
      }
      return { ok: true, value: input.result, replayed: false };
    }

    // 认领失败：重放（同类别同指纹）或类别/意图冲突，或前置条件不满足。
    const existing = await readOperationRow(input.db, input.workspaceId, input.operationId);
    if (existing !== null) {
      if (existing.kind !== input.kind) {
        return {
          ok: false,
          reason: 'operation_id_reused',
          detail: `operationId 已用于 ${existing.kind} 操作`,
        };
      }
      // 与入口短路同一条判据：同一 ID 换了意图必须拒绝，绝不当成重放返回旧结果。
      if (!fingerprintMatches(existing.request_fingerprint, input.requestFingerprint)) {
        return {
          ok: false,
          reason: 'operation_payload_mismatch',
          detail: '同一 operationId 的请求内容与首次不同，已拒绝（零写入）',
        };
      }
      if (existing.attempt_token !== null) {
        // 事务是原子的，因此外部不应观测到未收尾的行。真观测到了就如实报告，不猜结果。
        return { ok: false, reason: 'persist_failed', detail: '存在未收尾的幂等记录' };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(existing.result_json);
      } catch {
        return { ok: false, reason: 'persist_failed', detail: '幂等记录已损坏' };
      }
      return { ok: true, value: parsed as T, replayed: true };
    }

    const explained = await input.explain();
    return explained ?? { ok: false, reason: 'persist_failed', detail: '认领失败且无法解释' };
  }

  return {
    guardSql,
    idempotencyGuard,
    readReplay,
    readOperationRow,
    runIdempotentWrite,
    guardedStatements,
  };
}
