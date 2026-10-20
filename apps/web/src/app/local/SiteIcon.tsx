import {useMemo,useState} from 'react';

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
  const sourceKey=sources.join('|');
  const [errorState,setErrorState]=useState({sourceKey,index:0});
  // 原站更换图标时无需额外 effect：显示逻辑自动从新候选的首项开始。
  const index=errorState.sourceKey===sourceKey?errorState.index:0;
  const source=sources[index];
  return <span className="local-directory__monogram" aria-hidden="true">
    {source?<img src={source} alt="" referrerPolicy="no-referrer" loading="lazy"
      onError={()=>setErrorState({sourceKey,index:index+1})}/>:<span className="local-directory__initial">{title.trim().slice(0,1)||'·'}</span>}
  </span>;
}
