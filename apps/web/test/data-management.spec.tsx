// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {DataManagementPanel} from '../src/app/local/DataManagementPanel';
import {localBackupSchema,type LocalData,type LocalStore} from '../src/app/local/store';
vi.mock('../src/app/local/secure-storage',()=>({readDeviceRecord:()=>Promise.resolve(null),writeDeviceRecord:()=>Promise.resolve()}));
const data:LocalData={version:1,revision:0,fish:{cn:[],global:[]},configuration:{order:['events','fishing','pvp','notes'],visible:{events:true,fishing:true,pvp:true,notes:false},region:'cn'},links:[],notes:[]};
function makeStore(){return {mergeFish:vi.fn(()=>Promise.resolve(2)),restoreBackup:vi.fn(()=>Promise.resolve()),read:vi.fn(()=>Promise.resolve(data)),exportBackup:vi.fn(()=>Promise.resolve(localBackupSchema.parse({format:'ff14-hub-local',version:1,exportedAt:new Date().toISOString(),data}))),change:vi.fn()} as unknown as LocalStore;}
afterEach(cleanup);

it('keeps imported fish data staged until the user explicitly confirms its region',async()=>{
  const store=makeStore();render(<DataManagementPanel data={data} store={store} initialSection="fish"/>);
  const file=new File(['{}'],'fish.json',{type:'application/json'});
  Object.defineProperty(file,'text',{value:()=>Promise.resolve(JSON.stringify({completed:[1,2],pinned:[],alarmFish:[]}))});
  fireEvent.change(screen.getByLabelText('鱼糕导出文件'),{target:{files:[file]}});
  await screen.findByText('已识别 2 条已钓获、0 条收藏、0 条提醒。');
  const button=screen.getByRole('button',{name:'导入到本机'});
  expect(button.hasAttribute('disabled')).toBe(true);expect(store.mergeFish).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox',{name:'确认本地导入区服'}));fireEvent.click(button);
  await waitFor(()=>expect(store.mergeFish).toHaveBeenCalledWith(expect.any(String),'cn',false));
});
