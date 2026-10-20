import {expect,it} from 'vitest';
import {navCatalogEntrySchema} from '@ff14-hub/shared';
import {directoryLinks} from '../src/app/local/directory-links';
const entry=(id:string,region:'cn'|'global'|'both')=>navCatalogEntrySchema.parse({id,title:id,url:`https://${id}.example.org/`,description:'工具简介',category:'实用工具',tags:['工具'],aliases:['别名'],icon:'',openMode:'new_tab',region,sourceVersion:3,sortOrder:1,sourceUrl:'https://example.org/',sourceName:'测试来源',verifiedAt:1,verificationStatus:'verified',updatedAt:1});
it('keeps CN, global and common directory entries together',()=>{
  const links=directoryLinks([entry('cn','cn'),entry('global','global'),entry('both','both')],[]);
  expect(links.map(link=>link.region)).toEqual(['cn','global','both']);
});
it('combines favorites with public search metadata without duplicating or replacing personal descriptions',()=>{
  const catalog=entry('site','both');
  const personal={id:crypto.randomUUID(),title:'我的网站',url:catalog.url,description:'个人简介',category:'收藏',favorite:true};
  const links=directoryLinks([catalog],[personal]);
  expect(links).toHaveLength(1);expect(links[0]).toMatchObject({title:'我的网站',description:'个人简介',favorite:true,personal:true,aliases:['别名'],tags:['工具']});
  expect(catalog.description).toBe('工具简介');
});
