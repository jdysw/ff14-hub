import { useCallback, useEffect, useRef, useState } from 'react';
import { directoryAdminResponseSchema, directoryItemSchema, directoryRecordSchema, matchesDirectorySearch, type DirectoryItem, type DirectoryRecord } from '@ff14-hub/shared';
import { calendarAdminSession } from '../events/calendar-admin-session';

const blank = (): DirectoryItem => ({title:'',url:'https://',description:'',category:'常用工具',tags:[],aliases:[],icon:'🔗',openMode:'new_tab',region:'cn',sortOrder:100});
const REGION = {cn:'国服',global:'国际服',both:'通用'};
const BASE='/api/v1/admin/navigation/items';

async function request(path:string,method='GET',body?:unknown):Promise<unknown> {
  const token=calendarAdminSession.get();
  if(!token)throw new Error('管理员会话已结束，请重新登录');
  const response=await fetch(path,{method,credentials:'omit',cache:'no-store',redirect:'error',
    headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{})});
  const result:unknown=await response.json();
  if(!response.ok){
    if(response.status===401)calendarAdminSession.clear();
    const parsed=typeof result==='object'&&result!==null&&'error' in result?result.error:null;
    const message=typeof parsed==='object'&&parsed!==null&&'message' in parsed&&typeof parsed.message==='string'?parsed.message:'保存失败，请重试';
    throw new Error(message);
  }
  return result;
}

export function SiteDirectoryPanel(){
  const [records,setRecords]=useState<DirectoryRecord[]>([]);
  const [loaded,setLoaded]=useState(false);
  const [busy,setBusy]=useState(false);
  const [draft,setDraft]=useState<{id:string|null;revision:number;item:DirectoryItem}|null>(null);
  const [search,setSearch]=useState('');
  const [status,setStatus]=useState('all');
  const [error,setError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const [confirm,setConfirm]=useState<string|null>(null);
  const [tagsText,setTagsText]=useState('');
  const [aliasesText,setAliasesText]=useState('');
  const alertRef=useRef<HTMLParagraphElement>(null);
  useEffect(()=>{if(error)alertRef.current?.focus();},[error]);
  const load=useCallback(async()=>{
    const result=directoryAdminResponseSchema.parse(await request(BASE));
    setRecords(result.records);setLoaded(true);
  },[]);
  useEffect(()=>{let alive=true;void request(BASE).then(value=>{if(alive){setRecords(directoryAdminResponseSchema.parse(value).records);setLoaded(true);}}).catch((cause:unknown)=>{if(alive)setError(cause instanceof Error?cause.message:'加载网站失败');});return()=>{alive=false;};},[]);
  const run=async(action:()=>Promise<void>)=>{
    setBusy(true);setError(null);setNotice(null);
    try{await action();}catch(cause){setError(cause instanceof Error?cause.message:'操作失败，草稿仍保留');}finally{setBusy(false);}
  };
  const accepted=(record:DirectoryRecord)=>{
    setRecords(current=>[...current.filter(old=>old.entry.id!==record.entry.id),record].sort((a,b)=>a.entry.sortOrder-b.entry.sortOrder||a.entry.id.localeCompare(b.entry.id)));
    window.dispatchEvent(new Event('ff14hub:directory-changed'));
  };
  const toggle=(record:DirectoryRecord,hide:boolean)=>run(async()=>{
    accepted(directoryRecordSchema.parse(await request(`${BASE}/${encodeURIComponent(record.entry.id)}/${hide?'hide':'restore'}`,'POST',{expectedRevision:record.revision})));
    setConfirm(null);setNotice(hide?'网站已下架并保存到服务器；已有个人收藏仍保留。':'网站已恢复并保存到服务器。');
  });
  const filtered=records.filter(record=>(status==='all'||record.hidden===(status==='hidden'))&&matchesDirectorySearch(record.entry,search));
  const update=<K extends keyof DirectoryItem>(key:K,value:DirectoryItem[K])=>setDraft(current=>current?{...current,item:{...current.item,[key]:value}}:null);
  return <section className="directory-admin" aria-label="网站目录管理">
    <header><h3>网站目录管理</h3><p>管理全站推荐网站。保存直接同步到服务器；玩家自己的导航和收藏保存在各自浏览器。</p></header>
    <div className="site-admin__actions">
      <button type="button" className="button" disabled={busy||draft!==null||!loaded} onClick={()=>{setDraft({id:null,revision:0,item:blank()});setTagsText('');setAliasesText('');setError(null);setNotice(null);}}>新增网站</button>
      <button type="button" className="button button--secondary" disabled={busy} onClick={()=>void run(async()=>{await load();setNotice(draft?'已重新读取列表；草稿已保留。请取消编辑后打开最新版本再保存。':'网站列表已更新。');})}>重新读取列表</button>
      <span>{records.filter(record=>!record.hidden).length} 个展示中 · {records.filter(record=>record.hidden).length} 个已下架</span>
    </div>
    {error?<p ref={alertRef} tabIndex={-1} role="alert" className="notice notice--error">{error}</p>:null}
    {notice?<p role="status" className="notice notice--ok">{notice}</p>:null}
    {!loaded&&!error?<p role="status">正在读取网站目录…</p>:null}
    {draft?<form className="directory-admin__form" aria-label={draft.id?'编辑网站':'新增网站'} onSubmit={event=>{event.preventDefault();void run(async()=>{
      const split=(text:string)=>[...new Set(text.split(/[,，]/).map(value=>value.trim()).filter(Boolean))];
      const parsed=directoryItemSchema.safeParse({...draft.item,tags:split(tagsText),aliases:split(aliasesText)});
      if(!parsed.success)throw new Error(parsed.error.issues.map(issue=>`${issue.path.join('.')}: ${issue.message}`).join('；'));
      const result=directoryRecordSchema.parse(await request(draft.id?`${BASE}/${encodeURIComponent(draft.id)}`:BASE,draft.id?'PUT':'POST',{expectedRevision:draft.revision,item:parsed.data}));
      accepted(result);setDraft(null);setNotice('网站已保存到服务器，公开目录已同步。');
    });}}>
      <h4>{draft.id?'编辑网站':'新增网站'}</h4>
      <fieldset disabled={busy}>
        <label>网站名称<input required maxLength={80} value={draft.item.title} onChange={event=>update('title',event.target.value)}/></label>
        <label>HTTPS 地址<input required type="url" maxLength={2048} value={draft.item.url} onChange={event=>update('url',event.target.value)}/></label>
        <label>分类<input required list="directory-categories" maxLength={40} value={draft.item.category} onChange={event=>update('category',event.target.value)}/></label>
        <datalist id="directory-categories">{[...new Set(records.map(record=>record.entry.category))].map(category=><option key={category} value={category}/>)}</datalist>
        <label>适用区服<select value={draft.item.region} onChange={event=>update('region',event.target.value as DirectoryItem['region'])}><option value="cn">国服</option><option value="global">国际服</option><option value="both">通用</option></select></label>
        <label className="directory-admin__wide">简介<textarea maxLength={500} rows={2} value={draft.item.description} onChange={event=>update('description',event.target.value)}/></label>
        <label>标签（逗号分隔）<input value={tagsText} onChange={event=>setTagsText(event.target.value)}/></label>
        <label>搜索别名（逗号分隔）<input value={aliasesText} onChange={event=>setAliasesText(event.target.value)}/></label>
        <label>排序（小的在前）<input type="number" required value={draft.item.sortOrder} onChange={event=>update('sortOrder',Number(event.target.value))}/></label>
      </fieldset>
      <div className="site-admin__actions"><button className="button" disabled={busy} type="submit">{busy?'正在保存…':'保存到服务器'}</button><button className="button button--secondary" disabled={busy} type="button" onClick={()=>setDraft(null)}>取消编辑</button></div>
    </form>:null}
    <div className="directory-admin__filters"><label>搜索网站<input type="search" value={search} onChange={event=>setSearch(event.target.value)}/></label><label>展示状态<select value={status} onChange={event=>setStatus(event.target.value)}><option value="all">全部状态</option><option value="active">展示中</option><option value="hidden">已下架</option></select></label><span>{filtered.length} 个匹配</span></div>
    <ul className="directory-admin__list">{filtered.map(record=><li key={record.entry.id}>
      <div><strong>{record.entry.title}</strong> <small>{record.hidden?'已下架':'展示中'} · {REGION[record.entry.region]} · {record.entry.category}</small><a href={record.entry.url} target="_blank" rel="noopener noreferrer">{record.entry.url}</a><small>来源：<a href={record.entry.sourceUrl} target="_blank" rel="noopener noreferrer">{record.entry.sourceName}</a> · 内容核对 {new Date(record.entry.verifiedAt).toISOString().slice(0,10)}（不代表实时在线）</small></div>
      <div className="site-admin__actions"><button className="button button--secondary" disabled={busy||draft!==null} onClick={()=>{setDraft({id:record.entry.id,revision:record.revision,item:directoryItemSchema.strip().parse(record.entry)});setTagsText(record.entry.tags.join(','));setAliasesText(record.entry.aliases.join(','));setError(null);}}>编辑 {record.entry.title}</button><button className="button button--secondary" disabled={busy||draft!==null} onClick={()=>record.hidden?void toggle(record,false):setConfirm(record.entry.id)}>{record.hidden?'恢复':'下架'} {record.entry.title}</button></div>
      {confirm===record.entry.id?<div className="directory-admin__confirm" role="alertdialog" aria-label={`确认下架 ${record.entry.title}`}><p>确认从公共目录下架“{record.entry.title}”？之后可恢复。</p><button className="button" disabled={busy} onClick={()=>void toggle(record,true)}>确认下架</button><button className="button button--secondary" disabled={busy} onClick={()=>setConfirm(null)}>取消下架</button></div>:null}
    </li>)}</ul>
    {loaded&&filtered.length===0?<p>没有匹配的网站，请调整搜索或状态筛选。</p>:null}
  </section>;
}
