// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {RenderErrorBoundary} from '../src/lib/RenderErrorBoundary';
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('shows a recoverable page error instead of a blank app, without exposing the thrown details',()=>{
  vi.spyOn(console,'error').mockImplementation(()=>{});let broken=true;
  function Content(){if(broken)throw new Error('private-error-details');return <p>已恢复页面</p>;}
  render(<RenderErrorBoundary><Content/></RenderErrorBoundary>);
  expect(screen.getByRole('alert').textContent).not.toContain('private-error-details');
  broken=false;fireEvent.click(screen.getByRole('button',{name:'重试页面'}));
  expect(screen.getByText('已恢复页面')).toBeTruthy();
});
