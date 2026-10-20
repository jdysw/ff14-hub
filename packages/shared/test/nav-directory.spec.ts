import {describe,expect,it} from 'vitest';
import {canonicalNavUrl,matchesDirectorySearch} from '../src/nav-directory';
describe('目录定位与保守去重',()=>{
  it('去除跟踪参数和默认端口，保留功能参数、路径及 hash 路由',()=>{
    expect(canonicalNavUrl('https://EXAMPLE.com:443/?utm_source=x')).toBe('https://example.com/');
    expect(canonicalNavUrl('https://example.com/?b=2&a=1&spm=x')).toBe('https://example.com/?a=1&b=2');
    expect(canonicalNavUrl('https://example.com/#/')).toBe('https://example.com/');
    expect(canonicalNavUrl('https://example.com/#/cal')).not.toBe(canonicalNavUrl('https://example.com/#/workshop'));
    expect(canonicalNavUrl('https://example.com/read.php?tid=1')).not.toBe(canonicalNavUrl('https://example.com/read.php?tid=2'));
    expect(canonicalNavUrl('https://example.com/guide')).not.toBe(canonicalNavUrl('https://example.com/'));
  });
  it('按别名、标签、简介与多个关键词检索',()=>{
    const entry={title:'XivAnalysis',url:'https://xivanalysis.com/',category:'副本与战斗',description:'分析记录',aliases:['警察网'],tags:['战斗日志']};
    expect(matchesDirectorySearch(entry,'警察网 日志')).toBe(true);
    expect(matchesDirectorySearch(entry,'ｘｉｖａｎａｌｙｓｉｓ')).toBe(true);
    expect(matchesDirectorySearch(entry,'不存在')).toBe(false);
  });
});
