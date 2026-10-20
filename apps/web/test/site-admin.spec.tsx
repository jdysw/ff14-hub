// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CalendarAdminAccess } from '../src/app/events/CalendarAdminAccess';
import { SiteSettingsPanel } from '../src/app/admin/SiteSettingsPanel';
import { calendarAdminSession } from '../src/app/events/calendar-admin-session';
import { CalendarAdminPanel } from '../src/app/events/CalendarAdminPanel';
afterEach(()=>{cleanup();calendarAdminSession.clear();vi.unstubAllGlobals();});

describe('站点管理员独立登录与全站在线设置',()=>{
  it('allows the authenticated owner to synchronize official announcements and reload the editor',async()=>{
    const fn=vi.fn((url:string)=>Promise.resolve(Response.json(url.endsWith('/refresh')?{ok:true}:{official:[],edits:[]})));
    vi.stubGlobal('fetch',fn);
    const saved=vi.fn();
    render(<CalendarAdminPanel getToken={()=>'owner-test-token'} onClose={vi.fn()} onSaved={saved}/>);
    await screen.findByText(/共 0 项/);
    fireEvent.click(screen.getByRole('button',{name:'同步官方公告'}));
    await screen.findByText('官方公告已同步，人工编辑内容已保留');
    expect(fn.mock.calls.map(x=>x[0])).toEqual(['/api/v1/admin/calendar/items','/api/v1/admin/calendar/refresh','/api/v1/admin/calendar/items']);
    expect(saved).toHaveBeenCalledOnce();
  });
  it('只渲染登录表单，不出现初始化、注册或 TOTP 绑定入口',async()=>{
    const fn=vi.fn(()=>Promise.resolve(Response.json({token:'ffh_admin_'+ 'a'.repeat(64)})));
    vi.stubGlobal('fetch',fn);
    const done=vi.fn();
    render(<CalendarAdminAccess onReady={done} onClose={vi.fn()}/>);
    expect(screen.getByRole('heading',{name:'站点管理员登录'})).toBeTruthy();
    expect(screen.queryByText('创建管理员账号')).toBeNull();
    expect(screen.queryByText('首次开通管理员')).toBeNull();
    expect(screen.queryByText('部署初始化密钥')).toBeNull();
    const username=screen.getByRole('textbox',{name:'管理员账号'});
    fireEvent.change(username,{target:{value:'owner'}});
    const password=document.querySelector<HTMLInputElement>('input[name="password"]');
    const code=document.querySelector<HTMLInputElement>('input[name="code"]');
    expect(password).toBeTruthy();expect(code).toBeTruthy();
    fireEvent.change(password!,{target:{value:'strong-password-for-tests'}});
    fireEvent.change(code!,{target:{value:'123456'}});
    fireEvent.click(screen.getByRole('button',{name:'安全登录'}));
    await waitFor(()=>expect(done).toHaveBeenCalledTimes(1));
    expect(fn).toHaveBeenCalledTimes(1);
    const [url,init]=fn.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toBe('/api/v1/admin/login');
    expect(init.credentials).toBe('omit');
    expect(init.headers).not.toHaveProperty('X-Calendar-Setup-Key');
    expect(JSON.parse(init.body as string)).toEqual({username:'owner',password:'strong-password-for-tests',code:'123456'});
  });
  it('网站设置可由已登录 owner 保存 D1，触发公开配置更新',async()=>{
    const first={revision:0,settings:{siteName:'FF14 Hub',announcement:'',announcementEnabled:false,homeCalendarEnabled:true}};
    const updated={revision:1,settings:{...first.settings,siteName:'测试中心'}};
    const fn=vi.fn((_url:string,request?:RequestInit)=>Promise.resolve(
      Response.json(request?.method==='PUT'?updated:first)));
    vi.stubGlobal('fetch',fn);
    calendarAdminSession.set('ffh_admin_'+'b'.repeat(64));
    render(<SiteSettingsPanel/>);
    const field=await screen.findByRole('textbox',{name:'网站名称'});
    fireEvent.change(field,{target:{value:'测试中心'}});
    fireEvent.click(screen.getByRole('button',{name:'保存并立即生效'}));
    await waitFor(()=>expect(fn).toHaveBeenCalledTimes(2));
    const [url,init]=fn.mock.calls[1] as unknown as [string,RequestInit];
    expect(url).toBe('/api/v1/admin/settings');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toMatchObject({expectedRevision:0,settings:{siteName:'测试中心'}});
    expect(init.headers).toHaveProperty('Authorization');
    expect(await screen.findByText(/配置版本 1/)).toBeTruthy();
  });
});
