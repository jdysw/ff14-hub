import {useEffect,useState} from 'react';
import {usePrivateDraft} from '../pwa/draft-registry';
import {type LocalStore} from './store';
import {readRemoteSession,saveRemoteConfig,setRemoteAutomatic,previewRemoteSync,applyRemotePreview,restoreRemoteBackup,REMOTE_SYNC_CHANGED,type RemoteSyncSession,type RemoteSyncPreview} from './remote-sync-session';
import {automaticSyncStatus,AUTO_SYNC_STATUS,type AutoSyncStatus} from './automatic-sync';
import {createRemoteClient,emptyRemoteConfig,mergePersonalData,remoteConfigSchema,remoteFailureMessage,type RemoteConfig} from './remote-sync';

type Saved=RemoteSyncSession;
type Preview=RemoteSyncPreview;
function syncStage(same:boolean,preview:boolean,previousSync:boolean){
  if(!same){
    return {step:1,description:'先保存当前设备的连接配置。'};
  }
  if(preview){
    return {step:3,description:'读取成功，请核对差异；读取成功不代表已验证写入权限。'};
  }
  if(previousSync){
    return {step:4,description:'此设备已有同步记录。再次同步时先读取远端，检查是否有新的差异。'};
  }
  return {step:2,description:'配置已保存在本机，尚未确认远端是否可读。下一步只读取，不写入远端。'};
}

function RemotePreview({preview,merged,choices,busy,onChoice,onApply}:Readonly<{
  preview:Preview;merged:ReturnType<typeof mergePersonalData>;choices:Record<string,'local'|'remote'>;
  busy:boolean;onChoice:(key:string,value:'local'|'remote')=>void;onApply:()=>void;
}>){
  return <div className="personal-feature__preview">
    <h4>同步预览</h4><p>{preview.remote?'已读取远端备份':'远端文件不存在，将创建新备份'}。合并后 {merged.data.links.length} 个网站、{merged.data.notes.length} 条备忘、{merged.data.fish.cn.length+merged.data.fish.global.length} 项钓鱼标记。</p>
    {merged.conflicts.length>0?<p>有 {merged.conflicts.length} 项冲突，请逐项选择；取消标记和删除也会参与比较。</p>:<p>没有未解决冲突，可以应用同步。</p>}
    {merged.conflicts.map(conflict=><div className="local-settings__field" key={conflict.key}>
      <label>{conflict.label}<select value={choices[conflict.key]??''} onChange={event=>onChoice(conflict.key,event.target.value as 'local'|'remote')}><option value="">请选择保留哪一份</option><option value="local">保留本机{conflict.local===undefined?'的删除操作':''}</option><option value="remote">保留远端{conflict.remote===undefined?'的删除操作':''}</option></select></label>
      <details><summary>查看两边内容</summary>
        <label>本机内容<textarea readOnly rows={5} value={conflict.local===undefined?'已删除':JSON.stringify(conflict.local,null,2)} style={{width:'100%',maxWidth:'100%'}}/></label>
        <label>远端内容<textarea readOnly rows={5} value={conflict.remote===undefined?'已删除':JSON.stringify(conflict.remote,null,2)} style={{width:'100%',maxWidth:'100%'}}/></label>
      </details>
    </div>)}
    <button disabled={busy||merged.conflicts.length>0} onClick={onApply}>应用双向同步</button>
  </div>;
}

function AutomaticSyncControls({saved,same,ready,busy,status,onChange}:Readonly<{
  saved:Saved|null;same:boolean;ready:boolean;busy:boolean;status:AutoSyncStatus;onChange:(enabled:boolean)=>void;
}>){
  const enabled=saved?.automatic??false;
  const canEnable=Boolean(saved?.lastSync&&saved.baseline&&!saved.needsReview);
  return <section aria-label="自动同步" className="sync-diagnostic">
    <label><input type="checkbox" checked={enabled} disabled={busy||!same||!ready||(!enabled&&!canEnable)} onChange={event=>onChange(event.target.checked)}/>开启跨设备自动同步</label>
    <p>连接同一个云端文件的设备会在页面运行期间自动交换修改。打开页面、恢复联网和本机修改后检查，正常每 30 秒检查一次；关闭浏览器后暂停。</p>
    {!saved?.lastSync?<p>先读取远端并确认一次双向同步，再开启自动同步。</p>:null}
    {enabled?<output aria-live="polite" style={{display:'block'}}>{saved?.needsReview?'自动同步已暂停，请读取远端预览并确认差异':status.message}{status.checkedAt?' · 最近检查 '+new Date(status.checkedAt).toLocaleTimeString('zh-CN'):''}</output>:null}
    {enabled&&status.kind==='retry'&&!saved?.needsReview?<button disabled={busy} onClick={()=>window.dispatchEvent(new Event(REMOTE_SYNC_CHANGED))}>立即重试自动同步</button>:null}
  </section>;
}

export function RemoteSyncPanel({store}:Readonly<{store:LocalStore}>){
  const [config,setConfig]=useState<RemoteConfig>(emptyRemoteConfig),[saved,setSaved]=useState<Saved|null>(null);
  const [preview,setPreview]=useState<Preview|null>(null),[choices,setChoices]=useState<Record<string,'local'|'remote'>>({});
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(''),[ready,setReady]=useState(false);
  const [autoStatus,setAutoStatus]=useState(automaticSyncStatus);
  useEffect(()=>{
    let alive=true,initialized=false;
    const refresh=()=>{void readRemoteSession().then(value=>{if(alive){setSaved(value);if(!initialized){if(value)setConfig(value.config);initialized=true;}setReady(true);}}).catch(()=>{if(alive){setError('本机同步配置无法读取，请重新保存配置');setReady(true);}});};
    const status=()=>setAutoStatus(automaticSyncStatus());
    refresh();window.addEventListener(REMOTE_SYNC_CHANGED,refresh);window.addEventListener(AUTO_SYNC_STATUS,status);
    return()=>{alive=false;window.removeEventListener(REMOTE_SYNC_CHANGED,refresh);window.removeEventListener(AUTO_SYNC_STATUS,status);};
  },[]);
  const run=async(action:()=>Promise<void>)=>{if(busy){return;}setBusy(true);setError('');setMessage('');try{await action();}catch(cause){setError(remoteFailureMessage(cause));}finally{setBusy(false);}};
  const field=(key:keyof RemoteConfig,value:string)=>{setConfig(old=>({...old,[key]:value}));setPreview(null);setChoices({});};
  const same=saved&&JSON.stringify(config)===JSON.stringify(saved.config);
  usePrivateDraft(busy||Boolean(!same&&(config.url||config.username||config.password||config.accessKey||config.secretKey||config.sessionToken)));
  const merged=preview?mergePersonalData(saved?.baseline??null,preview.local,preview.remote,choices):null;
  const stage=syncStage(Boolean(same),preview!==null,Boolean(saved?.lastSync));
  return <section className="personal-feature" aria-label="云端同步">
    <div className="personal-feature__heading"><h3>云端同步</h3><span className="personal-feature__badge">WebDAV / S3</span></div>
    <p>在设备间同步收藏、自定义导航、备忘、首页设置和钓鱼进度。凭证在本机加密保存，不会传给本站服务器，也不包含在个人备份中。</p>
    <ol className="sync-steps" aria-label="同步连接步骤">{['保存连接配置','检查连接并读取','核对差异','确认应用'].map((label,index)=><li key={label} aria-current={stage.step===index+1?'step':undefined}>{index+1}. {label}</li>)}</ol>
    <p className="sync-diagnostic">{stage.description}</p>
    <form onSubmit={event=>{event.preventDefault();void run(async()=>{
      const parsed=remoteConfigSchema.parse(config);createRemoteClient(parsed);
      const next=await saveRemoteConfig(parsed);setSaved(next);setPreview(null);setMessage('同步配置已加密保存在本机');
    });}}>
      <div className="personal-feature__fields">
        <label className="local-settings__field">同步方式<select value={config.provider} disabled={busy} onChange={event=>field('provider',event.target.value)}><option value="webdav">WebDAV</option><option value="s3">S3 兼容存储</option></select></label>
        <label className="local-settings__field">完整文件地址<input required type="url" value={config.url} disabled={busy} placeholder={config.provider==='webdav'?'https://dav.example.com/ff14/personal.json':'https://bucket.s3.region.amazonaws.com/ff14/personal.json'} onChange={event=>field('url',event.target.value)}/></label>
        {config.provider==='webdav'?<>
          <label className="local-settings__field">WebDAV 用户名<input autoComplete="off" value={config.username} disabled={busy} onChange={event=>field('username',event.target.value)}/></label>
          <label className="local-settings__field">WebDAV 密码 / 应用口令<input type="password" autoComplete="new-password" value={config.password} disabled={busy} onChange={event=>field('password',event.target.value)}/></label>
        </>:<>
          <label className="local-settings__field">S3 Region<input required value={config.region} disabled={busy} onChange={event=>field('region',event.target.value)}/><small>例如 ap-northeast-1；R2 通常为 auto。可使用虚拟主机或路径形式的完整对象地址。</small></label>
          <label className="local-settings__field">Access Key ID<input required autoComplete="off" value={config.accessKey} disabled={busy} onChange={event=>field('accessKey',event.target.value)}/></label>
          <label className="local-settings__field">Secret Access Key<input required type="password" autoComplete="new-password" value={config.secretKey} disabled={busy} onChange={event=>field('secretKey',event.target.value)}/></label>
          <label className="local-settings__field">Session Token（可选）<input type="password" autoComplete="new-password" value={config.sessionToken} disabled={busy} onChange={event=>field('sessionToken',event.target.value)}/></label>
        </>}
      </div>
      <button type="submit" disabled={!ready||busy}>保存同步配置</button>
    </form>
    <details className="personal-feature__help"><summary>首次连接与跨域配置</summary><p>先创建父目录或存储桶，文件名建议 personal.json。服务需允许本站 Origin 的 GET、PUT、OPTIONS 请求，允许 Authorization、Content-Type、If-Match、If-None-Match；S3 另需允许 x-amz-* 请求头，并暴露 ETag。必须支持条件写，建议为存储桶开启版本历史。</p><p>远端文件包含个人备忘等内容，请使用私有目录或存储桶。更换设备后需重新填写连接配置；WebDAV 鱼糕原始文件应使用独立文件名，避免覆盖。</p></details>
    <div className="personal-feature__toolbar">
      <button disabled={busy||!same||!ready} onClick={()=>void run(async()=>{setPreview(null);setChoices({});const result=await previewRemoteSync(store,config);setPreview(result);setMessage(result.remote?'连接成功，文件格式和强 ETag 检查通过，尚未写入。':'远端返回文件不存在，尚未写入；确认应用时才会尝试创建并验证条件写入。');})}>读取远端并预览</button>
      {saved?.lastSync?<span>上次同步 {new Date(saved.lastSync).toLocaleString('zh-CN')}</span>:<span>尚未同步</span>}
    </div>
    <AutomaticSyncControls saved={saved} same={Boolean(same)} ready={ready} busy={busy} status={autoStatus}
      onChange={enabled=>{void run(async()=>{setSaved(await setRemoteAutomatic(enabled));setMessage(enabled?'自动同步已开启':'自动同步已关闭，资料仍保留在本机');});}}/>
    {preview&&merged?<RemotePreview preview={preview} merged={merged} choices={choices} busy={busy}
      onChoice={(key,value)=>setChoices(old=>({...old,[key]:value}))}
      onApply={()=>void run(async()=>{
        const next=await applyRemotePreview(store,preview,choices);setSaved(next);setPreview(null);setMessage('双向同步完成，已保留本次同步前的本机快照');
      })}/>:null}
    {saved?.backup?<button disabled={busy} onClick={()=>{if(window.confirm('恢复上一次同步前的本机数据？远端文件不会改变。'))void run(async()=>{await restoreRemoteBackup(store);setMessage('已恢复上一次同步前的本机数据，请重新预览再同步');setPreview(null);});}}>恢复同步前的本机快照</button>:null}
    {message?<output className="notice notice--ok" style={{display:'block'}}>{message}</output>:null}{error?<p role="alert" className="notice notice--error">{error}</p>:null}
  </section>;
}
