/** 一次性管理员注册及账号密码+Vault兼容TOTP登录。 */
import { useEffect, useState } from 'react';
import { calendarAdminSession } from './calendar-admin-session';

interface SetupState { totpKey: string; otpauthUri: string }
type Stage = 'loading' | 'setup' | 'confirm' | 'login';

export function CalendarAdminAccess({onReady,onClose}:{
  readonly onReady:()=>void;
  readonly onClose:()=>void;
}) {
  const [stage,setStage]=useState<Stage>('loading');
  const [setup,setSetup]=useState<SetupState|null>(null);
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();
    void fetch('/api/v1/events/admin/provisioning',{
      credentials:'omit',cache:'no-store',signal:controller.signal,
    }).then(async r=>{
      if(!r.ok)throw new Error('无法读取管理员配置');
      const info=await r.json() as {configured:boolean;pending:boolean};
      if(!controller.signal.aborted)setStage(info.configured?'login':info.pending?'confirm':'setup');
    }).catch(()=>{if(!controller.signal.aborted)setMessage('管理员服务不可用');});
    return ()=>controller.abort();
  },[]);

  async function submit(form:HTMLFormElement) {
    const fields=new FormData(form);
    const field=(name:string):string=>{
      const value=fields.get(name);
      return typeof value==='string'?value:'';
    };
    const username=field('username').trim();
    const password=field('password');
    const code=field('code').trim();
    const setupSecret=field('setupSecret');
    const path=stage==='setup'?'setup':stage==='confirm'?'setup/confirm':'login';
    const body=stage==='setup'?{username,password}:{username,password,code};
    setBusy(true);setMessage('');
    try{
      const res=await fetch('/api/v1/events/admin/'+path,{
        method:'POST',credentials:'omit',cache:'no-store',redirect:'error',
        headers:{'Content-Type':'application/json',...(stage!=='login'?{'X-Calendar-Setup-Key':setupSecret}:{})},
        body:JSON.stringify(body),
      });
      if(!res.ok){
        if(res.status===429)throw new Error('操作过于频繁，服务器临时限制了请求。请至少间隔 5 分钟后再尝试。');
        if(res.status===409)throw new Error('管理员账号已经创建，请进入登录页面');
        if(res.status>=500)throw new Error('管理员服务出现内部错误，与你填写的账号密码不一定有关。请停止重复提交并检查服务状态。');
        throw new Error('登录或初始化失败：请核对管理员账号、密码、初始化密钥和验证码');
      }
      if(stage==='setup') {
        const result=await res.json() as SetupState;
        setSetup(result);
        setStage('confirm');
        form.reset();
        setMessage('管理员账户已创建。请先把 TOTP 密钥添加到 Vault，再填写确认表单绑定。');
        return;
      }
      const result=await res.json() as {token:string};
      if(!/^ffh_admin_[0-9a-f]{64}$/.test(result.token))throw new Error('服务端会话响应无效');
      calendarAdminSession.set(result.token);
      form.reset();
      setSetup(null);
      onReady();
    }catch(e){setMessage(e instanceof Error?e.message:'操作失败');}
    finally{setBusy(false);}
  }

  return <section className="calendar-admin-access panel" aria-label="管理员身份认证">
    <button type="button" className="text-button" onClick={onClose}>← 返回国服活动日历</button>
    <h2>{stage==='setup'?'首次开通管理员':stage==='confirm'?'绑定身份验证器':'管理员登录'}</h2>
    <p className="panel__muted">管理员与玩家工作空间分开。使用独立账号密码和每 30 秒更新的 6 位 TOTP 验证码，兼容 Vaultwarden/Bitwarden 等标准身份验证器。</p>
    {stage==='loading'?<p role="status">正在检查管理员状态…</p>:<>
      {setup && <section className="calendar-admin-access__totp" aria-label="身份验证器绑定密钥">
        <p>请在 Vault 的身份验证器中手动新增 TOTP 项目，输入以下一次性密钥。密钥只在此次绑定时展示。</p>
        <p><strong>验证器密钥：</strong><code>{setup.totpKey}</code></p>
        <details><summary>兼容 TOTP 的 otpauth 链接</summary><code>{setup.otpauthUri}</code></details>
        <p>算法 SHA1 · 6 位 · 30 秒。不要与密码一同分享密钥；建议分开保存。</p>
      </section>}
      <form className="calendar-admin-access__form" onSubmit={event=>{
        event.preventDefault();void submit(event.currentTarget);
      }}>
        <label>管理员账号
          <input name="username" type="text" autoComplete="username" required minLength={3} maxLength={40} pattern="[A-Za-z0-9._-]+" placeholder="admin"/>
        </label>
        <label>管理员密码
          <input name="password" type="password" autoComplete={stage==='setup'?'new-password':'current-password'} required minLength={14} maxLength={128}/>
        </label>
        {stage!=='login' && <label>部署初始化密钥
          <input name="setupSecret" type="password" required autoComplete="off" placeholder="Cloudflare BOOTSTRAP_SECRET"/>
        </label>}
        {stage!=='setup' && <label>身份验证器验证码
          <input name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required autoComplete="one-time-code" placeholder="6 位数字"/>
        </label>}
        <button type="submit" className="button" disabled={busy}>{busy?'验证中…':stage==='setup'?'创建账号并获取验证器密钥':stage==='confirm'?'确认绑定并登录':'安全登录'}</button>
      </form>
      {message && <p role="status" className="notice">{message}</p>}
      {stage==='confirm' && !setup && <p className="panel__muted">如果此前已创建账号但尚未完成绑定，请使用创建时保存的验证器密钥完成确认。若密钥丢失，需由站点运维通过安全流程重置未激活账户。</p>}
    </>}
  </section>;
}
