import { ApiError,SYNC_MODULE_ID,fishSyncSnapshotSchema,fishSyncPreviewInputSchema,fishSyncPreviewSchema,
  type FishSyncSnapshot,type FishSyncPreview,type FishRegion } from '@ff14-hub/shared';
import { createLedger,fingerprintOf } from '../idempotency/ledger';
import { requireFishing } from '../fish/service';
import { readModuleGateStatus } from '../lifecycle/workspace-modules';
import { MODULE_GATE_SQL } from '../reminders/rules';
const ledger=createLedger({
  guardSql:'EXISTS(SELECT 1 FROM fish_sync_operations WHERE workspace_id=? AND operation_id=? AND attempt_token=?)',
  readRowSql:`SELECT o.kind,o.result_json,o.attempt_token,COALESCE(i.request_fingerprint,'') AS request_fingerprint FROM fish_sync_operations o
    LEFT JOIN fish_sync_operation_intents i ON i.workspace_id=o.workspace_id AND i.operation_id=o.operation_id WHERE o.workspace_id=? AND o.operation_id=?`,
  claimPrefix:"INSERT INTO fish_sync_operations(workspace_id,operation_id,kind,result_json,created_at,attempt_token) SELECT ?,?,?,'',?,? WHERE (",
  claimSuffix:') ON CONFLICT(workspace_id,operation_id) DO NOTHING',
  claimIntentPrefix:'INSERT INTO fish_sync_operation_intents(workspace_id,operation_id,kind,request_fingerprint,created_at) SELECT ?,?,?,?,? WHERE ',
  finalizeSql:'UPDATE fish_sync_operations SET result_json=?,attempt_token=NULL WHERE workspace_id=? AND operation_id=? AND attempt_token=?',
});
const ALL_FIELDS='(SELECT * FROM fish_state_fields UNION ALL SELECT * FROM fish_external_fields)';
export async function requireSync(db:D1Database,workspace:string):Promise<void>{
  await requireFishing(db,workspace);
  if((await readModuleGateStatus(db,workspace,SYNC_MODULE_ID)).status!=='enabled')throw new ApiError('forbidden','请先启用数据同步模块');
}
export async function syncSnapshot(db:D1Database,workspace:string,region:FishRegion):Promise<FishSyncSnapshot>{
  await requireSync(db,workspace);
  const rows=await db.batch<Record<string,unknown>>([
    db.prepare(`SELECT fish_id AS fishId,field,value,revision FROM ${ALL_FIELDS} WHERE workspace_id=? AND region=? ORDER BY fish_id,field LIMIT 15001`).bind(workspace,region),
    db.prepare('SELECT COALESCE(MAX(seq),0) AS watermark FROM fish_progress_changes WHERE workspace_id=? AND region=?').bind(workspace,region),
    db.prepare('SELECT MAX(created_at) AS lastSyncedAt FROM fish_sync_audit WHERE workspace_id=? AND region=?').bind(workspace,region),
    db.prepare('SELECT id,created_at AS createdAt,json_array_length(changes_json) AS applied FROM fish_sync_audit WHERE workspace_id=? AND region=? ORDER BY created_at DESC,id LIMIT 20').bind(workspace,region),
  ]);
  if((rows[0]?.results.length??0)>15000)throw new ApiError('validation_failed','字段数量超过同步上限');
  return fishSyncSnapshotSchema.parse({region,fields:(rows[0]?.results??[]).map((r)=>({...r,value:r['value']===1})),
    watermark:rows[1]?.results[0]?.['watermark']??0,lastSyncedAt:rows[2]?.results[0]?.['lastSyncedAt']??null,audits:rows[3]?.results??[]});
}
export async function previewSync(db:D1Database,workspace:string,raw:unknown):Promise<FishSyncPreview>{
  const input=fishSyncPreviewInputSchema.parse(raw);const snapshot=await syncSnapshot(db,workspace,input.region);
  const existing=new Map(snapshot.fields.map((f)=>[`${String(f.fishId)}:${f.field}`,f]));
  for(const change of input.changes)if((existing.get(`${String(change.fishId)}:${change.field}`)?.revision??0)!==change.expectedRevision)
    throw new ApiError('conflict','字段修订号已变化，请重新预览');
  const backup=input.changes.map((change)=>({...change,value:existing.get(`${String(change.fishId)}:${change.field}`)?.value??false,
    expectedRevision:change.expectedRevision+1}));
  const token=crypto.randomUUID();const expiresAt=Date.now()+600_000;
  await db.prepare(`INSERT INTO fish_sync_previews(token,workspace_id,region,base_watermark,payload_json,payload_hash,backup_json,expires_at)
    SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM fish_sync_previews WHERE workspace_id=? AND consumed_at IS NULL AND expires_at>?)<30`)
    .bind(token,workspace,input.region,snapshot.watermark,JSON.stringify(input.changes),await fingerprintOf('fish-sync.payload',input),JSON.stringify(backup),expiresAt,workspace,Date.now()).run();
  const result=await db.prepare('SELECT token FROM fish_sync_previews WHERE token=? AND workspace_id=?').bind(token,workspace).first();
  if(result===null)throw new ApiError('rate_limited','待确认预览达到上限，请稍后再试');
  return fishSyncPreviewSchema.parse({token,region:input.region,watermark:snapshot.watermark,changes:input.changes,backup,expiresAt});
}
interface PreviewRow{region:FishRegion;base_watermark:number;payload_json:string;payload_hash:string;backup_json:string;expires_at:number;consumed_at:number|null}
export async function applySync(db:D1Database,workspace:string,deviceId:string,input:{token:string;operationId:string}){
  await requireSync(db,workspace);
  const meta={db,workspaceId:workspace,operationId:input.operationId,kind:'fish-sync.apply',requestFingerprint:await fingerprintOf('fish-sync.apply',input)};
  const replay=await ledger.readReplay<{auditId:string;applied:number}>(meta);if(replay!==null)return replay;
  const preview=await db.prepare('SELECT * FROM fish_sync_previews WHERE workspace_id=? AND token=?').bind(workspace,input.token).first<PreviewRow>();
  if(preview===null)throw new ApiError('not_found','预览不存在');
  const parsed=fishSyncPreviewInputSchema.parse({region:preview.region,changes:JSON.parse(preview.payload_json) as unknown});
  if(await fingerprintOf('fish-sync.payload',parsed)!==preview.payload_hash)throw new ApiError('internal_error','预览记录校验失败');
  const now=Date.now();const auditId=crypto.randomUUID();
  return ledger.runIdempotentWrite({...meta,now,
    preconditionSql:`EXISTS(SELECT 1 FROM fish_sync_previews WHERE token=? AND workspace_id=? AND consumed_at IS NULL AND expires_at>? AND payload_hash=?)
      AND COALESCE((SELECT MAX(seq) FROM fish_progress_changes WHERE workspace_id=? AND region=?),0)=?
      AND ${MODULE_GATE_SQL} AND ${MODULE_GATE_SQL} AND EXISTS(SELECT 1 FROM devices WHERE workspace_id=? AND id=? AND revoked_at IS NULL)
      AND (SELECT COUNT(*) FROM ${ALL_FIELDS} WHERE workspace_id=? AND region=?) +
        (SELECT COUNT(*) FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM ${ALL_FIELDS} f WHERE f.workspace_id=? AND f.region=?
          AND f.fish_id=json_extract(j.value,'$.fishId') AND f.field=json_extract(j.value,'$.field')))<=15000`,
    preconditionBinds:[input.token,workspace,now,preview.payload_hash,workspace,preview.region,preview.base_watermark,
      workspace,SYNC_MODULE_ID,workspace,'ff14.fishing',workspace,deviceId,workspace,preview.region,preview.payload_json,workspace,preview.region],
    buildStatements:(guard)=>[
      db.prepare(`INSERT INTO fish_state_fields(workspace_id,region,fish_id,field,value,revision,updated_at)
        SELECT ?,?,json_extract(j.value,'$.fishId'),json_extract(j.value,'$.field'),json_extract(j.value,'$.value'),json_extract(j.value,'$.expectedRevision')+1,?
        FROM json_each(?) j JOIN fish_catalog f ON f.region=? AND f.fish_id=json_extract(j.value,'$.fishId') WHERE ${guard.sql}
        ON CONFLICT(workspace_id,region,fish_id,field) DO UPDATE SET value=excluded.value,revision=excluded.revision,updated_at=excluded.updated_at`)
        .bind(workspace,preview.region,now,preview.payload_json,preview.region,...guard.binds),
      db.prepare(`INSERT INTO fish_external_fields(workspace_id,region,fish_id,field,value,revision,updated_at)
        SELECT ?,?,json_extract(j.value,'$.fishId'),json_extract(j.value,'$.field'),json_extract(j.value,'$.value'),json_extract(j.value,'$.expectedRevision')+1,?
        FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM fish_catalog f WHERE f.region=? AND f.fish_id=json_extract(j.value,'$.fishId')) AND ${guard.sql}
        ON CONFLICT(workspace_id,region,fish_id,field) DO UPDATE SET value=excluded.value,revision=excluded.revision,updated_at=excluded.updated_at`)
        .bind(workspace,preview.region,now,preview.payload_json,preview.region,...guard.binds),
      db.prepare(`UPDATE fish_sync_previews SET consumed_at=? WHERE token=? AND workspace_id=? AND ${guard.sql}`).bind(now,input.token,workspace,...guard.binds),
      db.prepare(`INSERT INTO fish_sync_audit(id,workspace_id,region,operation_id,changes_json,backup_json,created_at) SELECT ?,?,?,?,?,?,? WHERE ${guard.sql}`)
        .bind(auditId,workspace,preview.region,input.operationId,preview.payload_json,preview.backup_json,now,...guard.binds),
    ],result:{auditId,applied:parsed.changes.length},explain:()=>Promise.resolve({ok:false,reason:'sync_conflict',detail:'预览已过期/已使用、数据或模块状态已变化，请重新预览'}),
  });
}
export async function rollbackPreview(db:D1Database,workspace:string,auditId:string):Promise<FishSyncPreview>{
  await requireSync(db,workspace);
  const audit=await db.prepare('SELECT region,backup_json FROM fish_sync_audit WHERE workspace_id=? AND id=?').bind(workspace,auditId).first<{region:FishRegion;backup_json:string}>();
  if(audit===null)throw new ApiError('not_found','同步记录不存在');
  const changes:unknown=JSON.parse(audit.backup_json);
  return previewSync(db,workspace,{region:audit.region,changes});
}
