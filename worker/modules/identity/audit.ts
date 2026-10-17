/**
 * 身份审计写入（HUB-006）。
 *
 * 一致性前提：
 * - 这里只构造 **statement**，由调用方放进 `db.batch([...])` 与业务写入同一事务提交，
 *   从而保证「业务写入成功但审计丢失」或反之的情况不会发生
 *   （D1 官方文档：batch 中的语句是一个 SQL 事务，任一条失败即整批回滚）。
 * - `detail_json` 只允许放非敏感事实（原因、区域、设备名等）。
 *   **禁止**放入凭证明文、摘要、配对码或初始化密钥。审计表里的内容是长期保留的。
 */
import type { IdentityAuditEvent } from '@ff14-hub/shared';
import { newId } from '../../lib/util';

export interface AuditInput {
  readonly workspaceId: string;
  readonly eventType: IdentityAuditEvent;
  readonly deviceId: string | null;
  readonly detail?: Readonly<Record<string, unknown>>;
  /** 允许调用方固定时间戳，便于同一批次内保持一致。 */
  readonly at?: number;
}

/** 构造一条审计插入语句（不执行）。 */
export function identityAuditStatement(db: D1Database, input: AuditInput): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO identity_audit (id, workspace_id, event_type, device_id, created_at, detail_json) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(
      newId(),
      input.workspaceId,
      input.eventType,
      input.deviceId,
      input.at ?? Date.now(),
      JSON.stringify(input.detail ?? {}),
    );
}

/** 独立写入一条审计（无其他业务写入需要与之原子时使用）。 */
export async function recordIdentityAudit(db: D1Database, input: AuditInput): Promise<void> {
  await identityAuditStatement(db, input).run();
}
