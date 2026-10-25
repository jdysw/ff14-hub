// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
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
const originalAnimate=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'animate');
afterEach(()=>{
  cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();
  if(originalAnimate)Object.defineProperty(HTMLElement.prototype,'animate',originalAnimate);
  else Reflect.deleteProperty(HTMLElement.prototype,'animate');
});

function enableAnimation(){
  const handles:{finish:()=>void;cancel:ReturnType<typeof vi.fn>}[]=[];
  const animate=vi.fn((_frames:Keyframe[],_options:KeyframeAnimationOptions)=>{
    let finish=()=>{};
    const finished=new Promise<void>(resolve=>{finish=resolve;});
    const cancel=vi.fn();
    handles.push({finish,cancel});
    return {finished,cancel};
  });
  Object.defineProperty(HTMLElement.prototype,'animate',{configurable:true,writable:true,value:animate});
  vi.stubGlobal('matchMedia',vi.fn(()=>({matches:false})));
  const getStyle=window.getComputedStyle.bind(window);
  vi.stubGlobal('getComputedStyle',vi.fn((element:Element)=>{
    const style=getStyle(element);
    if(element.matches('.local-module-overlay,.local-module-overlay__panel,.local-module-overlay__content')){
      return {transform:'matrix(0.975, 0, 0, 0.975, -12, -8)',opacity:'0.45',
        getPropertyValue:style.getPropertyValue.bind(style),display:style.display,visibility:style.visibility};
    }
    return style;
  }));
  return {animate,handles};
}

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
  fireEvent.click(screen.getByRole('button',{name:'关闭展开页面'}));
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

it('handles native dismissal once and leaves no inline document scroll lock',()=>{
  const {trigger,origin}=createOrigin(),onClose=vi.fn();
  const before=document.documentElement.style.overflow;
  const {unmount}=render(<LocalModuleOverlay title="PVP" origin={origin} onClose={onClose}><div>轮换资料</div></LocalModuleOverlay>);
  expect(document.documentElement.style.overflow).toBe(before);
  const dialog=document.querySelector<HTMLDialogElement>('dialog.local-module-overlay')!;
  // A queued close from an earlier mount must not dismiss a reopened dialog.
  fireEvent(dialog,new Event('close'));expect(onClose).not.toHaveBeenCalled();expect(dialog.open).toBe(true);
  dialog.close();fireEvent(dialog,new Event('close'));
  expect(onClose).toHaveBeenCalledOnce();expect(document.activeElement).toBe(trigger);
  fireEvent(dialog,new Event('close'));expect(onClose).toHaveBeenCalledOnce();
  unmount();expect(document.documentElement.style.overflow).toBe(before);trigger.remove();
});

it('closing during entrance starts from the visible frame and closes exactly once',async()=>{
  const {animate,handles}=enableAnimation();
  const {trigger,origin}=createOrigin();const onClose=vi.fn();
  render(<LocalModuleOverlay title="钓鱼" origin={origin} onClose={onClose}><div>鱼窗</div></LocalModuleOverlay>);
  fireEvent.click(screen.getByRole('button',{name:'收起钓鱼完整页面'}));
  fireEvent.click(screen.getByRole('button',{name:'收起钓鱼完整页面'}));
  expect(animate).toHaveBeenCalledTimes(4);
  expect(animate.mock.calls[2]?.[0][0]).toEqual({transform:'matrix(0.975, 0, 0, 0.975, -12, -8)',opacity:'0.45'});
  expect(handles[0]?.cancel).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled();
  await act(async()=>{handles[2]?.finish();await Promise.resolve();});
  expect(onClose).toHaveBeenCalledOnce();expect(document.activeElement).toBe(trigger);
  trigger.remove();
});

it('does not invoke a stale close callback when unmounted during exit',async()=>{
  const {handles}=enableAnimation();const {trigger,origin}=createOrigin();const onClose=vi.fn();
  const {unmount}=render(<LocalModuleOverlay title="钓鱼" origin={origin} onClose={onClose}><div>鱼窗</div></LocalModuleOverlay>);
  fireEvent.click(screen.getByRole('button',{name:'收起钓鱼完整页面'}));unmount();
  await act(async()=>{handles[2]?.finish();await Promise.resolve();});
  expect(onClose).not.toHaveBeenCalled();expect(handles[2]?.cancel).toHaveBeenCalledOnce();
  trigger.remove();
});

it('respects reduced motion and restores scrolling without an animation delay',()=>{
  const {animate}=enableAnimation();vi.stubGlobal('matchMedia',vi.fn(()=>({matches:true})));
  const {trigger,origin}=createOrigin();const onClose=vi.fn();
  const before=document.documentElement.style.overflow;
  const {unmount}=render(<LocalModuleOverlay title="钓鱼" origin={origin} onClose={onClose}><div>鱼窗</div></LocalModuleOverlay>);
  fireEvent.click(screen.getByRole('button',{name:'收起钓鱼完整页面'}));
  expect(animate).not.toHaveBeenCalled();expect(onClose).toHaveBeenCalledOnce();
  unmount();expect(document.documentElement.style.overflow).toBe(before);trigger.remove();
});
