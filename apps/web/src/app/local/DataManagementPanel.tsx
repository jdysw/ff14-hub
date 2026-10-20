import {useState} from 'react';
import {ZodError} from 'zod';
import {parseFishDocument,serializeFishDocument,type FishRegion,type FishDocument} from '@ff14-hub/shared';
import {localBackupSchema,type LocalData,type LocalStore} from './store';
import {usePrivateDraft} from '../pwa/draft-registry';
import {RemoteSyncPanel} from './RemoteSyncPanel';

export type DataSection='sync'|'fish'|'backup';
function downloadJson(text:string,filename:string){
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function DataManagementPanel({store,data,initialSection='sync'}:{store:LocalStore;data:LocalData;initialSection?:DataSection}){
  const [section,setSection]=useState<DataSection>(initialSection);
  const [region,setRegion]=useState<FishRegion>(data.configuration.region);
  const [fishFile,setFishFile]=useState<{text:string;document:FishDocument}|null>(null);
  const [preferences,setPreferences]=useState(false),[confirmed,setConfirmed]=useState(false);
  const [backup,setBackup]=useState<ReturnType<typeof localBackupSchema.parse>|null>(null);
  const [restoreConfirmed,setRestoreConfirmed]=useState(false),[busy,setBusy]=useState(false);
  const [notice,setNotice]=useState<string|null>(null),[error,setError]=useState<string|null>(null);
  usePrivateDraft(Boolean(fishFile||backup||busy));
  const run=async(action:()=>Promise<void>)=>{
    if(busy)return;setBusy(true);setError(null);setNotice(null);
    try{await action();}catch(cause){setError(cause instanceof ZodError?'文件格式不正确，原有数据仍保留。':cause instanceof Error?cause.message:'操作失败，原有数据仍保留。');}
    finally{setBusy(false);}
  };
  return <section className="data-management" aria-label="数据管理">
    <header className="data-management__header"><h3>数据管理</h3><p>在设备间同步个人资料，导入钓鱼进度，或通过文件备份和恢复。</p></header>
    <nav className="data-management__tabs" aria-label="数据管理方式">
      {([['sync','云端同步'],['fish','钓鱼导入导出'],['backup','备份与恢复']] as const).map(([value,label])=><button key={value} type="button" aria-pressed={section===value} onClick={()=>setSection(value)}>{label}</button>)}
    </nav>
    {error?<p role="alert" className="notice notice--error">{error}</p>:null}{notice?<p role="status" className="notice notice--ok">{notice}</p>:null}
    <div hidden={section!=='sync'}><RemoteSyncPanel store={store}/></div>
    <section hidden={section!=='fish'} aria-label="鱼糕数据导入导出"><h3>鱼糕数据</h3>
      <label className="local-settings__field">区服<select aria-label="本地钓鱼导入区服" value={region} disabled={busy} onChange={event=>{setRegion(event.target.value as FishRegion);setConfirmed(false);}}><option value="cn">国服</option><option value="global">国际服</option></select></label>
      <p className="local-settings__caution">鱼糕文件不包含区服信息，请确认所选区服。</p>
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
    <section hidden={section!=='backup'} aria-label="本地个人备份"><h3>备份与恢复</h3><p className="local-settings__caution">数据存于当前浏览器。更换设备或清理站点数据前请导出备份。</p>
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
  </section>;
}
