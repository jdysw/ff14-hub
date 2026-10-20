/** 服务端只按用户触发读取公开网页的少量 head 元数据，不抓取个人导航内容。 */
export interface NavigationMetadata {
  title:string;
  description:string;
  iconUrl:string|null;
}

export async function fetchNavigationMetadata(url:string):Promise<NavigationMetadata>{
  const response=await fetch('/api/v1/navigation/metadata',{
    method:'POST',credentials:'omit',redirect:'error',
    headers:{'Content-Type':'application/json','Accept':'application/json'},
    body:JSON.stringify({url}),
  });
  const body:unknown=await response.json();
  if(!response.ok){
    const message=typeof body==='object'&&body!==null&&'message' in body&&typeof body.message==='string'?body.message:'自动识别失败';
    throw new Error(message);
  }
  if(typeof body!=='object'||body===null)throw new Error('网站元数据返回异常');
  const row=body as Record<string,unknown>;
  const title=typeof row['title']==='string'?row['title'].slice(0,100):'';
  const description=typeof row['description']==='string'?row['description'].slice(0,240):'';
  let iconUrl:string|null=null;
  if(typeof row['iconUrl']==='string'){
    try{
      const site=new URL(url),icon=new URL(row['iconUrl']);
      if(icon.protocol==='https:'&&site.origin===icon.origin&&!icon.username&&!icon.password)
        iconUrl=icon.href;
    }catch{/* 不使用可疑图标地址 */}
  }
  return {title,description,iconUrl};
}
