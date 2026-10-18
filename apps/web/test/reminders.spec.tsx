// @vitest-environment jsdom
import { cleanup,render,screen,waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach,it,expect } from 'vitest';
import { REMINDER_MODULE_ID,type ReminderSnapshot } from '@ff14-hub/shared';
import { ReminderPanel } from '../src/app/reminders/ReminderPanel';
import type { ModuleDataPort } from '../src/app/widgets/types';
afterEach(cleanup);
const snapshot:ReminderSnapshot={rules:[],jobs:[],deliveries:[],devices:[],pushConfigured:false,publicKey:null,
  targets:[{id:'event-1',kind:'event',region:'cn',label:'周末活动'}]};
it('keeps an unsaved rule after conflict and never automatically requests push permission',async()=>{
  const calls:unknown[]=[];
  const data:ModuleDataPort={moduleId:REMINDER_MODULE_ID,operations:['reminders.snapshot','reminders.save'],
    call:<T,>(op:string,input?:unknown):Promise<T>=>{
      calls.push({op,input});return op==='reminders.snapshot'?Promise.resolve(snapshot as T):Promise.reject(new Error('规则已变化，请刷新后重试；当前输入已保留'));
    }};
  render(<ReminderPanel data={data}/>);
  await screen.findByText('尚未建立规则。鱼类示例与未验证规则不会生成真实通知任务。');
  expect(screen.getByRole<HTMLButtonElement>('button',{name:'订阅当前设备'}).disabled).toBe(true);
  await userEvent.click(screen.getByRole('button',{name:'新增提醒规则'}));
  await userEvent.selectOptions(screen.getByLabelText('提醒目标'),'event-1');
  await userEvent.clear(screen.getByLabelText('提前分钟'));await userEvent.type(screen.getByLabelText('提前分钟'),'25');
  await userEvent.click(screen.getByRole('button',{name:'保存提醒规则'}));
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('当前输入已保留'));
  expect(screen.getByLabelText<HTMLInputElement>('提前分钟').value).toBe('25');
  expect(calls).toContainEqual({op:'reminders.save',input:expect.objectContaining({leadMinutes:25,targetId:'event-1',expectedRevision:0}) as unknown});
});
it('gives a useful disabled module placeholder',()=>{
  render(<ReminderPanel data={undefined}/>);expect(screen.getByText('请先启用提醒管理模块。')).toBeDefined();
});
