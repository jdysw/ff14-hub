// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {LocalModuleOverlay} from '../src/app/local/LocalModuleOverlay';

beforeEach(()=>{
  // JSDOM 没有实现原生 showModal/close，用 open 属性模拟可见性，不改产品代码。
  vi.stubGlobal('matchMedia',undefined);
  Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,writable:true,value:function(this:HTMLDialogElement){
    this.setAttribute('open','');
  }});
  Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,writable:true,value:function(this:HTMLDialogElement){
    this.removeAttribute('open');
  }});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

function createOrigin(){
  const trigger=document.createElement('button');
  trigger.textContent='查看全部';
  document.body.append(trigger);
  trigger.focus();
  return {trigger,origin:{
    rect:{left:100,top:120,width:250,height:200},
    returnFocus:trigger,
  }};
}

it('opens details on top of the current page, and click on outside blank space collapses it',()=>{
  const {trigger,origin}=createOrigin();
  const onClose=vi.fn();
  render(<LocalModuleOverlay title="钓鱼" origin={origin} onClose={onClose}>
    <button type="button">内部控件</button>
  </LocalModuleOverlay>);
  const dialog=document.querySelector('dialog.local-module-overlay')!;
  expect(dialog.hasAttribute('open')).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'内部控件'}));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(dialog);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(trigger).toBe(document.activeElement);
  trigger.remove();
});

it('dismisses on Escape or the explicit close control',()=>{
  const {trigger,origin}=createOrigin();
  const onClose=vi.fn();
  const {unmount}=render(<LocalModuleOverlay title="国服活动" origin={origin} onClose={onClose}>
    <div>完整日历</div>
  </LocalModuleOverlay>);
  const dialog=document.querySelector('dialog.local-module-overlay')!;
  fireEvent(dialog,new Event('cancel',{bubbles:true,cancelable:true}));
  expect(onClose).toHaveBeenCalledTimes(1);
  unmount();
  render(<LocalModuleOverlay title="国服活动" origin={origin} onClose={onClose}>
    <div>完整日历</div>
  </LocalModuleOverlay>);
  fireEvent.click(screen.getByRole('button',{name:'收起国服活动完整页面'}));

  expect(onClose).toHaveBeenCalledTimes(2);
  trigger.remove();
});
