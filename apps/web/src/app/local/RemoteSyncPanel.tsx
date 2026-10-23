import {useEffect,useState} from 'react';
import {usePrivateDraft} from '../pwa/draft-registry';
import {type LocalStore,type LocalData,localDataSchema} from './store';
import {readDeviceRecord,writeDeviceRecord} from './secure-storage';
import {applyPersonalSync,createRemoteClient,emptyRemoteConfig,mergePersonalData,remoteConfigSchema,remoteUrl,remoteFailureMessage,type RemoteConfig} from './remote-sync';

interface Saved{config:RemoteConfig;baseline:LocalData|null;lastSync?:string;backup?:LocalData}
interface Preview{local:LocalData;remote:LocalData|null;etag:string|null}
export function RemoteSyncPanel({store}:{store:LocalStore}){
  const [config,setConfig]=useState<RemoteConfig>(emptyRemoteConfig),[saved,setSaved]=useState<Saved|null>(null);
  const [preview,setPreview]=useState<Preview|null>(null),[choices,setChoices]=useState<Record<string,'local'|'remote'>>({});
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(''),[ready,setReady]=useState(false);
  useEffect(()=>{let alive=true;void readDeviceRecord<Saved>('remote-sync').then(value=>{if(alive){if(value){setConfig(remoteConfigSchema.parse(value.config));setSaved(value);}setReady(true);}}).catch(()=>{if(alive){setError('本机同步配置无法读取，请重新保存配置');setReady(true);}});return()=>{alive=false;};},[]);
  const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');setMessage('');try{await action();}catch(cause){setError(remoteFailureMessage(cause));}finally{setBusy(false);}};
  const field=(key:keyof RemoteConfig,value:string)=>{setConfig(old=>({...old,[key]:value}));setPreview(null);setChoices({});};
  const same=saved&&JSON.stringify(config)===JSON.stringify(saved.config);
  usePrivateDraft(busy||Boolean(!same&&(config.url||config.username||config.password||config.accessKey||config.secretKey||config.sessionToken)));
  const merged=preview?mergePersonalData(saved?.baseline??null,preview.local,preview.remote,choices):null;
  const step=!same?1:preview?3:saved?.lastSync?4:2;
  return <section className="personal-feature" aria-label="云端同步">
    <div className="personal-feature__heading"><h3>云端同步</h3><span className="personal-feature__badge">WebDAV / S3</span></div>
    <p>在设备间同步收藏、自定义导航、备忘、首页设置和钓鱼进度。凭证在本机加密保存，不会传给本站服务器，也不包含在个人备份中。</p>
    <ol className="sync-steps" aria-label="同步连接步骤">{['保存连接配置','检查连接并读取','核对差异','确认应用'].map((label,index)=><li key={label} aria-current={step===index+1?'step':undefined}>{index+1}. {label}</li>)}</ol>
    <p className="sync-diagnostic">{!same?'先保存当前设备的连接配置。':preview?'读取成功，请核对差异；读取成功不代表已验证写入权限。':saved?.lastSync?'此设备已有同步记录。再次同步时先读取远端，检查是否有新的差异。':'配置已保存在本机，尚未确认远端是否可读。下一步只读取，不写入远端。'}</p>
    <form onSubmit={event=>{event.preventDefault();void run(async()=>{
      const parsed=remoteConfigSchema.parse(config);remoteUrl(parsed.url);createRemoteClient(parsed);
      const next:Saved={config:parsed,baseline:same?saved.baseline:null,...(same&&saved.lastSync?{lastSync:saved.lastSync}:{}),...(saved?.backup?{backup:saved.backup}:{})};
      await writeDeviceRecord('remote-sync',next);setSaved(next);setPreview(null);setMessage('同步配置已加密保存在本机');
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
      <button disabled={busy||!same||!ready} onClick={()=>void run(async()=>{setPreview(null);setChoices({});const local=await store.read(),remote=await createRemoteClient(config).read();setPreview({local,remote:remote.data,etag:remote.etag});setMessage(remote.data?'连接成功，文件格式和强 ETag 检查通过，尚未写入。':'远端返回文件不存在，尚未写入；确认应用时才会尝试创建并验证条件写入。');})}>读取远端并预览</button>
      {saved?.lastSync?<span>上次同步 {new Date(saved.lastSync).toLocaleString('zh-CN')}</span>:<span>尚未同步</span>}
    </div>
    {preview&&merged?<div className="personal-feature__preview">
      <h4>同步预览</h4><p>{preview.remote?'已读取远端备份':'远端文件不存在，将创建新备份'}。合并后 {merged.data.links.length} 个网站、{merged.data.notes.length} 条备忘、{merged.data.fish.cn.length+merged.data.fish.global.length} 项钓鱼标记。</p>
      {merged.conflicts.length>0?<p>有 {merged.conflicts.length} 项冲突，请逐项选择；取消标记和删除也会参与比较。</p>:<p>没有未解决冲突，可以应用同步。</p>}
      {merged.conflicts.map(conflict=><label className="local-settings__field" key={conflict.key}>{conflict.label}<select value={choices[conflict.key]??''} onChange={event=>setChoices(old=>({...old,[conflict.key]:event.target.value as 'local'|'remote'}))}><option value="">请选择保留哪一份</option><option value="local">保留本机{conflict.local===undefined?'的删除操作':''}</option><option value="remote">保留远端{conflict.remote===undefined?'的删除操作':''}</option></select></label>)}
      <button disabled={busy||merged.conflicts.length>0} onClick={()=>void run(async()=>{
        if((await store.read()).revision!==preview.local.revision)throw new Error('本机已变化');
        await writeDeviceRecord('remote-sync',{...saved,backup:preview.local});
        await createRemoteClient(config).write(merged.data,preview.etag);
        await applyPersonalSync(store,preview.local.revision,merged.data);
        const next:Saved={config,baseline:merged.data,backup:preview.local,lastSync:new Date().toISOString()};
        await writeDeviceRecord('remote-sync',next);setSaved(next);setPreview(null);setMessage('双向同步完成，已保留本次同步前的本机快照');
      })}>应用双向同步</button>
    </div>:null}
    {saved?.backup?<button disabled={busy} onClick={()=>{if(window.confirm('恢复上一次同步前的本机数据？远端文件不会改变。'))void run(async()=>{const backup=localDataSchema.parse(saved.backup);await store.restoreBackup({format:'ff14-hub-local',version:1,exportedAt:new Date().toISOString(),data:backup});setMessage('已恢复上一次同步前的本机数据，请重新预览再同步');setPreview(null);});}}>恢复同步前的本机快照</button>:null}
    {message?<p role="status" className="notice notice--ok">{message}</p>:null}{error?<p role="alert" className="notice notice--error">{error}</p>:null}
  </section>;
}
