import {useEffect,useRef,useState} from 'react';
import {ZodError} from 'zod';
import {parseFishDocument,serializeFishDocument,type FishRegion,type FishDocument} from '@ff14-hub/shared';
import {localBackupSchema,type LocalData,type LocalStore,type HomeSection,localLinkSchema} from './store';
import {registerPrivateDraftSource} from '../pwa/draft-registry';

export function downloadJson(text:string,filename:string){
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
const labels:Record<HomeSection,string>={events:'国服活动',fishing:'钓鱼',notes:'我的备忘'};
export function LocalSettings({store,data,onSaved}:{store:LocalStore;data:LocalData;onSaved:()=>void}){
  const [region,setRegion]=useState<FishRegion>(data.configuration.region);
  const [fishFile,setFishFile]=useState<{text:string;document:FishDocument}|null>(null);
  const [preferences,setPreferences]=useState(false);
  const [confirmed,setConfirmed]=useState(false);
  const [backup,setBackup]=useState<ReturnType<typeof localBackupSchema.parse>|null>(null);
  const [restoreConfirmed,setRestoreConfirmed]=useState(false);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [title,setTitle]=useState(''),[url,setUrl]=useState(''),[category,setCategory]=useState('常用网站');
  const [noteTitle,setNoteTitle]=useState(''),[noteText,setNoteText]=useState('');
  const draft=useRef(false);
  useEffect(()=>{draft.current=Boolean(title||url||noteTitle||noteText||fishFile||backup);});
  useEffect(()=>registerPrivateDraftSource(()=>draft.current),[]);
  const run=async(action:()=>Promise<void>)=>{
    if(busy)return;setBusy(true);setError(null);setNotice(null);
    try{await action();onSaved();}catch(cause){setError(cause instanceof ZodError?'文件或输入格式不正确，请检查后重试；原有数据仍保留。':cause instanceof Error?cause.message:'操作失败，原有数据仍保留。');}
    finally{setBusy(false);}
  };
  const move=(section:HomeSection,delta:number)=>{void run(async()=>{
    await store.change(document=>{const order=document.data.configuration.order;const index=order.indexOf(section);const other=order[index+delta];if(other){order[index+delta]=section;order[index]=other;}});
  });};
  return <div className="local-settings">
    <header><h2>个人设置</h2><p>数据保存在当前浏览器。更换设备或清理站点数据前，请先导出备份。</p></header>
    {error?<p role="alert" className="notice notice--error">{error}</p>:null}{notice?<p role="status" className="notice notice--ok">{notice}</p>:null}
    <section><h3>首页模块</h3><p>搜索框固定在最上方，导航站固定在最下方。中间的内容可以调整。</p>
      {data.configuration.order.map((section,index)=><div className="local-settings__module" key={section}>
        <label><input type="checkbox" checked={data.configuration.visible[section]} disabled={busy} onChange={event=>{const checked=event.target.checked;void run(async()=>{await store.change(document=>{document.data.configuration.visible[section]=checked;});});}}/>{labels[section]}</label>
        <div><button type="button" disabled={busy||index===0} aria-label={`上移${labels[section]}`} onClick={()=>move(section,-1)}>上移</button><button type="button" disabled={busy||index===data.configuration.order.length-1} aria-label={`下移${labels[section]}`} onClick={()=>move(section,1)}>下移</button></div>
      </div>)}
      <label className="local-settings__field">默认钓鱼区服<select value={data.configuration.region} disabled={busy} onChange={event=>{const next=event.target.value as FishRegion;void run(async()=>{await store.change(document=>{document.data.configuration.region=next;});});}}><option value="cn">国服</option><option value="global">国际服</option></select></label>
    </section>
    <section aria-label="鱼糕数据导入导出"><h3>鱼糕数据导入 / 导出</h3><p>直接读取 completed、pinned、alarmFish。默认只添加已钓获记录，不清空已有标记。</p>
      <label className="local-settings__field">区服<select aria-label="本地钓鱼导入区服" value={region} disabled={busy} onChange={event=>{setRegion(event.target.value as FishRegion);setConfirmed(false);}}><option value="cn">国服</option><option value="global">国际服</option></select></label>
      <p>鱼糕文件没有区服信息，请核对所选区服。</p>
      <label className="local-settings__field">鱼糕导出文件<input type="file" aria-label="鱼糕导出文件" accept=".json,application/json" disabled={busy} onChange={event=>{
        const file=event.target.files?.[0];setFishFile(null);setConfirmed(false);if(!file)return;
        void run(async()=>{if(file.size>1048576)throw new Error('鱼糕文件超过 1 MiB 上限');const text=await file.text();const document=parseFishDocument(text.replace(/^\uFEFF/,''));setFishFile({text,document});});
      }}/></label>
      {fishFile?<div className="local-settings__preview"><p>已识别 {new Set(fishFile.document.completed).size} 条已钓获、{new Set(fishFile.document.pinned).size} 条收藏、{new Set(fishFile.document.alarmFish).size} 条提醒。</p>
        <label><input type="checkbox" checked={preferences} disabled={busy} onChange={event=>{setPreferences(event.target.checked);setConfirmed(false);}}/>同时合并收藏和提醒（空数组保留现有标记）</label>
        <label><input type="checkbox" aria-label="确认本地导入区服" checked={confirmed} disabled={busy} onChange={event=>setConfirmed(event.target.checked)}/>确认将记录合并到{region==='cn'?'国服':'国际服'}</label>
        <button type="button" disabled={busy||!confirmed} onClick={()=>{void run(async()=>{const count=await store.mergeFish(fishFile.text,region,preferences);setNotice(`已在本机合并 ${count} 项记录。`);setFishFile(null);setConfirmed(false);});}}>导入到本机</button>
      </div>:null}
      <button type="button" disabled={busy} onClick={()=>{void run(async()=>downloadJson(serializeFishDocument(await store.exportFish(region)),`ffmomola-data-export-${region}.json`));}}>导出鱼糕兼容进度</button>
    </section>
    <section aria-label="本地个人备份"><h3>完整个人备份</h3><p>包含两个区服的钓获与收藏、个人导航、首页模块设置和备忘。文件只保存在你选择的位置。</p>
      <button type="button" disabled={busy} onClick={()=>{void run(async()=>downloadJson(JSON.stringify(await store.exportBackup(),null,2),'ff14-hub-personal-backup.json'));}}>导出全部个人数据</button>
      <label className="local-settings__field">选择个人备份<input type="file" aria-label="个人备份文件" accept=".json,application/json" disabled={busy} onChange={event=>{
        const file=event.target.files?.[0];setBackup(null);setRestoreConfirmed(false);if(!file)return;
        void run(async()=>{if(file.size>8*1024*1024)throw new Error('备份超过 8 MiB 上限');const parsed:unknown=JSON.parse((await file.text()).replace(/^\uFEFF/,''));setBackup(localBackupSchema.parse(parsed));});
      }}/></label>
      {backup?<div className="local-settings__preview"><p>备份包含 {backup.data.links.length} 个个人网站、{backup.data.notes.length} 条备忘。恢复会替换本浏览器的个人数据，请先导出当前备份。</p>
        <label><input type="checkbox" checked={restoreConfirmed} onChange={event=>setRestoreConfirmed(event.target.checked)} disabled={busy}/>我已导出当前备份，确认恢复所选个人备份</label>
        <button type="button" disabled={busy||!restoreConfirmed} onClick={()=>{void run(async()=>{await store.restoreBackup(backup);setBackup(null);setNotice('个人备份已恢复到本机。');});}}>恢复个人备份</button>
      </div>:null}
    </section>
    <section><h3>个人导航</h3><form onSubmit={event=>{event.preventDefault();void run(async()=>{
      const link=localLinkSchema.parse({id:crypto.randomUUID(),title:title.trim(),url:url.trim(),category:category.trim()||'常用网站',favorite:false});
      await store.change(document=>{document.data.links.push(link);});setTitle('');setUrl('');
    });}}><label className="local-settings__field">网站名称<input required value={title} onChange={event=>setTitle(event.target.value)} maxLength={100}/></label>
      <label className="local-settings__field">HTTPS 地址<input required type="url" value={url} onChange={event=>setUrl(event.target.value)}/></label>
      <label className="local-settings__field">分类<input value={category} onChange={event=>setCategory(event.target.value)} maxLength={60}/></label><button type="submit" disabled={busy}>添加网站</button></form>
      <ul className="local-settings__items">{data.links.map(link=><li key={link.id}><span>{link.title} <small>{link.category}</small></span><button type="button" aria-label={`移除${link.title}`} disabled={busy} onClick={()=>{void run(async()=>{await store.change(document=>{document.data.links=document.data.links.filter(item=>item.id!==link.id);});});}}>移除</button></li>)}</ul>
    </section>
    <section><h3>自定义备忘模块</h3><form onSubmit={event=>{event.preventDefault();void run(async()=>{
      await store.change(document=>{document.data.notes.push({id:crypto.randomUUID(),title:noteTitle.trim(),text:noteText});document.data.configuration.visible.notes=true;});setNoteTitle('');setNoteText('');
    });}}><label className="local-settings__field">标题<input value={noteTitle} onChange={event=>setNoteTitle(event.target.value)} maxLength={100} required/></label>
      <label className="local-settings__field">内容<textarea value={noteText} onChange={event=>setNoteText(event.target.value)} maxLength={10000} rows={3}/></label><button type="submit" disabled={busy}>添加备忘模块</button></form>
      <ul className="local-settings__items">{data.notes.map(note=><li key={note.id}><span>{note.title}</span><button type="button" disabled={busy} onClick={()=>{void run(async()=>{await store.change(document=>{document.data.notes=document.data.notes.filter(item=>item.id!==note.id);});});}}>移除</button></li>)}</ul>
    </section>
  </div>;
}
