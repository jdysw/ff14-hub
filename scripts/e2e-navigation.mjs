/** Real browser + local Worker/D1 acceptance; synthetic owner, no production credentials. */
import {spawn,spawnSync} from 'node:child_process';
import {randomBytes,createHash,createHmac,pbkdf2Sync} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import path from 'node:path';

const base='http://127.0.0.1:8903';
const wrangler=path.resolve('node_modules/wrangler/bin/wrangler.js');
const state=path.resolve('.wrangler/navigation-e2e-'+Date.now());
await mkdir(state,{recursive:true});
const secret='e2e-only-'+randomBytes(32).toString('hex');
const password='e2e-only-'+randomBytes(24).toString('hex');
const seed=randomBytes(20),salt=randomBytes(16),iv=randomBytes(12);
const key=await crypto.subtle.importKey('raw',createHash('sha256').update('ff14-hub/calendar-admin/totp/v1/'+secret).digest(),'AES-GCM',false,['encrypt']);
const ciphertext=Buffer.from(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,seed));
const pepper=createHash('sha256').update('ff14-hub/calendar-admin/password/v2/'+secret).digest();
const passwordHash='pbkdf2-sha256-100k-hmac-v2:'+createHmac('sha256',pepper).update(pbkdf2Sync(password,salt,100000,32,'sha256')).digest('hex');
function cli(args){const result=spawnSync(process.execPath,[wrangler,...args],{encoding:'utf8',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});if(result.status!==0)throw new Error('Local Wrangler command failed: '+result.stdout+result.stderr);}
cli(['d1','migrations','apply','DB','--local','--env=','--persist-to',state]);
const sql=`INSERT INTO calendar_admin_accounts(id,username,password_salt,password_hash,totp_ciphertext,activated_at,created_at) VALUES('owner','e2e_owner','${salt.toString('hex')}','${passwordHash}','${iv.toString('base64')}:${ciphertext.toString('base64')}',1,1);`;
await writeFile(path.join(state,'owner.sql'),sql);
cli(['d1','execute','DB','--local','--env=','--persist-to',state,'--file',path.join(state,'owner.sql')]);
const server=spawn(process.execPath,[wrangler,'dev','--local','--env=','--port','8903','--persist-to',state,'--var','BOOTSTRAP_SECRET:'+secret],{stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
let output='';server.stdout.on('data',chunk=>{output=(output+chunk.toString()).slice(-5000);});server.stderr.on('data',chunk=>{output=(output+chunk.toString()).slice(-5000);});
let browser;
try{
  let ready=false;
  for(let n=0;n<100;n++){try{const response=await fetch(base+'/api/v1/health');if(response.ok){ready=true;break;}}catch{/* wait for our local worker */}await new Promise(resolve=>setTimeout(resolve,200));}
  assert.equal(ready,true,'Local Worker failed to start: '+output);
  browser=await chromium.launch({headless:true,args:['--no-proxy-server']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage();const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
  await page.goto(base,{waitUntil:'domcontentloaded'});
  const directory=page.getByRole('region',{name:'导航站',exact:true});
  await expect(directory.getByRole('link',{name:'鱼糕',exact:true})).toBeVisible({timeout:30000});
  await page.getByRole('searchbox',{name:'搜索导航中的网站、攻略或工具'}).fill('警察网');
  await expect(directory.getByRole('link',{name:'警察网',exact:true})).toBeVisible();
  await directory.getByRole('button',{name:'清空筛选',exact:true}).click();
  await directory.getByLabel('适用区服').selectOption('cn');
  await expect(directory.getByRole('link',{name:'Reddit/FFXIV',exact:true})).toHaveCount(0);
  await directory.getByRole('button',{name:'清空筛选',exact:true}).click();
  const observed=[];page.on('request',request=>observed.push({url:request.url(),method:request.method()}));
  await directory.getByRole('button',{name:'收藏 鱼糕',exact:true}).click();
  await expect(directory.getByRole('button',{name:'取消收藏 鱼糕',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.reload({waitUntil:'domcontentloaded'});
  await expect(directory.getByRole('button',{name:'取消收藏 鱼糕',exact:true})).toHaveAttribute('aria-pressed','true');
  assert.equal(observed.some(request=>request.method!=='GET'),false,'Personal favorites must stay local');
  const peer=await context.newPage();await peer.goto(base,{waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'设置',exact:true}).click();
  for(let n=0;n<5;n++)await page.getByRole('button',{name:'我的设置',exact:true}).click();
  await page.getByLabel('管理员账号').fill('e2e_owner');await page.getByLabel('管理员密码').fill(password);
  const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
  const digest=createHmac('sha1',seed).update(counter).digest(),offset=digest.at(-1)&15;
  const code=String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
  await page.getByLabel('身份验证器（TOTP）').fill(code);
  let adminToken='';
  page.on('response',response=>{if(response.url()===base+'/api/v1/admin/login'&&response.ok())void response.json().then(data=>{adminToken=data.token;});});
  await page.getByRole('button',{name:'安全登录',exact:true}).click();
  await page.getByRole('button',{name:'网站目录',exact:true}).click();
  const admin=page.getByRole('region',{name:'网站目录管理',exact:true});
  await admin.getByRole('button',{name:'新增网站',exact:true}).click();
  await admin.getByLabel('网站名称',{exact:true}).fill('浏览器验收网站');
  await admin.getByLabel('HTTPS 地址',{exact:true}).fill('https://example.org/navigation-acceptance');
  await admin.getByLabel('分类',{exact:true}).fill('测试分类');
  await admin.getByLabel('搜索别名（逗号分隔）').fill('独特别名,第二别名');
  await admin.getByRole('button',{name:'保存到服务器',exact:true}).click();
  await expect(admin.getByRole('status')).toContainText('已保存到服务器');
  await admin.getByRole('button',{name:'重新读取列表',exact:true}).click();
  await expect(admin.getByRole('button',{name:'编辑 浏览器验收网站',exact:true})).toBeVisible();
  await peer.reload({waitUntil:'domcontentloaded'});
  await peer.getByRole('searchbox',{name:'搜索导航中的网站、攻略或工具'}).fill('独特别名');
  await expect(peer.getByRole('link',{name:'浏览器验收网站',exact:true})).toBeVisible();
  // A failed backend must keep the form and never publish a success message.
  await admin.getByRole('button',{name:'编辑 浏览器验收网站',exact:true}).click();
  await admin.getByLabel('网站名称',{exact:true}).fill('修订后网站');
  await page.route('**/api/v1/admin/navigation/items/*',route=>route.request().method()==='PUT'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'测试服务暂时不可用'}})}):route.continue());
  await admin.getByRole('button',{name:'保存到服务器',exact:true}).click();
  await expect(admin.getByRole('alert')).toContainText('暂时不可用');
  await expect(admin.getByLabel('网站名称',{exact:true})).toHaveValue('修订后网站');
  await page.unroute('**/api/v1/admin/navigation/items/*');
  await admin.getByRole('button',{name:'保存到服务器',exact:true}).click();
  await expect(admin.getByRole('button',{name:'下架 修订后网站',exact:true})).toBeVisible();
  await admin.getByRole('button',{name:'下架 修订后网站',exact:true}).click();
  await admin.getByRole('button',{name:'确认下架',exact:true}).click();
  await expect(admin.getByRole('button',{name:'恢复 修订后网站',exact:true})).toBeVisible();
  await peer.reload({waitUntil:'domcontentloaded'});
  await expect(peer.getByRole('link',{name:'修订后网站',exact:true})).toHaveCount(0);
  await admin.getByRole('button',{name:'恢复 修订后网站',exact:true}).click();
  await expect(admin.getByRole('button',{name:'下架 修订后网站',exact:true})).toBeVisible();
  await peer.reload({waitUntil:'domcontentloaded'});await expect(peer.getByRole('link',{name:'修订后网站',exact:true})).toBeVisible();
  await admin.screenshot({path:'.wrangler/navigation-admin-desktop.png'});
  for(const width of [390,320]){
    await page.setViewportSize({width,height:844});await peer.setViewportSize({width,height:844});
    await admin.scrollIntoViewIfNeeded();assert.equal(await page.evaluate('document.documentElement.scrollWidth>innerWidth'),false);
    await peer.locator('#local-navigation').scrollIntoViewIfNeeded();assert.equal(await peer.evaluate('document.documentElement.scrollWidth>innerWidth'),false);
    await peer.screenshot({path:`.wrangler/navigation-mobile-${width}.png`});
  }
  // Inspect the durable record independently of the browser component state.
  const publicRecords=await (await fetch(base+'/api/v1/navigation/catalog')).json();
  const saved=publicRecords.entries.find(entry=>entry.title==='修订后网站');assert.ok(saved);
  const authorized=await fetch(base+'/api/v1/admin/navigation/items',{headers:{Authorization:'Bearer '+adminToken}});
  assert.equal(authorized.status,200);const persisted=(await authorized.json()).records.find(record=>record.entry.id===saved.id);assert.equal(persisted.revision,4);
  await page.getByRole('button',{name:'安全退出',exact:true}).click();
  await expect(page.getByRole('heading',{name:'站点管理员登录',exact:true})).toBeVisible();
  assert.equal((await fetch(base+'/api/v1/admin/navigation/items',{headers:{Authorization:'Bearer '+adminToken}})).status,401);
  assert.deepEqual(pageErrors,[]);
  console.log(JSON.stringify({passed:true,publicEntries:publicRecords.entries.length,checks:['real password+TOTP owner login','category and region controls','aliases search','local favorites survive reload without uploads','create/edit/hide/restore persist in D1','second page sees backend changes','503 retains draft','320/390px layout','revoked owner session rejected'],state}));
}finally{
  await browser?.close();
  if(process.platform==='win32'&&server.pid)spawnSync('taskkill',['/PID',String(server.pid),'/T','/F'],{stdio:'ignore'});else server.kill('SIGTERM');
}
