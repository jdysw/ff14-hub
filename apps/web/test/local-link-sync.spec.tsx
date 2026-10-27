// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it} from 'vitest';
import {LocalLinkEditor} from '../src/app/local/LocalLinkEditor';
import type {LocalStore} from '../src/app/local/store';
afterEach(cleanup);
const original=()=>({id:crypto.randomUUID(),title:'原网站',url:'https://example.org/',category:'常用',favorite:false,description:'原简介'});
it('refreshes clean fields after a remote update',async()=>{
  const link=original();const view=render(<LocalLinkEditor link={link} store={{} as LocalStore}/>);
  view.rerender(<LocalLinkEditor link={{...link,title:'已同步标题'}} store={{} as LocalStore}/>);
  await waitFor(()=>expect(screen.getByRole<HTMLInputElement>('textbox',{name:'网站名称'}).value).toBe('已同步标题'));
});
it('keeps the draft and refuses to overwrite a concurrently synchronized record',async()=>{
  const link=original(),remote={...link,title:'远端新标题'},document={data:{links:[remote]}};
  const store={change:(change:(value:typeof document)=>void)=>Promise.resolve().then(()=>change(document))} as unknown as LocalStore;
  const view=render(<LocalLinkEditor link={link} store={store}/>);
  fireEvent.change(screen.getByRole('textbox',{name:'网站简介'}),{target:{value:'未保存的本机简介'}});
  view.rerender(<LocalLinkEditor link={remote} store={store}/>);fireEvent.click(screen.getByRole('button',{name:'保存修改'}));
  await screen.findByText(/此网站已被同步更新或删除/);
  expect(screen.getByRole<HTMLTextAreaElement>('textbox',{name:'网站简介'}).value).toBe('未保存的本机简介');
  expect(document.data.links[0]?.title).toBe('远端新标题');expect(document.data.links[0]?.description).toBe('原简介');
});
