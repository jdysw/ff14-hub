import {useState} from 'react';
import {usePrivateDraft} from '../pwa/draft-registry';
import {localLinkSchema,type LocalData,type LocalStore} from './store';
import {fetchNavigationMetadata} from './nav-metadata';
import {SiteIcon} from './SiteIcon';

type SavedLink=LocalData['links'][number];
const editableLink=(link:SavedLink)=>JSON.stringify([link.url,link.title,link.category,link.description??'',link.faviconUrl??'']);

/** 个人网站可直接调整简介，自动识别只是草稿，只有用户按保存才更新本机。 */
export function LocalLinkEditor({link,store}: Readonly<{link:SavedLink;store:LocalStore}>){
  const [source,setSource]=useState(link);
  const [title,setTitle]=useState(link.title);
  const [category,setCategory]=useState(link.category);
  const [description,setDescription]=useState(link.description??'');
  const [faviconUrl,setFaviconUrl]=useState(link.faviconUrl);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const dirty=title!==source.title||category!==source.category||description!==(source.description??'')||faviconUrl!==source.faviconUrl;
  usePrivateDraft(dirty||busy);
  if(!dirty&&source!==link){setTitle(link.title);setCategory(link.category);setDescription(link.description??'');setFaviconUrl(link.faviconUrl);setSource(link);}

  const run=async(task:()=>Promise<void>)=>{
    if(busy)return;
    setBusy(true);setMessage('');
    try{await task();}catch(error){setMessage(error instanceof Error?error.message:'操作失败，请重试');}
    finally{setBusy(false);}
  };
  const identify=()=>void run(async()=>{
    const result=await fetchNavigationMetadata(link.url);
    if(result.title&&!title.trim())setTitle(result.title);
    if(result.description)setDescription(result.description);
    if(result.iconUrl)setFaviconUrl(result.iconUrl);
    setMessage(result.description?'已识别网站简介，点击「保存修改」生效。':'网站未提供可识别的简介，可手动填写。');
  });
  const save=()=>void run(async()=>{
    const next=localLinkSchema.parse({
      ...link,title:title.trim(),category:category.trim(),description:description.trim(),
      ...(faviconUrl?{faviconUrl}:{}),
    });
    await store.change(document=>{
      const current=document.data.links.find(item=>item.id===link.id);
      if(!current||editableLink(current)!==editableLink(source))throw new Error('此网站已被同步更新或删除，请重新打开个人导航核对；当前输入尚未保存。');
      if(current){current.title=next.title;current.category=next.category;
        if(next.category!==link.category)current.categoryCustomized=true;
        if(next.description!==undefined)current.description=next.description;
        else delete current.description;
        if(next.faviconUrl)current.faviconUrl=next.faviconUrl;else delete current.faviconUrl;}
    });
    setSource(next);
    setMessage('已保存到本机。');
  });
  const remove=()=>void run(async()=>{
    await store.change(document=>{document.data.links=document.data.links.filter(item=>item.id!==link.id);});
  });

  return <li className="local-settings__link-item">
    <SiteIcon url={link.url} title={link.title} faviconUrl={link.faviconUrl}/>
    <div className="local-settings__link-main">
      <strong>{link.title}</strong>
      <small>{link.category} · {new URL(link.url).hostname}</small>
      {link.description?<p>{link.description}</p>:<small>暂无简介，可自动识别或手动填写</small>}
      <details className="local-settings__link-editor">
        <summary>编辑网站资料</summary>
        <label className="local-settings__field">网站名称{' '}<input value={title} onChange={event=>setTitle(event.target.value)} maxLength={100}/>
        </label>
        <label className="local-settings__field">分类{' '}<input value={category} onChange={event=>setCategory(event.target.value)} maxLength={60}/>
        </label>
        <label className="local-settings__field">网站简介{' '}<textarea value={description} onChange={event=>setDescription(event.target.value)} maxLength={240} rows={3}/>
        </label>
        <div className="local-settings__link-actions">
          <button type="button" disabled={busy} onClick={identify}>自动识别简介与图标</button>
          <button type="button" disabled={busy||!title.trim()} onClick={save}>保存修改</button>
          <button type="button" disabled={busy} onClick={remove}>移除网站</button>
        </div>
        {message?<output style={{display:'block'}}>{message}</output>:null}
      </details>
    </div>
  </li>;
}
