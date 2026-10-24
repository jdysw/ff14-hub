import {useCallback,useEffect,useState} from 'react';
import {calendarAdminSession} from '../events/calendar-admin-session';
export interface ContentState{domain:'navigation'|'calendar';contentId:string;state:'active'|'trash'|'deleted';title:string;revision:number;updatedAt:number}
export async function adminRequest(path:string,method='GET',body?:unknown):Promise<unknown>{
  const token=calendarAdminSession.get();if(!token)throw new Error('管理员会话已失效');
  const response=await fetch('/api/v1/admin/'+path,{method,credentials:'omit',cache:'no-store',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  if(!response.ok){
    const messages:Record<number,string>={409:'内容已更新，请重新读取后重试',401:'管理员会话已失效'};
    throw new Error(messages[response.status]??'操作失败，请重试');
  }
  return response.json();
}
export function useContentState(){
  const [records,setRecords]=useState<ContentState[]>([]),[error,setError]=useState('');
  const reload=useCallback(async()=>{try{const result=await adminRequest('content-state') as {records:ContentState[]};setRecords(result.records);setError('');}catch(cause){setError(cause instanceof Error?cause.message:'读取失败');}},[]);
  useEffect(()=>{const refresh=()=>{void reload();};void Promise.resolve().then(refresh);window.addEventListener('ff14hub:content-state',refresh);return()=>window.removeEventListener('ff14hub:content-state',refresh);},[reload]);
  const change=async(domain:ContentState['domain'],id:string,state:ContentState['state'])=>{
    const old=records.find(record=>record.domain===domain&&record.contentId===id);
    const updated=await adminRequest('content-state','PUT',{domain,contentId:id,state,expectedRevision:old?.revision??0}) as ContentState;
    setRecords(current=>[...current.filter(row=>row.domain!==domain||row.contentId!==id),updated]);
    window.dispatchEvent(new Event('ff14hub:content-state'));window.dispatchEvent(new Event('ff14hub:directory-changed'));window.dispatchEvent(new Event('ff14hub:admin-calendar-changed'));
  };
  return {records,error,reload,change,excluded:(domain:ContentState['domain'],id:string)=>records.some(row=>row.domain===domain&&row.contentId===id&&row.state!=='active')};
}
export function RecyclePanel(){
  const content=useContentState(),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const act=async(record:ContentState,state:'active'|'deleted')=>{if(state==='deleted'&&!window.confirm(`彻底删除“${record.title}”？之后不能从回收站恢复；来源屏蔽标记和操作记录会保留。`))return;
    setBusy(true);try{await content.change(record.domain,record.contentId,state);setMessage(state==='active'?'已恢复，原来的隐藏状态保持不变':'已彻底删除，并保留防止来源重新收录的标记');}catch(error){setMessage(error instanceof Error?error.message:'操作失败');}finally{setBusy(false);}};
  return <section><h3>回收站与操作记录</h3><p>删除会进入回收站；彻底删除后保留来源屏蔽标记，自动同步不会重新带回。</p>{content.error&&<p role="alert">{content.error}</p>}{message&&<output style={{display:'block'}}>{message}</output>}<button type="button" onClick={()=>void content.reload()}>重新读取</button>
    <ul className="directory-admin__list">{content.records.filter(row=>row.state==='trash').map(row=><li key={row.domain+row.contentId}><div><strong>{row.title}</strong><small>{row.domain==='navigation'?'网站':'活动'} · {new Date(row.updatedAt).toLocaleString('zh-CN')}</small></div><div className="site-admin__actions"><button type="button" disabled={busy} onClick={()=>void act(row,'active')}>恢复</button><button type="button" disabled={busy} onClick={()=>void act(row,'deleted')}>彻底删除</button></div></li>)}</ul>
    {!content.records.some(row=>row.state==='trash')&&<p>回收站为空。</p>}<AuditList/>
  </section>;
}
function AuditList(){const [rows,setRows]=useState<{domain:string;content_id:string;state:string;title:string;updated_at:number;revision:number}[]>([]),[error,setError]=useState('');return <details><summary onClick={()=>{void adminRequest('content-audit').then(value=>setRows((value as {records:typeof rows}).records)).catch(()=>setError('操作记录读取失败'));}}>最近操作记录</summary>{error&&<p role="alert">{error}</p>}<ul>{rows.map((row,i)=><li key={i}>{row.title} · {{active:'恢复',trash:'移入回收站',deleted:'彻底删除'}[row.state]} · 版本 {row.revision} · {new Date(row.updated_at).toLocaleString('zh-CN')}</li>)}</ul></details>;}
