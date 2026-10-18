import { ApiError, FISH_MODULE_ID, fishRecordSchema, fishProgressSchema, type FishProgressWrite, type FishRegion } from '@ff14-hub/shared';
import { createLedger, fingerprintOf } from '../idempotency/ledger';
import { readModuleGateStatus } from '../lifecycle/workspace-modules';

const ledger = createLedger({
  guardSql:'EXISTS (SELECT 1 FROM fish_operations WHERE workspace_id=? AND operation_id=? AND attempt_token=?)',
  readRowSql:`SELECT o.kind,o.result_json,o.attempt_token,COALESCE(i.request_fingerprint,'') AS request_fingerprint
    FROM fish_operations o LEFT JOIN fish_operation_intents i ON i.workspace_id=o.workspace_id AND i.operation_id=o.operation_id
    WHERE o.workspace_id=? AND o.operation_id=?`,
  claimPrefix:"INSERT INTO fish_operations(workspace_id,operation_id,kind,result_json,created_at,attempt_token) SELECT ?,?,?,'',?,? WHERE (",
  claimSuffix:') ON CONFLICT(workspace_id,operation_id) DO NOTHING',
  claimIntentPrefix:'INSERT INTO fish_operation_intents(workspace_id,operation_id,kind,request_fingerprint,created_at) SELECT ?,?,?,?,? WHERE ',
  finalizeSql:'UPDATE fish_operations SET result_json=?,attempt_token=NULL WHERE workspace_id=? AND operation_id=? AND attempt_token=?',
});

export async function requireFishing(db: D1Database, workspaceId: string): Promise<void> {
  if ((await readModuleGateStatus(db,workspaceId,FISH_MODULE_ID)).status !== 'enabled') {
    throw new ApiError('forbidden','请先启用钓鱼手账模块','fishing_disabled');
  }
}
export async function readFish(db: D1Database, region: FishRegion) {
  const rows = await db.prepare('SELECT record_json FROM fish_catalog WHERE region=? ORDER BY fish_id LIMIT 5001').bind(region)
    .all<{record_json:string}>();
  if (rows.results.length > 5000) throw new ApiError('validation_failed','鱼类目录超出读取上限');
  return rows.results.map((row) => fishRecordSchema.parse(JSON.parse(row.record_json) as unknown));
}
export async function readProgress(db: D1Database, workspaceId: string, region: FishRegion) {
  await requireFishing(db,workspaceId);
  const results = await db.batch<Record<string,unknown>>([
    db.prepare('SELECT region,fish_id AS fishId,field,value,revision,updated_at AS updatedAt FROM fish_state_fields WHERE workspace_id=? AND region=? ORDER BY fish_id,field LIMIT 15001').bind(workspaceId,region),
    db.prepare('SELECT COALESCE(MAX(seq),0) AS watermark FROM fish_progress_changes WHERE workspace_id=? AND region=?').bind(workspaceId,region),
  ]);
  if ((results[0]?.results.length ?? 0) > 15000) throw new ApiError('validation_failed','进度数据超出读取上限');
  return { fields:(results[0]?.results ?? []).map((row) => fishProgressSchema.parse({...row,value:row['value'] === 1})),
    watermark:Number(results[1]?.results[0]?.['watermark'] ?? 0) };
}
export async function writeProgress(db: D1Database, workspaceId: string, input: FishProgressWrite) {
  await requireFishing(db,workspaceId);
  const kind = 'fish.field';
  const requestFingerprint = await fingerprintOf(kind,input);
  const meta = {db,workspaceId,operationId:input.operationId,kind,requestFingerprint};
  const replay = await ledger.readReplay(meta);
  if (replay !== null) return replay;
  const now = Date.now();
  const ids = [workspaceId,input.region,input.fishId,input.field];
  const gateSql = `EXISTS(SELECT 1 FROM workspace_modules m WHERE m.workspace_id=? AND m.module_id='ff14.fishing' AND m.status='enabled'
    AND NOT EXISTS(SELECT 1 FROM workspace_module_operations o WHERE o.workspace_id=m.workspace_id AND o.module_id=m.module_id))`;
  // CAS, module gate and identity existence are rechecked inside the atomic claim.
  return ledger.runIdempotentWrite({...meta,now,
    preconditionSql:`EXISTS(SELECT 1 FROM fish_catalog WHERE region=? AND fish_id=?) AND ${gateSql}
      AND COALESCE((SELECT revision FROM fish_state_fields WHERE workspace_id=? AND region=? AND fish_id=? AND field=?),0)=?`,
    preconditionBinds:[input.region,input.fishId,workspaceId,...ids,input.expectedRevision],
    buildStatements:(guard) => [db.prepare(`INSERT INTO fish_state_fields(workspace_id,region,fish_id,field,value,revision,updated_at)
      SELECT ?,?,?,?,?,?,? WHERE ${guard.sql}
      ON CONFLICT(workspace_id,region,fish_id,field) DO UPDATE SET value=excluded.value,revision=excluded.revision,updated_at=excluded.updated_at`)
      .bind(...ids,input.value?1:0,input.expectedRevision+1,now,...guard.binds)],
    result:{region:input.region,fishId:input.fishId,field:input.field,value:input.value,revision:input.expectedRevision+1,updatedAt:now},
    explain:async () => {
      const exists = await db.prepare('SELECT 1 AS yes FROM fish_catalog WHERE region=? AND fish_id=?').bind(input.region,input.fishId).first();
      return {ok:false,reason:exists === null?'fish_not_found':'revision_conflict',detail:exists === null?'该区服没有此鱼类':'进度已变化，请重新载入后重试'};
    },
  });
}
