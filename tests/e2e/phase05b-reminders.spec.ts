import { expect,test,type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const credentials=JSON.parse(readFileSync(new URL('./.credentials.phase05b.json',import.meta.url),'utf8')) as {token:string;baseUrl:string};
const auth={Authorization:`Bearer ${credentials.token}`};
async function enter(page:Page):Promise<void>{
  await page.goto(credentials.baseUrl);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button',{name:/会话凭证/}).click();
  await page.getByLabel('设备令牌（Bearer）').fill(credentials.token);
  await page.getByRole('button',{name:'保存到会话内存'}).click();
  await page.getByRole('button',{name:/提醒管理 规则/}).click();
  await expect(page.getByRole('button',{name:'新增提醒规则'})).toBeVisible();
}
test('规则增改删、未配置渠道、任务去重及工作台组件',async({page},info)=>{
  test.skip(info.project.name==='mobile-chromium','完整链路在桌面执行');
  const event=await page.request.post(`${credentials.baseUrl}/api/v1/me/events`,{headers:auth,data:{title:'提醒框架验收活动',region:'cn',startsAt:Date.now()+60_000,endsAt:Date.now()+3600_000,operationId:crypto.randomUUID()}});
  expect(event.status()).toBe(201);const record=await event.json() as {event:{id:string}};
  await enter(page);await expect(page.getByRole('button',{name:'订阅当前设备'})).toBeDisabled();
  await page.getByRole('button',{name:'新增提醒规则'}).click();
  await page.getByLabel('提醒目标').selectOption(record.event.id);
  await page.getByLabel('提前分钟').fill('5');
  await page.getByRole('button',{name:'保存提醒规则'}).click();
  const rule=page.getByRole('listitem').filter({hasText:'提醒框架验收活动'});
  await expect(rule).toContainText('提前5分钟');
  await page.getByRole('button',{name:'检查到期任务'}).click();
  await expect(page.getByRole('listitem').filter({hasText:'渠道未就绪'})).toHaveCount(1);
  await page.getByRole('button',{name:'检查到期任务'}).click();
  await expect(page.getByRole('listitem').filter({hasText:'渠道未就绪'})).toHaveCount(1);
  await rule.getByRole('button',{name:'编辑规则'}).click();await page.getByLabel('提前分钟').fill('10');
  await page.getByRole('button',{name:'保存提醒规则'}).click();await expect(rule).toContainText('提前10分钟');
  const created=await page.request.post(`${credentials.baseUrl}/api/v1/me/pages`,{headers:auth,data:{name:'提醒框架验收',operationId:crypto.randomUUID()}});
  const createdPage=await created.json() as {page:{id:string}};
  const widget=await page.request.post(`${credentials.baseUrl}/api/v1/me/pages/${createdPage.page.id}/widgets`,{headers:auth,data:{widgetType:'reminder-manager',operationId:crypto.randomUUID(),config:{}}});
  expect(widget.status()).toBe(201);
  await page.getByRole('button',{name:/自定义工作台 多页面/}).click();await expect(rule).toContainText('提醒框架验收活动');
  await rule.getByRole('button',{name:'删除规则'}).click();await expect(rule).toHaveCount(0);
});
test('窄屏提醒表单可用且不横向溢出',async({page},info)=>{
  test.skip(info.project.name!=='mobile-chromium','窄屏用例');await enter(page);
  await page.getByRole('button',{name:'新增提醒规则'}).click();
  await expect(page.getByLabel('提醒目标')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/phase05b-reminders-mobile.png',fullPage:true});
});

