/** 站长可直接在线修改的非敏感全站设置，D1 revision 防止覆盖并发修改。 */
import { useCallback, useEffect, useState } from 'react';
import { calendarAdminSession } from '../events/calendar-admin-session';
import { DEFAULT_SITE_SETTINGS, SITE_SETTINGS_CHANGED, type SiteSettings, type SiteSettingsDocument } from './site-settings';
import {PresentationEditor} from './PresentationEditor';
import {clearSavedHomeLayout} from '../local/ModuleGrid';
import {managedPresentationSchema,DEFAULT_CATEGORIES,DEFAULT_HOME} from '@ff14-hub/shared';
import {usePrivateDraft} from '../pwa/draft-registry';

export function SiteSettingsPanel() {
  const [revision,setRevision]=useState(0);
  const [draft,setDraft]=useState<SiteSettings>(DEFAULT_SITE_SETTINGS);
  const [saved,setSaved]=useState(()=>JSON.stringify(DEFAULT_SITE_SETTINGS));
  usePrivateDraft(JSON.stringify(draft)!==saved);
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [message,setMessage]=useState('');
  const load=useCallback(async(signal?:AbortSignal)=>{
    const token=calendarAdminSession.get();
    if(!token)throw new Error('管理员会话已失效');
    const res=await fetch('/api/v1/admin/settings',{
      credentials:'omit',cache:'no-store',headers:{Authorization:'Bearer '+token},
      ...(signal?{signal}:{}),
    });
    if(res.status===401)throw new Error('会话已失效，请退出后重新登录');
    if(!res.ok)throw new Error('暂时无法读取站点设置');
    const data=await res.json() as SiteSettingsDocument;
    if(!signal?.aborted) {
      setRevision(data.revision);
      setDraft(data.settings);
      setSaved(JSON.stringify(data.settings));
    }
  },[]);
  useEffect(()=>{
    const controller=new AbortController();
    void Promise.resolve().then(()=>load(controller.signal)).catch(e=>{if(!controller.signal.aborted)setMessage(e instanceof Error?e.message:'读取失败');})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[load]);
  const patch=<K extends keyof SiteSettings>(key:K,value:SiteSettings[K])=>
    setDraft(old=>({...old,[key]:value}));
  async function save(){
    const token=calendarAdminSession.get();
    if(!token){setMessage('管理员会话已失效');return;}
    setSaving(true);setMessage('');
    try {
      managedPresentationSchema.parse(draft.presentation??{categories:DEFAULT_CATEGORIES,home:DEFAULT_HOME,categoryAliases:{}});
      const r=await fetch('/api/v1/admin/settings',{
        method:'PUT',credentials:'omit',cache:'no-store',redirect:'error',
        headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
        body:JSON.stringify({expectedRevision:revision,settings:draft}),
      });
      if(r.status===409)throw new Error('检测到其他会话已经修改配置。请重新载入后再保存。');
      if(r.status===401)throw new Error('管理员会话已失效，请退出后登录');
      if(!r.ok)throw new Error('保存失败，请检查输入长度与服务状态');
      const updated=await r.json() as SiteSettingsDocument;
      // 仅全站首页的模式、顺序或可见性发生变化时，清除本机旧列布局。
      const previousHome=JSON.parse(saved) as SiteSettings;
      if(JSON.stringify(previousHome.presentation?.home)!==JSON.stringify(updated.settings.presentation?.home))clearSavedHomeLayout();
      setDraft(updated.settings);setRevision(updated.revision);
      setSaved(JSON.stringify(updated.settings));
      window.dispatchEvent(new Event(SITE_SETTINGS_CHANGED));
      setMessage('设置已保存到 Cloudflare D1，公开页面无需重新部署即可生效');
    }catch(e){setMessage(e instanceof Error?e.message:'保存失败');}
    finally{setSaving(false);}
  }
  return <section className="site-admin__settings" aria-label="全站设置">
    <header><h3>全站设置</h3><p className="panel__muted">仅展示类配置可以在线修改。密钥、数据库、域名、CORS 与权限策略不能在网页中修改。</p></header>
    {loading?<output style={{display:'block'}}>正在读取站点设置…</output>:<>
      <label>网站名称{' '}<input type="text" required minLength={2} maxLength={48} value={draft.siteName}
          onChange={e=>patch('siteName',e.target.value)} />
      </label>
      <label>公开公告{' '}<textarea rows={4} maxLength={500} value={draft.announcement}
          placeholder="公告将显示在全站页首，可用于维护通知与活动说明" onChange={e=>patch('announcement',e.target.value)}/>
      </label>
      <label className="site-admin__check"><input type="checkbox" checked={draft.announcementEnabled}
        onChange={e=>patch('announcementEnabled',e.target.checked)}/> 对所有访客显示公告</label>
      <label className="site-admin__check"><input type="checkbox" checked={draft.homeCalendarEnabled}
        onChange={e=>patch('homeCalendarEnabled',e.target.checked)}/> 在网站首页允许显示国服活动模块</label>
      <p className="panel__muted">首页活动模块受全站开关与访客个人偏好共同控制；关闭全站开关不会清除用户偏好和活动数据。</p>
      <PresentationEditor value={draft.presentation} onChange={presentation=>patch('presentation',presentation)}/>
      <div className="site-admin__actions">
        <button type="button" className="button" disabled={saving||draft.siteName.trim().length<2} onClick={()=>void save()}>{saving?'保存中…':'保存并立即生效'}</button>
        <button type="button" className="button button--secondary" onClick={()=>void load().catch(e=>setMessage(String(e)))}>重新读取</button>
        <small>配置版本 {revision}</small>
      </div>
    </>}
    {message&&<output className="notice" style={{display:'block'}}>{message}</output>}
  </section>;
}
