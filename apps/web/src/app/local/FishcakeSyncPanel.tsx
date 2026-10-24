import {useEffect,useState} from 'react';
import type {FishRegion} from '@ff14-hub/shared';
import type {LocalStore} from './store';
import {applyFishcake,disconnectFishcake,FISHCAKE_SYNC_CHANGED,fishcakeConflictLabel,mergeFishcakePreview,previewFishcake,previewFishcakeRestore,readFishcakeSettings,type FishcakePreview} from './fishcake-sync';

export function FishcakeSyncPanel({store}:{store:LocalStore}){
  const [region,setRegion]=useState<FishRegion>('cn'),[preview,setPreview]=useState<FishcakePreview|null>(null);
  const [choices,setChoices]=useState<Map<string,'local'|'hub'>>(new Map()),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [status,setStatus]=useState<Awaited<ReturnType<typeof readFishcakeSettings>>>(null);
  useEffect(()=>{
    let alive=true;const refresh=()=>{void readFishcakeSettings().then(value=>{if(alive)setStatus(value);}).catch(()=>{});};
    refresh();window.addEventListener(FISHCAKE_SYNC_CHANGED,refresh);return()=>{alive=false;window.removeEventListener(FISHCAKE_SYNC_CHANGED,refresh);};
  },[]);
  const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');try{await action();}catch(cause){setError(cause instanceof Error?cause.message:'互通失败，请重新预览');}finally{setBusy(false);}};
  const merged=preview?mergeFishcakePreview(preview,choices):null;
  const conflicts=preview?mergeFishcakePreview(preview).conflicts:[];
  return <section className="personal-feature" aria-label="鱼糕实时互通">
    <div className="personal-feature__heading"><h3>鱼糕实时互通</h3><span className="personal-feature__badge">钓获 · 收藏 · 提醒</span></div>
    <p>在同一浏览器中自动双向更新，取消标记也会同步。首次核对差异后启用；请保持本站和一个鱼糕页面打开。</p>
    <ol><li>在支持用户脚本的浏览器安装 Tampermonkey 或 Violentmonkey，然后<a href="/fishcake-sync.user.js" target="_blank" rel="noopener noreferrer">安装互通脚本</a>。</li><li><a href="https://fish.ffmomola.com/" target="_blank" rel="noopener noreferrer">打开鱼糕</a>，刷新本站和鱼糕，读取进度并核对。</li></ol>
    <p className="local-settings__caution">手机浏览器需要支持用户脚本。此连接不经过本站服务器；关闭页面后暂停，也不会自动跨设备同步。鱼糕数据没有区服，请确认绑定的区服。</p>
    <label className="local-settings__field">互通区服<select aria-label="鱼糕互通区服" value={region} disabled={busy} onChange={event=>{setRegion(event.target.value as FishRegion);setPreview(null);setChoices(new Map());}}><option value="cn">国服</option><option value="global">国际服</option></select></label>
    <div className="personal-feature__toolbar"><button disabled={busy} onClick={()=>void run(async()=>{setPreview(null);setChoices(new Map());setPreview(await previewFishcake(store,region));})}>读取并预览鱼糕进度</button><button disabled={busy||!status} onClick={()=>void run(async()=>{await disconnectFishcake();setPreview(null);})}>断开互通</button></div>
    {status?<output style={{display:'block'}}>{status.enabled?'自动互通已启用':'自动互通已暂停'} · {status.region==='cn'?'国服':'国际服'}{status.lastSync?` · 上次成功 ${new Date(status.lastSync).toLocaleString('zh-CN')}`:''}</output>:<p>尚未连接</p>}
    {status?.error?<output style={{display:'block'}}>{status.error}</output>:null}
    {status?.backup?<button disabled={busy} onClick={()=>void run(async()=>{setPreview(null);setChoices(new Map());setRegion(status.region);setPreview(await previewFishcakeRestore(store));})}>预览恢复同步前进度</button>:null}
    {preview&&merged?<div className="personal-feature__preview">
      <h4>核对进度</h4><p>鱼糕：{preview.remote.completed.length} 条钓获、{preview.remote.pinned.length} 条收藏、{preview.remote.alarmFish.length} 条提醒。差异 {conflicts.length} 项；应用后会更新两边，写入前将保留同步前快照。</p>
      {preview.restore?<p className="local-settings__caution">正在预览恢复：确认后将用上一次同步前的本站进度替换两边的钓获、收藏和提醒。其他个人数据保持不变。</p>:null}
      {conflicts.length>0?<><div className="personal-feature__toolbar"><button disabled={busy} onClick={()=>setChoices(new Map(conflicts.map(c=>[c.key,'local'])))}>全部差异保留鱼糕</button><button disabled={busy} onClick={()=>setChoices(new Map(conflicts.map(c=>[c.key,'hub'])))}>全部差异保留本站</button></div>
        <details><summary>逐项选择（{conflicts.length}）</summary>{conflicts.map(conflict=><label className="local-settings__field" key={conflict.key}>{fishcakeConflictLabel(conflict)}<select aria-label={fishcakeConflictLabel(conflict)} value={choices.get(conflict.key)??''} disabled={busy} onChange={event=>setChoices(old=>{const next=new Map(old);if(event.target.value)next.set(conflict.key,event.target.value as 'local'|'hub');else next.delete(conflict.key);return next;})}><option value="">请选择</option><option value="local">鱼糕：{conflict.values.local?'已标记':'未标记'}</option><option value="hub">本站：{conflict.values.hub?'已标记':'未标记'}</option></select></label>)}</details></>:<p>没有未解决差异。</p>}
      <p>应用后：{merged.document.completed.length} 条钓获、{merged.document.pinned.length} 条收藏、{merged.document.alarmFish.length} 条提醒。</p>
      <button disabled={busy||merged.conflicts.length>0} onClick={()=>void run(async()=>{await applyFishcake(store,preview,choices);setPreview(null);})}>确认双向同步并启用自动更新</button>
    </div>:null}
    {error?<p role="alert" className="notice notice--error">{error}</p>:null}
  </section>;
}
