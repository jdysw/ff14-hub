// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {navCatalogEntrySchema,type NavCatalogEntry} from '@ff14-hub/shared';
import {DirectoryBrowser} from '../src/app/local/DirectoryBrowser';

afterEach(cleanup);

const entry=(id:string,title:string,region:'cn'|'global'|'both'):NavCatalogEntry=>navCatalogEntrySchema.parse({
  id,sourceVersion:3,title,url:`https://${id}.example.org/`,description:'工具简介',
  category:'实用工具',tags:['工具'],aliases:[],icon:'🔗',openMode:'new_tab',
  region,sortOrder:1,sourceUrl:'https://example.org/',sourceName:'测试来源',
  verifiedAt:1,verificationStatus:'verified',updatedAt:1,
});

it('shows CN, global and common sites without a navigation region filter',()=>{
  const catalog=[entry('cn-site','国服网站','cn'),entry('global-site','国际服网站','global'),entry('both-site','通用网站','both')];
  const onSearch=vi.fn();
  render(<DirectoryBrowser catalog={catalog} personal={[]} search="" onSearch={onSearch}
    onFavorite={vi.fn()} failed={false} onReload={vi.fn()}/>);
  expect(screen.getByRole('link',{name:'国服网站'})).toBeDefined();
  expect(screen.getByRole('link',{name:'国际服网站'})).toBeDefined();
  expect(screen.getByRole('link',{name:'通用网站'})).toBeDefined();
  expect(screen.queryByRole('combobox',{name:/区服/})).toBeNull();
  expect(screen.getByText('3 / 3 个网站')).toBeDefined();
  fireEvent.click(screen.getByRole('button',{name:'只看收藏'}));
  expect(screen.queryByRole('link',{name:'国服网站'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'查看全部'}));
  expect(screen.getByRole('link',{name:'国际服网站'})).toBeDefined();
});
