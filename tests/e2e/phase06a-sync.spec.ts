import { expect,test,type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const credentials=JSON.parse(readFileSync(new URL('./.credentials.phase06a.json',import.meta.url),'utf8')) as {token:string;baseUrl:string};
async function enter(page:Page):Promise<void>{
  await page.goto(credentials.baseUrl);await page.getByRole('button',{name:/会话凭证/}).click();
  await page.getByLabel('设备令牌（Bearer）').fill(credentials.token);await page.getByRole('button',{name:'保存到会话内存'}).click();
  await page.getByRole('button',{name:/数据同步 鱼糕/}).click();await expect(page.getByRole('heading',{name:'数据同步',exact:true})).toBeVisible();
}
async function download(page:Page,label:string):Promise<unknown>{
  const [file]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:label,exact:true}).click()]);
  const path=await file.path();if(path===null)throw new Error('download unavailable');return JSON.parse(readFileSync(path,'utf8')) as unknown;
}
async function confirm(page:Page):Promise<void>{
  await expect(page.getByRole('button',{name:'应用同步变更'})).toBeDisabled();await download(page,'下载变更前备份');
  await page.getByLabel('我已核对区服与变更，确认应用').check();
  await page.getByRole('button',{name:'应用同步变更'}).click();await expect(page.getByText('已写入4项字段变化，审计记录已保存。')).toBeVisible();
}
test('三集合导入、未知字段保留、备份门禁、跨客户端和撤销',async({page,browser},info)=>{
  test.skip(info.project.name==='mobile-chromium','完整链路在桌面执行');await enter(page);
  const source={completed:[9000001,9999999],pinned:[9000001],alarmFish:[9999999],future:{note:'extension-marker'}};
  await page.getByLabel('鱼糕JSON内容').fill(JSON.stringify(source));await page.getByRole('button',{name:'预览导入'}).click();
  await expect(page.getByRole('heading',{name:'变更预览：4项'})).toBeVisible();await confirm(page);
  expect(await download(page,'导出当前进度')).toEqual(source);
  const response=await page.request.get(`${credentials.baseUrl}/api/v1/me/fish-sync?region=cn`,{headers:{Authorization:`Bearer ${credentials.token}`}});
  expect((await response.text()).includes('extension-marker')).toBe(false);
  const otherContext=await browser.newContext();const other=await otherContext.newPage();await enter(other);
  expect(await download(other,'导出当前进度')).toEqual({completed:[9000001,9999999],pinned:[9000001],alarmFish:[9999999]});await otherContext.close();
  await page.getByRole('button',{name:'预览撤销'}).first().click();await expect(page.getByRole('heading',{name:'变更预览：4项'})).toBeVisible();await confirm(page);
  expect(await download(page,'导出当前进度')).toEqual({...source,completed:[],pinned:[],alarmFish:[]});
});
test('窄屏导入入口可用，非法输入不发送预览请求',async({page},info)=>{
  test.skip(info.project.name!=='mobile-chromium','窄屏用例');await enter(page);
  let writes=0;page.on('request',(request)=>{if(request.url().endsWith('/fish-sync/preview'))writes+=1;});
  await page.getByLabel('鱼糕JSON内容').fill('{"completed":[]}');await page.getByRole('button',{name:'预览导入'}).click();await expect(page.getByRole('alert')).toBeVisible();
  expect(writes).toBe(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/phase06a-sync-mobile.png',fullPage:true});
});
