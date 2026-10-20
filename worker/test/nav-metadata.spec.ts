import {describe,it,expect,vi} from 'vitest';
import {extractSiteMetadata,fetchSiteMetadata,safeMetadataTarget} from '../modules/nav/metadata';

describe('navigation metadata extraction safety',()=>{
  it('rejects private/IP/special URL targets and strips query credentials from outbound requests',()=>{
    for(const url of [
      'http://example.org','https://127.0.0.1','https://[::1]/','https://localhost',
      'https://169.254.169.254/latest/meta-data','https://foo.internal',
      'https://127.0.0.1.nip.io','https://foo.localtest.me',
      'https://demo.test','https://alice:secret@example.org',
      'https://example.org:8443','https://0x7f000001',
    ])expect(safeMetadataTarget(url),url).toBeNull();
    expect(safeMetadataTarget('https://www.example.org/home?q=private#secret')?.href)
      .toBe('https://www.example.org/home');
  });
  it('extracts HTML description and same-origin favicon regardless of attribute order',()=>{
    const html=`<html><head>
      <meta content="网站内容 &amp; 工具 &#x2605;" name="description">
      <meta content="另一段描述" property="og:description">
      <title>测试 &amp; 网站</title>
      <link href="/static/site.ico" sizes="any" rel="shortcut icon">
      <link href="https://other.example.org/fake.ico" rel="icon">
    </head><body>ignored</body></html>`;
    expect(extractSiteMetadata(html,new URL('https://www.example.org/'))).toEqual({
      title:'测试 & 网站',description:'网站内容 & 工具 ★',iconUrl:'https://www.example.org/static/site.ico',
    });
  });
  it('does not accept external icons as same-site icons',()=>{
    const info=extractSiteMetadata('<head><link rel="icon" href="http://127.0.0.1/a.ico"><meta property="og:description" content="查找任务"/></head>',new URL('https://example.org/'));
    expect(info.iconUrl).toBeNull();
    expect(info.description).toBe('查找任务');
  });
  it('never follows a redirect to another domain or private target',async()=>{
    const fetcher=vi.fn(async()=>new Response(null,{status:302,headers:{Location:'https://127.0.0.1/admin'}})) as unknown as typeof fetch;
    await expect(fetchSiteMetadata('https://example.org/',fetcher)).rejects.toThrow('重定向到其他域名');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('reads only the head of a large page and never includes query parameters',async()=>{
    const fetcher=vi.fn(async()=>new Response(
      '<head><meta name="description" content="这是一个钓鱼查询工具"></head>'+'x'.repeat(150_000),
      {headers:{'Content-Type':'text/html','Content-Length':'150090'}}
    )) as unknown as typeof fetch;
    const info=await fetchSiteMetadata('https://example.org/tool?auth=private#fragment',fetcher);
    expect(info.description).toBe('这是一个钓鱼查询工具');
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://example.org/tool');
  });
});
