import {ApiError} from '@ff14-hub/shared';
export interface ContentState{domain:'navigation'|'calendar';contentId:string;state:'active'|'trash'|'deleted';title:string;revision:number;updatedAt:number}
export async function contentStates(db:D1Database):Promise<ContentState[]>{
  return (await db.prepare('SELECT domain,content_id AS contentId,state,title,revision,updated_at AS updatedAt FROM admin_content_state ORDER BY updated_at DESC').all<ContentState>()).results;
}
export async function excludedContent(db:D1Database,domain:ContentState['domain']){
  return new Set((await db.prepare("SELECT content_id FROM admin_content_state WHERE domain=? AND state<>'active'").bind(domain).all<{content_id:string}>()).results.map(row=>row.content_id));
}
export async function saveContentState(db:D1Database,input:Omit<ContentState,'updatedAt'|'revision'>&{expectedRevision:number;snapshot?:string}){
  const old=await db.prepare('SELECT state FROM admin_content_state WHERE domain=? AND content_id=?').bind(input.domain,input.contentId).first<{state:string}>();
  if(old?.state==='deleted'&&input.state!=='deleted')throw new ApiError('conflict','彻底删除后不能恢复，请重新收录');
  if(input.state==='deleted'&&old?.state!=='trash')throw new ApiError('conflict','请先移入回收站');
  const now=Date.now();
  const snapshot=input.state==='deleted'?null:input.snapshot??null;
  const statement=input.expectedRevision===0?db.prepare('INSERT INTO admin_content_state(domain,content_id,state,title,revision,updated_at,record_payload) VALUES(?,?,?,?,1,?,?) ON CONFLICT DO NOTHING').bind(input.domain,input.contentId,input.state,input.title,now,snapshot):db.prepare("UPDATE admin_content_state SET state=?,title=?,revision=revision+1,updated_at=?,record_payload=CASE WHEN ?='deleted' THEN NULL ELSE COALESCE(?,record_payload) END WHERE domain=? AND content_id=? AND revision=?").bind(input.state,input.title,now,input.state,snapshot,input.domain,input.contentId,input.expectedRevision);
  const result=await statement.run();if(result.meta.changes<1)throw new ApiError('conflict','内容状态已在其他页面更新，请重新读取');
  return {domain:input.domain,contentId:input.contentId,state:input.state,title:input.title,revision:input.expectedRevision+1,updatedAt:now};
}
