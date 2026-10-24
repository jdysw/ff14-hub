// @vitest-environment jsdom
import {cleanup,render,fireEvent,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {planHomeModules,planModules,readSavedHomeColumns,clearSavedHomeLayout} from '../src/app/local/ModuleGrid';
import {TodoBoard,todoStatus} from '../src/app/local/TodoBoard';
import {localDataSchema,type LocalStore} from '../src/app/local/store';
import {buildTodoNotificationJobs} from '../src/app/local/local-notifications';
import {resolveDirectoryCategory} from '@ff14-hub/shared';
const initial=()=>localDataSchema.parse({version:1,revision:0,fish:{cn:[],global:[]},links:[],notes:[],configuration:{order:['events','fishing','pvp','notes'],visible:{events:true,fishing:true,pvp:true,notes:false},region:'cn'}});
afterEach(cleanup);
it('balances odd modules and spans the last item only when that removes a substantial gap',()=>{
  expect(planModules([400,150,200])).toEqual([0,1,1]);expect(planModules([200,190,250])).toEqual([0,1,2]);
  expect(planModules([200,190,250],[],false)).toEqual([0,1,1]);expect(planModules([200,190,100,100])).toEqual([0,1,1,0]);
});
it('列高接近时保留既有布局，差距较大时仍优先填充较短列',()=>{
  expect(planModules([100,130,90],[1,0,1],false)).toEqual([1,0,1]);
  expect(planModules([100,130,90],[],false)).toEqual([0,1,0]);
  expect(planModules([100],[],true)).toEqual([2]);
  expect(planModules([100],[],false)).toEqual([0]);
});
it('首页默认活动位于左栏、钓鱼与 PVP 依次位于右栏，用户自定义布局仍有效',()=>{
  expect(planHomeModules([540,415,271],'events,fishing,pvp','auto')).toEqual([0,1,2]);
  expect(planHomeModules([540,415,271],'events,pvp,fishing','auto')).toEqual(planModules([540,415,271]));
  expect(planHomeModules([540,415,271],'events,fishing,pvp','balanced')).toEqual(planModules([540,415,271],[],false));
  expect(planHomeModules([300,270,250,200],'events,fishing,pvp,notes','auto')).toEqual(planModules([300,270,250,200]));
});
it('刷新时仅恢复相同模块、相同设置和相同宽度的排版；手动重排可删除缓存',()=>{
  const key='ff14-hub:home-module-columns:v3';
  localStorage.setItem(key,JSON.stringify({
    version:3,identity:'events,fishing,pvp',mode:'auto',width:1200,viewportWidth:1280,columns:[0,1,2],heights:[505,533,206],
  }));
  expect(readSavedHomeColumns('events,fishing,pvp','auto',1200,1280,3)).toEqual([0,1,2]);
  expect(readSavedHomeColumns('events,pvp,fishing','auto',1200,1280,3)).toBeNull();
  expect(readSavedHomeColumns('events,fishing,pvp','balanced',1200,1280,3)).toBeNull();
  expect(readSavedHomeColumns('events,fishing,pvp','auto',990,1050,3)).toBeNull();
  expect(readSavedHomeColumns('events,fishing,pvp','auto',1200,1280,2)).toBeNull();
  localStorage.setItem(key,JSON.stringify({
    version:1,identity:'events,fishing,pvp',mode:'auto',width:1200,viewportWidth:1280,columns:[0,1,2],heights:[505,533,206],
  }));
  expect(readSavedHomeColumns('events,fishing,pvp','auto',1200,1280,3)).toBeNull();
  localStorage.setItem(key,JSON.stringify({
    version:3,identity:'events,fishing,pvp',mode:'balanced',width:1200,viewportWidth:1280,columns:[0,1,2],heights:[505,533,206],
  }));
  expect(readSavedHomeColumns('events,fishing,pvp','balanced',1200,1280,3)).toBeNull();
  localStorage.setItem(key,JSON.stringify({version:3,identity:'events,fishing,pvp',mode:'auto',width:1200,viewportWidth:1280,columns:[0,1,2],heights:[505,-10,206]}));
  expect(readSavedHomeColumns('events,fishing,pvp','auto',1200,1280,3)).toBeNull();
  clearSavedHomeLayout();
  expect(localStorage.getItem(key)).toBeNull();
});
it('keeps old notes valid and derives overdue status independently of reminder time',()=>{
  const data=initial();data.notes.push({id:crypto.randomUUID(),title:'旧备忘',text:'原文'});expect(localDataSchema.parse(data).notes[0]?.text).toBe('原文');
  expect(todoStatus({...data.notes[0]!,remindAt:1000},2000)).not.toContain('逾期');expect(todoStatus({...data.notes[0]!,endsAt:1000},2000)).toContain('逾期');
});
it('待办倒计时保留天、小时、分钟与开始/逾期的原有边界',()=>{
  const note={id:'one',title:'测试',text:''};
  const now=1_000_000_000;
  expect(todoStatus({...note,startsAt:now+2*86400000},now)).toBe('距开始 2 天');
  expect(todoStatus({...note,endsAt:now+2*3600000},now)).toBe('剩余 2 小时');
  expect(todoStatus({...note,endsAt:now+59000},now)).toBe('剩余 1 分钟');
  expect(todoStatus({...note,endsAt:now-60000},now)).toBe('已逾期 1 分钟');
  expect(todoStatus({...note,startsAt:now+2000,endsAt:now+3600000},now)).toBe('距开始 1 分钟');
});
it('quick-add saves immediately and enables the module without requiring time fields',async()=>{
  const data=initial(),change=vi.fn((fn:(doc:{data:typeof data})=>void)=>{fn({data});return Promise.resolve();});
  render(<TodoBoard data={data} store={{change} as unknown as LocalStore}/>);
  fireEvent.change(screen.getByRole('textbox',{name:'待办标题'}),{target:{value:'周末打本'}});fireEvent.click(screen.getByRole('button',{name:'添加'}));
  await waitFor(()=>expect(data.notes).toHaveLength(1));expect(data.configuration.visible.notes).toBe(true);expect(data.notes[0]?.title).toBe('周末打本');
});
it('completed tasks have no reminder job, and long-range jobs have stable identities',()=>{
  const data=initial(),now=Date.now(),remindAt=now+20*86400000;data.notes.push({id:crypto.randomUUID(),title:'稍后提醒',text:'',remindAt});
  expect(buildTodoNotificationJobs(data,now)[0]?.key).toBe(buildTodoNotificationJobs(data,now+1000)[0]?.key);data.notes[0]!.completed=true;expect(buildTodoNotificationJobs(data,now)).toEqual([]);
});
it('category renames and child merges follow aliases without discarding the original record',()=>{
  expect(resolveDirectoryCategory('旧分类 / 子类',{'旧分类':'新分类'})).toBe('新分类 / 子类');expect(resolveDirectoryCategory('旧分类 / 子类',{'旧分类 / 子类':'新分类 / 综合'})).toBe('新分类 / 综合');
});
