import {useEffect,useState} from 'react';
import {usePrivateDraft} from '../pwa/draft-registry';
import type {LocalStore} from './store';
import {readDeviceRecord,writeDeviceRecord} from './secure-storage';
import {defaultNotificationSettings,digestSettings,notificationRequest,registerNotifications,NOTIFICATION_SETTINGS_CHANGED,type NotificationSettings} from './local-notifications';
export function LocalNotificationPanel({store}:{store:LocalStore}){
  const [settings,setSettings]=useState<NotificationSettings>(defaultNotificationSettings);
  const [sendKey,setSendKey]=useState(''),[apiKey,setApiKey]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState('');
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  const [status,setStatus]=useState<{jobs:{key:string;dueAt:number;status:string;attempts:number}[];device:{sentCount:number;sentDay:string;dailyLimit:number;expiresAt:number}}|null>(null);
  const [ready,setReady]=useState(false);
  usePrivateDraft(busy||Boolean(!settings.token&&(sendKey||apiKey||from||to)));
  useEffect(()=>{let alive=true;void readDeviceRecord<NotificationSettings>('notifications').then(value=>{if(alive){if(value)setSettings(value);setReady(true);}}).catch(()=>{if(alive){setError('本机通知配置无法读取，请重新配置');setReady(true);}});return()=>{alive=false;};},[]);
  const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');setMessage('');try{await action();}catch(cause){setError(cause instanceof Error?cause.message:'通知操作失败');}finally{setBusy(false);}};
  const patch=(value:Partial<NotificationSettings>)=>setSettings(old=>({...old,...value}));
  return <section className="personal-feature" aria-label="通知设置">
    <div className="personal-feature__heading"><h3>通知</h3><span className="personal-feature__badge">低消耗模式</span></div>
    <p>后台通过 Server 酱或邮件发送。鱼窗按每天一份日程汇总，列出今天、明天的全部关注窗口；网页内仍按窗口实时提醒。后台每 5 分钟检查一次，定时发送可能有约 5 分钟偏差。</p>
    <form onSubmit={event=>{event.preventDefault();void run(async()=>{
      if(settings.token)throw new Error('请先停用当前渠道，再保存新的通知配置');
      const channel=settings.channel==='serverchan'?{kind:'serverchan' as const,sendKey}:{kind:'resend' as const,apiKey,from,to};
      const next=await registerNotifications(channel,settings,store);setSettings(next);setSendKey('');setApiKey('');setMessage('通知已启用。可发送测试消息检查是否收件。');
    });}}>
      <label className="local-settings__field">后台通知渠道<select value={settings.channel} disabled={busy||!!settings.token} onChange={event=>patch({channel:event.target.value as NotificationSettings['channel']})}><option value="serverchan">Server 酱 Turbo</option><option value="resend">邮件（Resend）</option></select></label>
      {settings.token?<p>当前渠道已连接，凭证不会回显。提醒规则可以直接保存；切换接收渠道请先停用后重新配置。</p>:settings.channel==='serverchan'?<label className="local-settings__field">Server 酱 SendKey<input required type="password" autoComplete="new-password" value={sendKey} placeholder="SCT…" onChange={event=>setSendKey(event.target.value)}/><small>使用 Turbo 的 SCT 开头 SendKey。Server 酱³ 密钥不适用于此入口。</small></label>:<div className="personal-feature__fields">
        <label className="local-settings__field">Resend API Key<input required type="password" autoComplete="new-password" value={apiKey} onChange={event=>setApiKey(event.target.value)}/></label>
        <label className="local-settings__field">已验证域名的发件邮箱<input required type="email" value={from} onChange={event=>setFrom(event.target.value)}/></label>
        <label className="local-settings__field">接收邮箱<input required type="email" value={to} onChange={event=>setTo(event.target.value)}/></label>
      </div>}
      <fieldset disabled={busy}><legend>提醒内容</legend>
        <label><input type="checkbox" checked={settings.events} onChange={event=>patch({events:event.target.checked})}/>后台活动临近结束汇总</label><br/>
        {settings.events?<div className="personal-feature__toolbar">{([3,1] as const).map(days=><label key={days}><input type="checkbox" checked={settings.eventEndDays.includes(days)} onChange={event=>patch({eventEndDays:event.target.checked?[...settings.eventEndDays,days]:settings.eventEndDays.filter(value=>value!==days)})}/>结束前 {days} 天提醒</label>)}</div>:null}
        <label><input type="checkbox" checked={settings.fish} onChange={event=>patch({fish:event.target.checked})}/>后台鱼窗每日汇总（未钓获且已标记闹钟，最多 50 条鱼）</label>
        <label className="local-settings__field">每日发送时间（北京时间）<input type="time" required value={settings.digestTime} onChange={event=>patch({digestTime:event.target.value})}/><small>今天和明天分组，按可钓开始时间排列，同一条鱼的多次窗口逐项列出。网页内的临近窗口提醒不受此时间影响。</small></label>
        <div className="personal-feature__fields"><label className="local-settings__field">网页内提醒提前分钟<input type="number" min={5} max={60} step={5} required value={settings.leadMinutes} onChange={event=>patch({leadMinutes:Number(event.target.value)})}/></label>
          <label className="local-settings__field">每日最大发送批次<input type="number" min={1} max={50} required value={settings.dailyLimit} onChange={event=>patch({dailyLimit:Number(event.target.value)})}/></label></div>
      </fieldset>
      {!settings.token?<button disabled={busy||!ready} type="submit">启用后台通知</button>:null}
    </form>
    <p className="local-settings__caution">渠道凭证会通过 HTTPS 发送到本站，并加密保存在服务器，以便网页关闭后投递；不会进入 WebDAV/S3 备份。邮件需自行配置 Resend 的已验证发件域名。渠道额度由各服务决定。</p>
    <div className="personal-feature__toolbar">
      <button disabled={busy||!settings.token} onClick={()=>void run(async()=>{const digest=digestSettings(await store.read(),settings);await notificationRequest('/plan',settings.token!,'PUT',{jobs:[],digest,dailyLimit:settings.dailyLimit});const next={...settings,lastPlan:Date.now()};await writeDeviceRecord('notifications',next);setSettings(next);window.dispatchEvent(new Event(NOTIFICATION_SETTINGS_CHANGED));setMessage('提醒规则已保存，无需重新填写渠道凭证');})}>保存提醒规则</button>
      <button disabled={busy||!settings.token} onClick={()=>void run(async()=>{const result=await notificationRequest('/test',settings.token!,'POST') as {accepted:boolean};if(!result.accepted)throw new Error('渠道未接受测试消息，请检查凭证与额度');setMessage('通知服务已接受测试消息，请在接收端确认收件');})}>发送测试消息</button>
      <button disabled={busy||!settings.token} onClick={()=>void run(async()=>{setStatus(await notificationRequest('/status',settings.token!) as NonNullable<typeof status>);setMessage('已更新通知状态');})}>查看投递状态</button>
      <button disabled={busy||!settings.token} onClick={()=>void run(async()=>{await notificationRequest('/subscription',settings.token!,'DELETE');const next={...settings,token:null,jobs:[],lastPlan:0};await writeDeviceRecord('notifications',next);setSettings(next);setStatus(null);window.dispatchEvent(new Event(NOTIFICATION_SETTINGS_CHANGED));setMessage('后台通知已停用，服务器中的渠道凭证和待发任务已删除');})}>停用后台通知</button>
    </div>
    <h4>网页内通知</h4><p>需要浏览器授权，仅网页打开时检查本机提醒，可与邮件或 Server 酱同时使用。</p>
    <button disabled={busy} onClick={()=>void run(async()=>{if(!('Notification' in window))throw new Error('当前浏览器不支持通知');const permission=await Notification.requestPermission();if(permission!=='granted')throw new Error('未获得通知权限，请到浏览器站点设置中允许');const next={...settings,browser:!settings.browser};await writeDeviceRecord('notifications',next);setSettings(next);window.dispatchEvent(new Event(NOTIFICATION_SETTINGS_CHANGED));setMessage(next.browser?'网页内通知已启用':'网页内通知已停用');})}>{settings.browser?'关闭网页内通知':'授权并启用网页内通知'}</button>
    {settings.lastPlan?<p>上次登记 {new Date(settings.lastPlan).toLocaleString('zh-CN')}。鱼窗汇总在服务器每天生成，关闭网页后继续运行；关注列表按最近一次同步为准。活动临近提醒和网页内提示保留未来 72 小时内最近 30 条，每次访问或前台停留满 6 小时补充。订阅在 90 天不访问后过期。</p>:null}
    {status?<div className="personal-feature__preview"><h4>投递记录</h4><p>今日发送尝试 {status.device.sentDay===new Date().toISOString().slice(0,10)?status.device.sentCount:0} / {status.device.dailyLimit} 批（UTC 日界限）</p><ul>{status.jobs.map(job=><li key={job.key}>{new Date(job.dueAt).toLocaleString('zh-CN')} · {({queued:'待发送',leased:'发送中',sent:'渠道已接受',failed:'发送失败',cancelled:'已取消'} as Record<string,string>)[job.status]??job.status} · 尝试 {job.attempts} 次</li>)}</ul></div>:null}
    {settings.error?<p role="alert" className="notice notice--error">上次后台登记：{settings.error}。网页内提醒仍独立工作。</p>:null}
    {message?<p role="status" className="notice notice--ok">{message}</p>:null}{error?<p role="alert" className="notice notice--error">{error}</p>:null}
  </section>;
}
