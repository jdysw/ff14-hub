import ts from 'typescript';
import {readFile,writeFile} from 'node:fs/promises';
const adapter=(await readFile(new URL('./lib/fishcake-adapter.mjs',import.meta.url),'utf8')).replace(/^export /gm,'');

const tree=ts.createSourceFile('adapter.js',adapter,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const validator=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='fishcakeDocument');
if(!validator){throw new Error('Missing Hub document validator');}
const hubAdapter=validator.getText(tree);

const page=await readFile(new URL('./userscripts/fishcake-page.js',import.meta.url),'utf8');
const runtime=await readFile(new URL('./userscripts/fishcake-runtime.js',import.meta.url),'utf8');
const header=`// ==UserScript==
// @name         FF14 Hub · 鱼糕实时互通
// @namespace    https://ff14.zhixia.uk/
// @version      1.0.1
// @description  在当前浏览器中双向同步钓获、收藏和提醒；首次预览后启用。
// @match        https://fish.ffmomola.com/*
// @match        https://ff14.zhixia.uk/*
// @match        https://ff14-preview.zhixia.uk/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @run-at       document-idle
// @updateURL    https://ff14.zhixia.uk/fishcake-sync.user.js
// @downloadURL  https://ff14.zhixia.uk/fishcake-sync.user.js
// ==/UserScript==
`;
const output=header+`\n(()=>{'use strict';\n${hubAdapter}\nconst PAGE_ADAPTER_SOURCE=${JSON.stringify(adapter+'\n'+page)};\n${runtime}\n})();\n`;
const target=new URL('../apps/web/public/fishcake-sync.user.js',import.meta.url);
if(process.argv.includes('--check')){if(await readFile(target,'utf8')!==output)throw new Error('鱼糕脚本未重新生成');}
else await writeFile(target,output);
