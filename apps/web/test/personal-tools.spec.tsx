// @vitest-environment jsdom
import {cleanup,render,fireEvent,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {planModules} from '../src/app/local/ModuleGrid';
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
it('keeps old notes valid and derives overdue status independently of reminder time',()=>{
  const data=initial();data.notes.push({id:crypto.randomUUID(),title:'旧备忘',text:'原文'});expect(localDataSchema.parse(data).notes[0]?.text).toBe('原文');
  expect(todoStatus({...data.notes[0]!,remindAt:1000},2000)).not.toContain('逾期');expect(todoStatus({...data.notes[0]!,endsAt:1000},2000)).toContain('逾期');
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
