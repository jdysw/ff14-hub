import { expect,test,type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const credentials=JSON.parse(readFileSync(new URL('./.credentials.phase05.json',import.meta.url),'utf8')) as {token:string;baseUrl:string};
async function enter(page:Page):Promise<void>{
  await page.goto(credentials.baseUrl);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button',{name:/会话凭证/}).click();
  await page.getByLabel('设备令牌（Bearer）').fill(credentials.token);
  await page.getByRole('button',{name:'保存到会话内存'}).click();
  await page.getByRole('button',{name:/^钓鱼手账/}).click();
  await expect(page.getByText('示例·海港鱼（非真实鱼类）',{exact:true})).toBeVisible();
}
test('钓鱼三字段独立、区服隔离、跨会话同步与禁用门禁',async({browser,page},testInfo)=>{
  test.skip(testInfo.project.name==='mobile-chromium','完整链路在桌面执行；独立窄屏用例随后执行');
  await enter(page);
  const caught=page.getByRole('button',{name:'已钓获',exact:true});
  const pinned=page.getByRole('button',{name:'收藏',exact:true});
  await caught.click();await expect(caught).toHaveAttribute('aria-pressed','true');
  await expect(pinned).toHaveAttribute('aria-pressed','false');
  await pinned.click();await expect(pinned).toHaveAttribute('aria-pressed','true');
  await page.getByLabel('钓鱼区服').selectOption('global');
  await expect(caught).toHaveAttribute('aria-pressed','false');
  await page.getByLabel('钓鱼区服').selectOption('cn');
  await expect(caught).toHaveAttribute('aria-pressed','true');
  const second=await browser.newContext();const other=await second.newPage();await enter(other);
  await expect(other.getByRole('button',{name:'已钓获',exact:true})).toHaveAttribute('aria-pressed','true');
  await other.getByRole('button',{name:'已钓获',exact:true}).click();
  await expect(other.getByRole('button',{name:'已钓获',exact:true})).toHaveAttribute('aria-pressed','false');
  await page.getByRole('button',{name:'刷新数据',exact:true}).click();
  await expect(caught).toHaveAttribute('aria-pressed','false');
  await expect(pinned).toHaveAttribute('aria-pressed','true');
  const created=await page.request.post(`${credentials.baseUrl}/api/v1/me/pages`,{headers:{Authorization:`Bearer ${credentials.token}`},data:{name:'钓鱼验收',operationId:crypto.randomUUID()}});
  expect(created.status()).toBe(201);
  const createdPage=await created.json() as {page:{id:string}};
  const widget=await page.request.post(`${credentials.baseUrl}/api/v1/me/pages/${createdPage.page.id}/widgets`,{headers:{Authorization:`Bearer ${credentials.token}`},data:{widgetType:'fishing-windows',operationId:crypto.randomUUID(),config:{region:'cn',hours:1}}});
  expect(widget.status()).toBe(201);
  await page.getByRole('button',{name:/^自定义工作台/}).click();
  await expect(page.getByText('示例·海港鱼（非真实鱼类）',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'收藏',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/phase05-fishing-mobile.png',fullPage:true});
  const response=await page.request.patch(`${credentials.baseUrl}/api/v1/me/modules/ff14.fishing`,{headers:{Authorization:`Bearer ${credentials.token}`},data:{action:'disable',expectedRevision:1}});
  expect(response.status()).toBe(200);
  const denied=await page.request.get(`${credentials.baseUrl}/api/v1/me/fish-progress?region=cn`,{headers:{Authorization:`Bearer ${credentials.token}`}});
  expect(denied.status()).toBe(403);
  await second.close();
});
test('窄屏钓鱼视图没有横向溢出，区服与进度控件可访问',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='mobile-chromium','窄屏用例');
  const enabled=await page.request.patch(`${credentials.baseUrl}/api/v1/me/modules/ff14.fishing`,{headers:{Authorization:`Bearer ${credentials.token}`},data:{action:'enable',expectedRevision:2}});
  expect(enabled.status()).toBe(200);
  await enter(page);
  await expect(page.getByLabel('钓鱼区服')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/phase05-fishing-mobile.png',fullPage:true});
});


test('未连接工作空间时首页直接进入公开钓鱼中心',async({page})=>{
  await page.goto(credentials.baseUrl);
  await expect(page.getByText('无需连接工作空间即可查看鱼窗；个人钓获记录与云同步仍需连接。')).toBeVisible();
  await expect(page.getByRole('button',{name:/连接工作空间/})).toHaveCount(0);
  await page.getByRole('button',{name:/进入钓鱼中心/}).click();
  await expect(page.getByRole('heading',{name:'钓鱼手账'})).toBeVisible();
  await expect(page.getByLabel('钓鱼区服')).toBeVisible();
});
