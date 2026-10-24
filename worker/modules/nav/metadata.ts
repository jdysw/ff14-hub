/**
 * 站点公开元数据提取。仅作为「用户明确添加/补全导航」的按需服务，
 * 不在服务器上扫描全站，不保存用户导航，也不代理任意目标响应。
 * SSRF：仅允许公网 DNS 主机的 HTTPS 默认端口；手动验证每次重定向；
 * 禁止 IP 字面量、内网/保留域名，限制跳转、响应字节数和总耗时。
 */
import {stripHtmlTags} from '@ff14-hub/shared';

const MAX_HTML_BYTES=96*1024;
const MAX_REDIRECTS=2;
const BLOCKED_SUFFIXES=['.localhost','.local','.lan','.internal','.invalid','.test','.onion','.home','.home.arpa','.arpa','.example','.nip.io','.sslip.io','.xip.io','.localtest.me','.vcap.me'];
const IPV4_LIKE=/^(?:\d+(?:\.\d+){0,3}|0x[\da-f.]+|0[0-7.]+)$/i;

export interface SiteMetadata {
  title:string;
  description:string;
  iconUrl:string|null;
}

export function safeMetadataTarget(raw:string):URL|null {
  if(raw.length>2048)return null;
  let url:URL;
  try{url=new URL(raw);}catch{return null;}
  if(url.protocol!=='https:'||url.username||url.password||url.port)return null;
  const host=url.hostname.toLowerCase();
  if(host.length>253||host.indexOf('.')<1||host.startsWith('.')||host.endsWith('.'))return null;
  if(host==='localhost'||host.startsWith('[')||host.includes(':')||IPV4_LIKE.test(host))return null;
  if(BLOCKED_SUFFIXES.some(s=>host===s.slice(1)||host.endsWith(s)))return null;
  if(host.split('.').some(label=>!label||label.length>63||!(/^[a-z0-9-]+$/).test(label)||label.startsWith('-')||label.endsWith('-')))return null;
  // 移除个人链接中的任何查询令牌、锚点，不把它们传给第三方。
  url.search='';url.hash='';
  if(url.pathname.length>256)url.pathname='/';
  return url;
}

function decodeEntities(text:string):string{
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_,entity:string)=>{
    const key=entity.toLowerCase();
    if(key.startsWith('#')){
      const code=key.startsWith('#x')?parseInt(key.slice(2),16):parseInt(key.slice(1),10);
      return Number.isInteger(code)&&code>0&&code<=0x10ffff&&!(code>=0xd800&&code<=0xdfff)?String.fromCodePoint(code):'';
    }
    return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '} as Record<string,string>)[key]??'';
  });
}

function normalizeText(value:string,max:number):string{
  return stripHtmlTags(decodeEntities(value)).replace(/[\p{Cc}]+/gu,' ').replace(/\s+/g,' ').trim().slice(0,max);
}

function attributes(tag:string):Record<string,string>{
  const result:Record<string,string>={};
  // 标准 HTML meta/link 属性引号或无引号形式，支持属性任意排列。
  const attribute=/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+))/y;
  const name=/[\w:-]+/y;
  let cursor=0;
  while(cursor<tag.length){
    attribute.lastIndex=cursor;
    const match=attribute.exec(tag);
    if(match){
      result[match[1]!.toLowerCase()]=match[2]??match[3]??match[4]??'';
      cursor=attribute.lastIndex;
      continue;
    }
    // A failed attribute must skip its whole name, rather than retry each suffix.
    name.lastIndex=cursor;
    const candidate=name.exec(tag);
    cursor=candidate?name.lastIndex:cursor+1;
  }
  return result;
}

function sameOriginIcon(raw:string,siteUrl:URL):string|null{
  try{
    const img=new URL(raw,siteUrl);
    if(img.protocol==='https:'&&img.origin===siteUrl.origin&&!img.username&&!img.password&&!img.search&&!img.hash){
      return img.href.slice(0,700);
    }
  }catch{/* 无效图标地址，回退 favicon.ico */}
  return null;
}

function collectMetaText(attr:Record<string,string>,title:string,descriptions:string[]):string{
  const key=(attr['name']??attr['property']??'').toLowerCase();
  if(['description','og:description','twitter:description'].includes(key)&&attr['content']){
    descriptions.push(normalizeText(attr['content'],240));
  }
  if(key==='og:title'&&!title){
    return normalizeText(attr['content']??'',100);
  }
  return title;
}

export function extractSiteMetadata(html:string,siteUrl:URL):SiteMetadata{
  const head=html.split(/<\/head\s*>/i)[0]!.slice(0,MAX_HTML_BYTES);
  const desc:string[]=[];
  let title='', iconUrl:string|null=null;
  const titleMatch=head.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i);
  if(titleMatch)title=normalizeText(titleMatch[1]??'',100);
  for(const match of head.matchAll(/<(?:meta|link)\b[^>]*>/gi)){
    const tag=match[0], attr=attributes(tag);
    if(/^<meta\b/i.test(tag)){
      title=collectMetaText(attr,title,desc);
    }else if(!iconUrl&&/(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/i.test(attr['rel']??'')&&attr['href']){
      iconUrl=sameOriginIcon(attr['href'],siteUrl);
    }
  }
  return {title,description:desc.find(Boolean)??'',iconUrl};
}

async function readHead(response:Response):Promise<string>{
  if(!response.body)return '';
  const reader=response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder=new TextDecoder();
  let bytes=0,text='';
  try{
    while(true){
      const {done,value}:ReadableStreamReadResult<Uint8Array>=await reader.read();
      if(done)break;
      const left=Math.max(0,MAX_HTML_BYTES-bytes);
      const slice=value.subarray(0,left);
      bytes+=slice.byteLength;
      text+=decoder.decode(slice,{stream:true});
      if(/<\/head\s*>/i.test(text))break;
      if(slice.byteLength<value.byteLength||bytes>=MAX_HTML_BYTES)
        throw new Error('website HTML exceeded metadata size cap');
    }
    text+=decoder.decode();
  }finally{await reader.cancel().catch(()=>{});}
  return text;
}

function metadataRedirect(response:Response,current:URL,target:URL,attempt:number):URL{
  const next=response.headers.get('Location');
  if(!next||attempt===MAX_REDIRECTS){
    throw new Error('网站重定向次数过多');
  }
  const redirected=safeMetadataTarget(new URL(next,current).href);
  // 避免跨站重定向使公共元数据接口变成更广泛的探测器。
  if(!redirected||redirected.hostname!==target.hostname){
    throw new Error('网站重定向到其他域名，已停止自动获取');
  }
  return redirected;
}

export async function fetchSiteMetadata(raw:string,fetcher:typeof fetch=fetch):Promise<SiteMetadata>{
  const target=safeMetadataTarget(raw);
  if(!target)throw new Error('仅支持公开 HTTPS 网站，不能查询内部网络或 IP 地址');
  let current=target;
  const abort=new AbortController();
  const timer=setTimeout(()=>abort.abort(),5000);
  try{
    for(let i=0;i<=MAX_REDIRECTS;i++){
      const response=await fetcher(current.href,{
        method:'GET',redirect:'manual',signal:abort.signal,
        headers:{'Accept':'text/html','Range':`bytes=0-${MAX_HTML_BYTES-1}`},
      });
      if(response.status>=300&&response.status<400){
        current=metadataRedirect(response,current,target,i);
        continue;
      }
      if(!response.ok)throw new Error(`网站返回 HTTP ${response.status}`);
      const type=response.headers.get('Content-Type')?.toLowerCase()??'';
      if(!type.includes('text/html')&&!type.includes('application/xhtml+xml'))
        throw new Error('网站没有返回 HTML 页面');
      // 很多站点的全文很大，但元数据在 head 开头；只流式读取前 96 KiB。
      return extractSiteMetadata(await readHead(response),current);
    }
  }finally{clearTimeout(timer);}
  throw new Error('无法读取网页元数据');
}
