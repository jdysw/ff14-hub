import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const revisions=JSON.parse(await readFile(new URL('../data/fishing-sources.json',import.meta.url),'utf8'));
if(!['tracker','cn','teamcraft'].every(key=>/^[a-f0-9]{40}$/.test(revisions[key])))throw new Error('Source revisions must be full commit SHAs');
const directory=path.join(root,'.wrangler/fishing-sources');await mkdir(directory,{recursive:true});
const files=[['tracker.js',`icykoneko/ff14-fish-tracker-app/${revisions.tracker}/js/app/data.js`],
  ['guide.js',`icykoneko/ff14-fish-tracker-app/${revisions.tracker}/js/app/fish_info_data.js`],
  ['teamcraft.json',`ffxiv-teamcraft/ffxiv-teamcraft/${revisions.teamcraft}/libs/data/src/lib/json/fishing-log-tracker-page-data.json`],
  ['legendary.json',`ffxiv-teamcraft/ffxiv-teamcraft/${revisions.teamcraft}/libs/data/src/lib/json/legendary-fish.json`]];
for(const name of ['fishing-sources','fishing-log','fishing-spots'])files.push(['tc-'+name+'.json',`ffxiv-teamcraft/ffxiv-teamcraft/${revisions.teamcraft}/libs/data/src/lib/json/${name}.json`]);
for(const sheet of ['Item','ItemUICategory','EventItem','FishParameter','SpearfishingItem','SpearfishingNotebook','IKDSpot','WKSItemInfo','Weather','WeatherRate','FishingSpot','PlaceName','TerritoryType'])files.push([sheet+'.csv',`thewakingsands/ffxiv-datamining-cn/${revisions.cn}/${sheet}.csv`]);
await Promise.all(files.map(async([name,source])=>{
  const response=await fetch('https://raw.githubusercontent.com/'+source,{credentials:'omit',signal:AbortSignal.timeout(90000)});
  if(!response.ok)throw new Error('Source download failed: '+name);
  const bytes=await response.arrayBuffer();if(bytes.byteLength>32*1024*1024)throw new Error('Source too large');
  await writeFile(path.join(directory,name),new Uint8Array(bytes));
}));
const run=(file,args)=>execFileSync(process.execPath,[path.join(root,'scripts',file),...args],{cwd:root,stdio:'inherit'});
const local=name=>path.join(directory,name);
run('prepare-fish-tracker-import.mjs',[local('tracker.js'),'global',revisions.tracker,local('global.json')]);
run('prepare-fish-cn-import.mjs',[local('global.json'),local('tracker.js'),...['Item','FishParameter','Weather','FishingSpot','PlaceName'].map(n=>local(n+'.csv')),revisions.cn,local('cn.json')]);
run('build-fishing-catalog.mjs',[directory,revisions.tracker,revisions.cn,revisions.teamcraft]);
run('audit-fish-intuition.mjs',[local('tracker.js'),path.join(root,'data/fishing-intuition-observations.json')]);
run('audit-fishing-cross-sources.mjs',[directory,path.join(root,'data/fishing-fishcake-observations.json')]);
console.log('Public snapshots generated. Personal progress is stored only in the browser; no database import required.');
