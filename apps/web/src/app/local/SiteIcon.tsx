import {useEffect,useMemo,useState} from 'react';

interface SiteIconProps {
  readonly url:string;
  readonly title:string;
  readonly faviconUrl?:string|undefined;
}

/** 直接向被收藏网站请求 favicon，不经第三方图标采集服务。 */
export function SiteIcon({url,title,faviconUrl}:SiteIconProps){
  const sources=useMemo(()=>{
    try{
      const origin=new URL(url).origin;
      const paths=[faviconUrl,`${origin}/favicon.ico`,`${origin}/apple-touch-icon.png`];
      return [...new Set(paths.filter((item):item is string=>typeof item==='string'&&item.startsWith(origin+'/')))];
    }catch{return [];}
  },[url,faviconUrl]);
  const [index,setIndex]=useState(0);
  useEffect(()=>setIndex(0),[sources]);
  const source=sources[index];
  return <span className="local-directory__monogram" aria-hidden="true">
    {source?<img src={source} alt="" referrerPolicy="no-referrer" loading="lazy"
      onError={()=>setIndex(current=>current+1)}/>:<span className="local-directory__initial">{title.trim().slice(0,1)||'·'}</span>}
  </span>;
}
