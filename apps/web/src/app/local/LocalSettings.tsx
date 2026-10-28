
function localSettingsFailure({cause}:Readonly<{cause:unknown}>){
if(cause instanceof ZodError){return '文件或输入格式不正确，请检查后重试；原有数据仍保留。';}
if(cause instanceof Error){return cause.message;}
return '操作失败，原有数据仍保留。';
}
import {forEachSequential} from "../../../../../packages/shared/src/sequential-tasks.mjs";
import {useState} from 'react';
import {ZodError} from 'zod';
import {withHomeModules,type FishRegion} from '@ff14-hub/shared';
import {type LocalData,type LocalStore,type HomeSection,localLinkSchema} from './store';
import {usePrivateDraft} from '../pwa/draft-registry';
import {fetchNavigationMetadata} from './nav-metadata';
import {LocalLinkEditor} from './LocalLinkEditor';
import {DataManagementPanel,type DataSection} from './DataManagementPanel';
import {LocalNotificationPanel} from './LocalNotificationPanel';
import {TodoBoard} from './TodoBoard';
import {clearSavedHomeLayout} from './ModuleGrid';

const labels:Record<HomeSection,string>={events:'国服活动',fishing:'钓鱼',pvp:'PVP 战场',notes:'我的待办',market:'市场行情',weather:'时间与天气'};
export type SettingsTab='home'|'links'|'notes'|'data'|'notifications';
export function LocalSettings({store,data,onSaved,onAdmin,adminAuthenticated=false,initialTab='home',initialDataSection='sync'}:Readonly<{store:LocalStore;data:LocalData;onSaved:()=>void;onAdmin?:()=>void;adminAuthenticated?:boolean;initialTab?:SettingsTab;initialDataSection?:DataSection}>){
  const [activeTab,setActiveTab]=useState<SettingsTab>(initialTab);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [title,setTitle]=useState(''),[url,setUrl]=useState(''),[category,setCategory]=useState('常用网站');
  const [description,setDescription]=useState('');
  const [faviconUrl,setFaviconUrl]=useState<string|undefined>(undefined);
  const [recognizing,setRecognizing]=useState(false);
  usePrivateDraft(Boolean(title||url||description||busy||recognizing));
  const run=async(action:()=>Promise<void>)=>{
    if(busy){return;}setBusy(true);setError(null);setNotice(null);
    try{await action();onSaved();}catch(cause){setError(localSettingsFailure({cause}));}
    finally{setBusy(false);}
  };
  const applyRecognizedDescription=(link:LocalData['links'][number],metadata:Awaited<ReturnType<typeof fetchNavigationMetadata>>,onChanged:()=>void)=>store.change(document=>{
    const current=document.data.links.find(item=>item.id===link.id);
    if(current&&!current.description?.trim()&&current.url===link.url){
      current.description=metadata.description;
      if(metadata.iconUrl){current.faviconUrl=metadata.iconUrl;}
      onChanged();
    }
  });
  const move=(section:HomeSection,delta:number)=>{void run(async()=>{
    await store.change(document=>{const order=withHomeModules(document.data.configuration.order);document.data.configuration.order=order;const index=order.indexOf(section);const other=order[index+delta];if(other){order[index+delta]=section;order[index]=other;document.data.configuration.orderCustomized=true;}});
  });};
  return <div className="local-settings">
    <header className="local-settings__sidebar">
      <h2><button type="button" className="local-settings__heading-button" onClick={onAdmin}>设置</button></h2>
      <nav className="local-settings__tabs" aria-label="设置分类">
        {([['home','首页'],['links','个人导航'],['notes','待办'],['data','数据管理'],['notifications','通知']] as const).map(([value,label])=>
          <button type="button" key={value} aria-current={activeTab===value?'page':undefined}
            className={activeTab===value?'is-active':''} onClick={()=>setActiveTab(value)}>{label}</button>)}
      </nav>
      <button className="local-settings__admin" type="button" onClick={onAdmin}>{adminAuthenticated?'站点管理后台 ↗':'管理员登录 ↗'}</button>
    </header>
    <div className="local-settings__content">
    <div hidden={activeTab!=='data'}><DataManagementPanel store={store} data={data} initialSection={initialDataSection}/></div>
    {activeTab==='notifications'?<LocalNotificationPanel store={store}/>:null}
    {error?<p role="alert" className="notice notice--error">{error}</p>:null}{notice?<output className="notice notice--ok" style={{display:'block'}}>{notice}</output>:null}
    <section hidden={activeTab!=='home'}><h3>首页模块</h3>
      {withHomeModules(data.configuration.order).map((section,index)=><div className="local-settings__module" key={section}>
        <label><input type="checkbox" checked={data.configuration.visible[section]??true} disabled={busy} onChange={event=>{const checked=event.target.checked;void run(async()=>{await store.change(document=>{document.data.configuration.visible[section]=checked;});});}}/>{labels[section]}</label>
        <div><button type="button" disabled={busy||index===0} aria-label={`上移${labels[section]}`} onClick={()=>move(section,-1)}>上移</button><button type="button" disabled={busy||index===withHomeModules(data.configuration.order).length-1} aria-label={`下移${labels[section]}`} onClick={()=>move(section,1)}>下移</button></div>
      </div>)}
      <div className="local-settings__field">
        <p>布局会在本机记住上次的列位置；刷新或更新倒计时不会重新交换模块。调整模块顺序、显示项或屏幕宽度后自动适配。</p>
        <button type="button" disabled={busy} onClick={()=>{clearSavedHomeLayout();setNotice('已清除本机布局记忆，下次打开首页将重新计算排布。');}}>重新计算首页布局</button>
      </div>
      <label className="local-settings__field">默认钓鱼区服<select value={data.configuration.region} disabled={busy} onChange={event=>{const next=event.target.value as FishRegion;void run(async()=>{await store.change(document=>{document.data.configuration.region=next;});});}}><option value="cn">国服</option><option value="global">国际服</option></select></label>
    </section>
    <section hidden={activeTab!=='links'}><h3>个人导航</h3>
      <p className="local-settings__caution">新增网站后可自动提取公开网页简介；获取失败不影响添加。简介支持手动编辑，所有个人资料仅保存于此浏览器。</p>
      <form onSubmit={event=>{event.preventDefault();void run(async()=>{
        // 添加时自动尝试一次：外站拒绝读取或不存在 description 时仍可以正常保存。
        const site=url.trim();
        const detected=description.trim()?null:await fetchNavigationMetadata(site).catch(()=>null);
        const icon=faviconUrl??detected?.iconUrl??undefined;
        const link=localLinkSchema.parse({
          id:crypto.randomUUID(),title:title.trim()||detected?.title||'未命名网站',
          url:site,category:category.trim()||'常用网站',favorite:false,
          description:description.trim()||detected?.description||'',
          ...(icon?{faviconUrl:icon}:{}),
        });
        await store.change(document=>{document.data.links.push(link);});
        setTitle('');setUrl('');setDescription('');setFaviconUrl(undefined);
        if(!link.description){setNotice('已添加网站。自动识别暂未取得简介，可在下方手动补充。');}
      });}}>
        <label className="local-settings__field">网站名称{' '}<input required value={title} onChange={event=>setTitle(event.target.value)} maxLength={100}/>
        </label>
        <label className="local-settings__field">HTTPS 地址{' '}<input required type="url" value={url} onChange={event=>{
            setUrl(event.target.value);setFaviconUrl(undefined);
          }}/>
        </label>
        <label className="local-settings__field">分类{' '}<input value={category} onChange={event=>setCategory(event.target.value)} maxLength={60}/>
        </label>
        <label className="local-settings__field">网页简介{' '}<textarea value={description} onChange={event=>setDescription(event.target.value)}
            rows={3} maxLength={240} placeholder="可手动填写，留空将在添加时自动识别。"/>
        </label>
        <div className="local-settings__link-actions">
          <button type="button" disabled={busy||recognizing||!url.trim()} onClick={()=>{
            setRecognizing(true);setError(null);
            void fetchNavigationMetadata(url.trim()).then(metadata=>{
              if(metadata.title&&!title.trim()){setTitle(metadata.title);}
              if(metadata.description){setDescription(metadata.description);}
              if(metadata.iconUrl){setFaviconUrl(metadata.iconUrl);}
              setNotice(metadata.description?'已提取网站简介，可进一步修改后保存。':'网页没有提供可识别的简介，可自行填写。');
            }).catch(cause=>setError(cause instanceof Error?cause.message:'自动识别失败'))
              .finally(()=>setRecognizing(false));
          }}>{recognizing?'正在识别…':'自动获取简介'}</button>
          <button type="submit" disabled={busy||recognizing}>添加网站</button>
        </div>
      </form>
      <div className="local-settings__link-batch">
        <h4>已添加的网站</h4>
        <button type="button" disabled={busy||recognizing||data.links.every(link=>Boolean(link.description?.trim()))}
          onClick={()=>{void run(async()=>{
            // 单次最多补齐 10 条，避免大规模抓取或突破服务端频率限制。
            const pending=data.links.filter(link=>!link.description?.trim()).slice(0,10);
            let updated=0;
            const countUpdated=()=>{updated++;};
            await forEachSequential(pending,async (link)=>{
              const metadata=await fetchNavigationMetadata(link.url).catch(()=>null);
              if(!metadata?.description){return;}
              await applyRecognizedDescription(link,metadata,countUpdated);
            });
            setNotice(`补全 ${updated} 条简介；未识别的网站仍可手动编辑。`);
          });}}>批量补全缺失简介（每次最多 10 条）</button>
      </div>
      <ul className="local-settings__items local-settings__link-list">
        {data.links.map(link=><LocalLinkEditor key={link.id} link={link} store={store}/>)}
      </ul>
    </section>
    <section hidden={activeTab!=='notes'}><TodoBoard data={data} store={store} expanded/></section>
    </div>
  </div>;
}
