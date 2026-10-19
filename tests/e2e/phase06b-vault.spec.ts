import { expect,test,type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const credentials=JSON.parse(readFileSync(new URL('./.credentials.phase06b.json',import.meta.url),'utf8')) as {token:string;baseUrl:string;workspaceId:string};
const VAULT_DB='ff14-hub-client-vault';
const PASSWORD='e2e-only-dav-password-9f3a';
const DAV_URL='https://dav.e2e.test/remote.php/dav/files/e2e/';

async function enter(page:Page):Promise<void>{
  await page.goto(credentials.baseUrl);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button',{name:/会话凭证/}).click();
  await page.getByLabel('设备令牌（Bearer）').fill(credentials.token);
  await page.getByRole('button',{name:'保存到会话内存'}).click();
  await page.getByRole('navigation',{name:'系统级入口（不可移除）'}).getByRole('button',{name:/数据同步/}).click();
  await expect(page.getByRole('heading',{name:'本机 WebDAV 档案'})).toBeVisible();
}

async function fillVault(page:Page):Promise<void>{
  await page.getByLabel('档案名称').fill('E2E 本机档案');
  await page.getByLabel(/WebDAV 地址/).fill(DAV_URL);
  await page.getByLabel('WebDAV 用户名').fill('dav-e2e-user');
  await page.getByLabel(/WebDAV 口令/).fill(PASSWORD);
}

/** 直接读真实 IndexedDB：证明密钥确实不可导出、记录确实是密文。 */
async function inspectVault(page:Page):Promise<{extractable:boolean;algorithm:string;usages:string[];exportKey:string;recordCount:number;recordsJson:string}>{
  return await page.evaluate(async (databaseName)=>{
    const openDatabase=():Promise<IDBDatabase>=>new Promise<IDBDatabase>((resolve,reject)=>{
      const request=indexedDB.open(databaseName,1);request.onsuccess=()=>{resolve(request.result);};request.onerror=()=>{reject(new Error('open failed'));};
    });
    const database=await openDatabase();
    const readKey=():Promise<CryptoKey>=>new Promise<CryptoKey>((resolve,reject)=>{
      const request=database.transaction('keys','readonly').objectStore('keys').get('master');
      request.onsuccess=()=>{resolve(request.result as CryptoKey);};request.onerror=()=>{reject(new Error('key read failed'));};
    });
    const readRecords=():Promise<unknown[]>=>new Promise<unknown[]>((resolve,reject)=>{
      const request=database.transaction('records','readonly').objectStore('records').getAll();
      request.onsuccess=()=>{resolve(request.result as unknown[]);};request.onerror=()=>{reject(new Error('records read failed'));};
    });
    const key=await readKey();
    let exportKey='rejected';
    try{await crypto.subtle.exportKey('raw',key);exportKey='succeeded';}catch{/* 不可导出：保持 rejected。 */}
    const records=await readRecords();
    return {extractable:key.extractable,algorithm:key.algorithm.name,usages:[...key.usages],exportKey,recordCount:records.length,recordsJson:JSON.stringify(records)};
  },VAULT_DB);
}

test('本机保险箱：真实 IndexedDB 重载后仍可解密，密钥不可导出，页面不发 DAV 请求',async({page},info)=>{
  test.skip(info.project.name!=='desktop-chromium','完整链路在桌面执行');
  const outbound:string[]=[];
  page.on('request',(request)=>{outbound.push(request.url());});
  await enter(page);
  await expect(page.getByText(/不会发起任何 WebDAV 网络请求/)).toBeVisible();

  await fillVault(page);
  await page.getByRole('button',{name:'加密保存到本机'}).click();
  await expect(page.getByText(/已在本机加密保存该档案/)).toBeVisible();
  // 保存后口令输入框立即清空，页面与存储里都不应出现口令或用户名。
  await expect(page.getByLabel(/WebDAV 口令/)).toHaveValue('');
  expect(await page.content()).not.toContain(PASSWORD);
  const saved=await inspectVault(page);
  expect(saved.recordCount).toBe(1);
  expect(saved.recordsJson).not.toContain(PASSWORD);
  expect(saved.recordsJson).not.toContain('dav-e2e-user');
  expect(saved.recordsJson).not.toContain(credentials.token);

  // 真实刷新：IndexedDB 仍然保有可解密记录（不是内存态）。
  await page.reload();
  await enter(page);
  await expect(page.getByText('E2E 本机档案')).toBeVisible();
  await expect(page.getByText(DAV_URL)).toBeVisible();
  await page.getByRole('button',{name:'校验可解密'}).click();
  await expect(page.getByText('可解密（仅校验，未显示口令）')).toBeVisible();
  expect(await page.content()).not.toContain(PASSWORD);

  // 密钥：非导出、AES-GCM，且 exportKey 被拒绝。
  const probe=await inspectVault(page);
  expect(probe.extractable).toBe(false);
  expect(probe.algorithm).toBe('AES-GCM');
  expect([...probe.usages].sort()).toEqual(['decrypt','encrypt']);
  expect(probe.exportKey).toBe('rejected');

  // 本阶段没有任何 DAV 网络请求，也没有把凭证发给 Hub。
  expect(outbound.some((url)=>url.startsWith('https://dav.e2e.test'))).toBe(false);
  expect(outbound.every((url)=>url.startsWith(credentials.baseUrl))).toBe(true);

  // 删除需要显式确认；删除后本机记录清空。
  await expect(page.getByRole('button',{name:'删除本机档案'})).toBeDisabled();
  await page.getByLabel(/我已确认要删除本机档案/).check();
  await page.getByRole('button',{name:'删除本机档案'}).click();
  await expect(page.getByText('本机没有该区服的档案。')).toBeVisible();
  expect((await inspectVault(page)).recordCount).toBe(0);
});

test('窄屏下本机档案面板可用且无横向溢出',async({page},info)=>{
  test.skip(info.project.name!=='mobile-chromium','窄屏用例');
  await enter(page);
  await expect(page.getByRole('heading',{name:'本机 WebDAV 档案'})).toBeVisible();
  await fillVault(page);
  await page.getByRole('button',{name:'加密保存到本机'}).click();
  await expect(page.getByText(/已在本机加密保存该档案/)).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/phase06b-vault-mobile.png',fullPage:true});
});

