/** 统一全站 owner 后台：只在服务器验证当前会话后呈现可编辑功能。 */
import { useEffect, useState } from 'react';
import { CalendarAdminAccess } from '../events/CalendarAdminAccess';
import { CalendarAdminPanel } from '../events/CalendarAdminPanel';
import { calendarAdminSession, useCalendarAdminSession } from '../events/calendar-admin-session';
import { SiteSettingsPanel } from './SiteSettingsPanel';
import { SiteDirectoryPanel } from './SiteDirectoryPanel';
import './site-admin.css';
import {RecyclePanel} from './ContentLifecycle';
import {GameDataPanel} from './GameDataPanel';
import {OperationsPanel} from './OperationsPanel';
import {hasAnyPrivateDraft} from '../pwa/draft-registry';

type Tab='overview'|'settings'|'calendar'|'security'|'directory'|'recycle'|'gameData';
type Gate='checking'|'ready'|'signedOut'|'failed';

export function SiteAdminPage({onClose}: {readonly onClose:()=>void}) {
  const session=useCalendarAdminSession();
  const [gate,setGate]=useState<Gate>('checking');
  const [tab,setTab]=useState<Tab>('overview');
  const changeTab=(next:Tab)=>{if(next===tab)return;if(hasAnyPrivateDraft()&&!window.confirm('当前有未保存的输入，离开会丢弃这些修改。是否继续？'))return;setTab(next);};
  useEffect(()=>{
    const token=calendarAdminSession.get();
    if(!token){void Promise.resolve().then(()=>setGate('signedOut'));return;}
    const controller=new AbortController();
    void fetch('/api/v1/admin/session',{
      credentials:'omit',cache:'no-store',signal:controller.signal,
      headers:{Authorization:'Bearer '+token},
    }).then(r=>{
      if(controller.signal.aborted)return;
      if(r.status===401||r.status===403) {calendarAdminSession.clear();setGate('signedOut');}
      else setGate(r.ok?'ready':'failed');
    }).catch(()=>{if(!controller.signal.aborted)setGate('failed');});
    return ()=>controller.abort();
  },[session.version]);

  function logout(){
    if(hasAnyPrivateDraft()&&!window.confirm('有未保存的修改，确定退出并丢弃吗？'))return;
    const token=calendarAdminSession.get();
    if(token)void fetch('/api/v1/admin/logout',{
      method:'POST',credentials:'omit',headers:{Authorization:'Bearer '+token},
    }).catch(()=>undefined);
    calendarAdminSession.clear();setTab('overview');setGate('signedOut');
  }
  if(gate==='checking')return <output className="panel" style={{display:'block'}}>正在验证站点管理员会话…</output>;
  if(gate==='failed')return <section className="panel" role="alert">
    <h2>管理员服务暂时不可用</h2>
    <button className="text-button" onClick={onClose}>返回设置</button>
    <button className="text-button" onClick={logout}>清除本次会话</button>
  </section>;
  if(gate==='signedOut')return <CalendarAdminAccess onClose={onClose} onReady={()=>setGate('checking')}/>;
  return <section className="site-admin" aria-label="站点管理员后台">
    <header className="site-admin__header">
      <div>
        <button type="button" className="text-button" onClick={()=>{if(!hasAnyPrivateDraft()||window.confirm('有未保存的修改，确定离开吗？'))onClose();}}>← 返回我的设置</button>
        <h2>站点管理</h2>
        <p>所有更改均在服务器授权执行；公开展示设置可直接保存到 D1，无需重新部署。</p>
      </div>
      <button type="button" className="button button--secondary" onClick={logout}>安全退出</button>
    </header>
    <nav className="site-admin__tabs" aria-label="站点管理模块">
      {([['overview','管理概览'],['settings','展示与分类'],['directory','网站目录'],['calendar','国服活动'],['gameData','游戏数据'],['recycle','回收站与记录'],['security','账号与安全']] as const).map(([id,label])=>
        <button key={id} type="button" aria-current={tab===id?'page':undefined}
          className={tab===id?'site-admin__tab site-admin__tab--active':'site-admin__tab'}
          onClick={()=>changeTab(id)}>{label}</button>)}
    </nav>
    {tab==='overview'&&<div className="site-admin__overview">
      <h3>站点管理概览</h3>
      <OperationsPanel/>
      <p>当前身份：唯一站点所有者（Owner）。公共内容管理与浏览器本地个人数据分开，管理员不会取得玩家的本地数据。</p>
      <div className="site-admin__cards">
        <button type="button" onClick={()=>setTab('settings')}><strong>网站设置</strong><span>网站名称、全站公告与首页模块全局开关</span></button>
        <button type="button" onClick={()=>setTab('directory')}><strong>网站目录</strong><span>新增、编辑、下架与恢复网站，直接同步后端</span></button>
        <button type="button" onClick={()=>setTab('calendar')}><strong>活动内容</strong><span>新建、修订、隐藏及恢复活动；同步到公开日历</span></button>
        <button type="button" onClick={()=>setTab('security')}><strong>安全与会话</strong><span>查看管理员安全说明并退出会话</span></button>
      </div>
      <p className="panel__muted">需要修改程序代码、Cloudflare 密钥、数据库结构及安全策略的操作仍必须走受控发布流程。</p>
    </div>}
    {tab==='settings'&&<SiteSettingsPanel/>}
    {tab==='recycle'&&<RecyclePanel/>}
    {tab==='gameData'&&<GameDataPanel/>}
    {tab==='directory'&&<SiteDirectoryPanel/>}
    {tab==='calendar'&&<CalendarAdminPanel getToken={calendarAdminSession.get}
      onClose={()=>setTab('overview')} onSaved={()=>window.dispatchEvent(new Event('ff14hub:admin-calendar-changed'))}/>}
    {tab==='security'&&<section className="site-admin__overview">
      <h3>管理员账号与安全</h3>
      <p>本站只有一个预先配置的管理员账号；网页不会提供注册、第二管理员创建或重新绑定 TOTP 的入口。</p>
      <p>管理员登录需要独立密码 + 动态验证码。令牌仅保存在当前网页的内存中，刷新页面后需要重新登录。</p>
      <p>请固定保管 Cloudflare 的 BOOTSTRAP_SECRET：它也是管理员 TOTP 加密和密码验证所依赖的服务器密钥。</p>
      <button type="button" className="button button--secondary" onClick={logout}>退出管理后台</button>
    </section>}
  </section>;
}
