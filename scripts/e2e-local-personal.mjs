import {chromium,expect} from '@playwright/test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const source={completed:Array.from({length:1754},(_,i)=>i+1),pinned:[],alarmFish:[]};
await mkdir('.wrangler',{recursive:true});
await writeFile('.wrangler/local-fishcake-fixture.json',JSON.stringify(source));
const browser=await chromium.launch({headless:true,args:['--no-proxy-server']});
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
 const page=await context.newPage();const requests=[];const errors=[];
 context.on('request',request=>requests.push({url:request.url(),method:request.method(),authorized:Boolean(request.headers().authorization)}));
 page.on('pageerror',error=>errors.push(error.message));
 const search=async(p)=>{if(await p.getByRole('dialog').count()===0){await p.getByRole('button',{name:'全部鱼窗 ↗',exact:true}).click();}const b=p.getByRole('dialog').getByTestId('fishing-board');await b.getByRole('button',{name:'全部鱼类',exact:true}).click();await b.getByRole('searchbox',{name:'搜索鱼类'}).fill('扎尔艾拉');return b;};
 await page.goto('http://127.0.0.1:8897/',{waitUntil:'domcontentloaded'});
 await page.getByRole('button',{name:'全部鱼窗 ↗',exact:true}).waitFor({timeout:60000});
 assert.equal((await page.locator('body').innerText()).includes('工作空间'),false);
 let board=await search(page);
 await board.getByRole('button',{name:'钓获 扎尔艾拉',exact:true}).click();
 await expect(board.getByRole('button',{name:'钓获 扎尔艾拉',exact:true})).toHaveAttribute('aria-pressed','true');
 await board.getByRole('button',{name:'收藏 扎尔艾拉',exact:true}).click();
 await expect(board.getByRole('button',{name:'收藏 扎尔艾拉',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.reload({waitUntil:'domcontentloaded'});board=await search(page);
 await expect(board.getByRole('button',{name:'钓获 扎尔艾拉',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.getByRole('button',{name:'收起钓鱼完整页面',exact:true}).click();
 await page.getByRole('button',{name:'设置',exact:true}).click();
 await page.getByRole('button',{name:'数据管理',exact:true}).click();await page.getByRole('button',{name:'钓鱼导入导出',exact:true}).click();
 await page.getByLabel('鱼糕导出文件',{exact:true}).setInputFiles('.wrangler/local-fishcake-fixture.json');
 await page.getByText('已识别 1754 条已钓获、0 条收藏、0 条提醒。',{exact:true}).waitFor();
 await page.getByRole('checkbox',{name:'确认本地导入区服'}).check();await page.getByRole('button',{name:'导入到本机',exact:true}).click();
 await page.getByRole('status').filter({hasText:'已在本机合并'}).waitFor();
 const exportFish=page.waitForEvent('download');await page.getByRole('button',{name:'导出鱼糕兼容进度'}).click();
 const progress=JSON.parse(await readFile(await (await exportFish).path(),'utf8'));
 assert.equal(progress.completed.length,new Set([...source.completed,7678]).size);
 assert.equal(source.completed.every(id=>progress.completed.includes(id)),true);assert.equal(progress.pinned.includes(7678),true);
 await page.getByRole('button',{name:'个人导航',exact:true}).click();
 await page.getByLabel('网站名称',{exact:true}).fill('本地测试导航');await page.getByLabel('HTTPS 地址',{exact:true}).fill('https://example.com/local-test');await page.getByRole('button',{name:'添加网站',exact:true}).click();
 await page.getByRole('button',{name:'备忘',exact:true}).click();
 await page.getByLabel('标题',{exact:true}).fill('本地备忘');await page.getByLabel('内容',{exact:true}).fill('测试内容保存在当前浏览器');await page.getByRole('button',{name:'添加备忘模块'}).click();
 await page.getByRole('button',{name:'数据管理',exact:true}).click();await page.getByRole('button',{name:'备份与恢复',exact:true}).click();
 const exportAll=page.waitForEvent('download');await page.getByRole('button',{name:'导出全部个人数据'}).click();const backupPath=await (await exportAll).path();const backup=JSON.parse(await readFile(backupPath,'utf8'));
 assert.equal(backup.format,'ff14-hub-local');assert.equal(backup.data.links.some(link=>link.title==='本地测试导航'),true);assert.equal(backup.data.notes.length,1);
 await page.getByRole('button',{name:'个人导航',exact:true}).click();
 const item=page.locator('.local-settings__link-editor').filter({hasText:'本地测试导航'});await item.locator('summary').click();await item.getByRole('button',{name:'移除网站',exact:true}).click();
 await page.getByRole('button',{name:'数据管理',exact:true}).click();await page.getByRole('button',{name:'备份与恢复',exact:true}).click();
 await page.getByLabel('个人备份文件').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
 await page.getByRole('checkbox',{name:'我已导出当前备份，确认恢复所选个人备份'}).check();await page.getByRole('button',{name:'恢复个人备份',exact:true}).click();
 await page.getByText('个人备份已恢复到本机。',{exact:true}).waitFor();await page.getByRole('button',{name:'个人导航',exact:true}).click();await page.getByText('本地测试导航',{exact:true}).waitFor();
 await page.getByRole('button',{name:'返回首页',exact:true}).click();
 await page.getByRole('link',{name:'本地测试导航',exact:true}).waitFor();board=await search(page);
 await expect(board.getByRole('button',{name:'钓获 扎尔艾拉',exact:true})).toHaveAttribute('aria-pressed','true');
 for(const width of [390,320]){await page.setViewportSize({width,height:844});await board.scrollIntoViewIfNeeded();assert.equal(await page.evaluate('document.documentElement.scrollWidth > innerWidth'),false);await page.screenshot({path:`.wrangler/local-fishing-mobile-${width}.png`});}
 // Two tabs mutate the same real IndexedDB concurrently; neither link may be lost.
 const peer=await context.newPage();await peer.goto('http://127.0.0.1:8897/',{waitUntil:'domcontentloaded'});
 await page.getByRole('button',{name:'收起钓鱼完整页面',exact:true}).click();
 await page.getByRole('button',{name:'设置',exact:true}).click();await peer.getByRole('button',{name:'设置',exact:true}).click();
 for(const [tab,title,url] of [[page,'并发标签 A','https://example.com/concurrent-a'],[peer,'并发标签 B','https://example.com/concurrent-b']]){
   await tab.getByRole('button',{name:'个人导航',exact:true}).click();
   await tab.getByLabel('网站名称',{exact:true}).fill(title);await tab.getByLabel('HTTPS 地址',{exact:true}).fill(url);
 }
 await Promise.all([page.getByRole('button',{name:'添加网站',exact:true}).click(),peer.getByRole('button',{name:'添加网站',exact:true}).click()]);
 await page.getByText('并发标签 A',{exact:true}).waitFor();await page.getByText('并发标签 B',{exact:true}).waitFor();
 await page.getByRole('button',{name:'数据管理',exact:true}).click();await page.getByRole('button',{name:'备份与恢复',exact:true}).click();
 const finalDownload=page.waitForEvent('download');await page.getByRole('button',{name:'导出全部个人数据'}).click();
 const finalBackup=JSON.parse(await readFile(await (await finalDownload).path(),'utf8'));
 assert.equal(finalBackup.data.links.filter(link=>link.url.includes('/concurrent-')).length,2);
 // Public app/catalog caches support a subsequent offline visit; personal writes stay in IDB.
 await page.getByRole('button',{name:'返回首页',exact:true}).click();
 await page.waitForFunction('navigator.serviceWorker.controller !== null');
 await context.setOffline(true);await page.reload({waitUntil:'domcontentloaded'});
 const offlineBoard=await search(page);
 const offlinePin=offlineBoard.getByRole('button',{name:'收藏 扎尔艾拉',exact:true});
 await expect(offlinePin).toHaveAttribute('aria-pressed','true');await offlinePin.click();
 await expect(offlinePin).toHaveAttribute('aria-pressed','false');
 await page.reload({waitUntil:'domcontentloaded'});await search(page);
 await expect(offlinePin).toHaveAttribute('aria-pressed','false');
 await context.setOffline(false);
 await page.getByRole('button',{name:'收起钓鱼完整页面',exact:true}).click();
 await page.getByRole('button',{name:'设置',exact:true}).click();
 // Storage denial is visible; the app must not fall back to falsely claiming memory-only saves.
 const denied=await browser.newContext();await denied.addInitScript("Object.defineProperty(window, 'indexedDB', {get(){throw new Error('storage denied');}})");
 const deniedPage=await denied.newPage();await deniedPage.goto('http://127.0.0.1:8897/',{waitUntil:'domcontentloaded'});
 await expect(deniedPage.getByRole('alert')).toContainText('浏览器不支持本地存储');await denied.close();
 assert.equal(requests.some(r=>new URL(r.url).pathname.startsWith('/api/v1/me')||r.authorized),false);
 assert.equal(requests.some(r=>r.method!=='GET'),false);assert.deepEqual(errors,[]);
 // Keep the existing hidden site-owner login, separate from all personal data.
 for(let i=0;i<5;i++)await page.locator('.local-settings__heading-button').click();
 await page.getByRole('heading',{name:'站点管理员登录',exact:true}).waitFor();
 console.log(JSON.stringify({passed:true,importedIds:source.completed.length,checks:['no workspace or credentials','real IndexedDB persistence after reload','1754-entry Fishcake format import','empty favorites retained','Fishcake-compatible export','full backup and restore','navigation and custom notes persistence','concurrent tabs preserve both writes','offline reload and local write','storage denial fails visibly','320/390px layout','no private API or write requests','hidden site-owner login retained']}));
}finally{await browser.close();}
