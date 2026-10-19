/** 全站唯一 owner 登录：只接受现有管理员的密码 + 6 位 TOTP，不提供注册或密钥绑定。 */
import { useState } from 'react';
import { calendarAdminSession } from './calendar-admin-session';
import './calendar-admin.css';

export function CalendarAdminAccess({onReady,onClose}:{
  readonly onReady:()=>void;
  readonly onClose:()=>void;
}) {
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  async function submit(form:HTMLFormElement) {
    const fields=new FormData(form);
    const username=String(fields.get('username')??'').trim();
    const password=String(fields.get('password')??'');
    const code=String(fields.get('code')??'').trim();
    setBusy(true);setMessage('');
    try {
      const res=await fetch('/api/v1/admin/login',{
        method:'POST',credentials:'omit',cache:'no-store',redirect:'error',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({username,password,code}),
      });
      if(!res.ok) {
        if(res.status===429)throw new Error('登录过于频繁，请稍后再试');
        if(res.status>=500)throw new Error('管理员认证服务暂时异常');
        throw new Error('账号、密码或动态验证码不正确');
      }
      const data=await res.json() as {token:string};
      if(!/^ffh_admin_[0-9a-f]{64}$/.test(data.token))throw new Error('会话响应格式异常');
      calendarAdminSession.set(data.token);
      form.reset();
      onReady();
    }catch(e){setMessage(e instanceof Error?e.message:'登录失败');}
    finally{setBusy(false);}
  }
  return <section className="calendar-admin-access panel" aria-label="站点管理员身份认证">
    <button type="button" className="text-button" onClick={onClose}>← 返回设置</button>
    <h2>站点管理员登录</h2>
    <p className="panel__muted">仅现有站点管理员可以登录。账号密码与 30 秒动态验证码共同验证；不开放新管理员注册。</p>
    <form className="calendar-admin-access__form" onSubmit={event=>{event.preventDefault();void submit(event.currentTarget);}}>
      <label>管理员账号
        <input name="username" type="text" autoComplete="username" required minLength={3} maxLength={40} pattern="[A-Za-z0-9._-]+" />
      </label>
      <label>管理员密码
        <input name="password" type="password" autoComplete="current-password" required minLength={14} maxLength={128}/>
      </label>
      <label>身份验证器（TOTP）
        <input name="code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required placeholder="6 位动态验证码"/>
      </label>
      <button type="submit" className="button" disabled={busy}>{busy?'正在验证…':'安全登录'}</button>
    </form>
    {message && <p className="notice" role="status">{message}</p>}
  </section>;
}
