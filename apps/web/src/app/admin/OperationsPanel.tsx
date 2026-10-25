
function calendarSnapshotDescription({data}:Readonly<{data:Operations}>){
if(data.calendar){return `${data.calendar.count} 条 · 最近同步 ${new Date(data.calendar.checkedAt).toLocaleString('zh-CN')} · ${data.calendar.stale?'需要更新':'快照有效'}`;}
return '尚无已保存快照';
}
import {useEffect,useState} from 'react';
import {adminRequest} from './ContentLifecycle';
interface Operations{counts:{websites:number;websiteEdits:number;eventEdits:number;trash:number};calendar:{count:number;checkedAt:number;stale:boolean}|null;records:{started_at:number;finished_at:number|null;status:string;item_count:number}[]}
export function OperationsPanel(){const [data,setData]=useState<Operations|null>(null),[error,setError]=useState('');const load=()=>{void adminRequest('operations').then(value=>{setData(value as Operations);setError('');}).catch(()=>setError('运行状态读取失败，请重试'));};useEffect(()=>{void Promise.resolve().then(load);},[]);return <section><h3>内容与同步状态</h3><button type="button" onClick={load}>更新状态</button>{error&&<p role="alert">{error}</p>}{data&&<><p>目录基础条目 {data.counts.websites} · 网站人工维护 {data.counts.websiteEdits} · 活动人工维护 {data.counts.eventEdits} · 回收站 {data.counts.trash}</p><p>官方活动：{calendarSnapshotDescription({data})}</p><p>官方活动按已有请求驱动机制更新；可在国服活动中手动同步。来源解析器和程序依赖仍通过代码发布。</p><h4>最近手动同步</h4><ul>{data.records.map(row=><li key={row.started_at}>{new Date(row.started_at).toLocaleString('zh-CN')} · {{success:'成功',failed:'失败，已保留旧数据',running:'进行中'}[row.status]??row.status} · {row.item_count} 条</li>)}</ul></>}</section>;}
