// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {DEFAULT_CATEGORIES,DEFAULT_HOME} from '@ff14-hub/shared';
import type {managedPresentationSchema} from '@ff14-hub/shared';
type Presentation=ReturnType<typeof managedPresentationSchema.parse>;
import {PresentationEditor} from '../src/app/admin/PresentationEditor';

afterEach(cleanup);

it('设置中的智能布局与首页方案 A 的规则说明一致',()=>{
  const onChange=vi.fn<(next:Presentation)=>void>();
  const presentation:Presentation={categories:DEFAULT_CATEGORIES,home:DEFAULT_HOME,categoryAliases:{}};
  const {rerender}=render(<PresentationEditor value={presentation} onChange={onChange}/>);
  const layout=screen.getByRole<HTMLSelectElement>('combobox',{name:'模块布局'});
  expect(layout.value).toBe('auto');
  expect(screen.getByRole('option',{name:'智能布局（活动＋钓鱼并列，PVP 通栏）'})).toBeDefined();
  const layoutStatus=screen.getByRole('status');
  expect(layoutStatus.tagName).toBe('OUTPUT');
  expect(layoutStatus.textContent).toContain('前两项并列，PVP 在第二行通栏');
  fireEvent.change(layout,{target:{value:'balanced'}});
  const updated=onChange.mock.lastCall?.[0];
  if(!updated)throw new Error('布局设置未触发更新');
  expect(updated.home.layout).toBe('balanced');
  rerender(<PresentationEditor value={updated} onChange={onChange}/>);
  expect(screen.getByRole('status').textContent).toContain('模块分别排列在左右两列，不再让 PVP 通栏');
  fireEvent.change(screen.getByRole<HTMLSelectElement>('combobox',{name:'模块布局'}),{target:{value:'rows'}});
  expect(onChange.mock.lastCall?.[0].home.layout).toBe('rows');
});
