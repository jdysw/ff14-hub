import {useCallback,useEffect,useId,useLayoutEffect,useRef,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {moduleMotion} from './module-motion';

export interface ModuleOrigin {
  readonly rect: Pick<DOMRect,'top'|'left'|'width'|'height'>;
  readonly returnFocus: HTMLElement|null;
  readonly element?:HTMLElement;
}

interface LocalModuleOverlayProps {
  readonly title:string;
  readonly origin:ModuleOrigin;
  readonly onClose:()=>void;
  readonly children:ReactNode;
}

/**
 * 所有首页模块统一使用同一个展开层：
 * 视图从模块原位置展开，点空白、关闭按钮或 Esc 可收回，
 * 关闭时恢复首页滚动位置和触发控件焦点。
 */
export function LocalModuleOverlay({title,origin,onClose,children}:LocalModuleOverlayProps){
  const dialogRef=useRef<HTMLDialogElement>(null);
  const panelRef=useRef<HTMLDivElement>(null);
  const contentRef=useRef<HTMLDivElement>(null);
  const closingRef=useRef(false);
  const mountedRef=useRef(false);
  const finishedRef=useRef(false);
  const headingId=useId();
  const callbackRef=useRef(onClose);
  useEffect(()=>{callbackRef.current=onClose;},[onClose]);
  const originRef=useRef(origin);
  const animationsRef=useRef<Animation[]>([]);
  const cancelAnimations=useCallback(()=>{
    for(const animation of animationsRef.current)animation.cancel();
    animationsRef.current=[];
  },[]);
  const spatialMotion=useCallback(()=>{
    const panel=panelRef.current;
    if(!panel)return null;
    const source=originRef.current.element;
    return moduleMotion(source?.isConnected?source.getBoundingClientRect():originRef.current.rect,{
      left:(window.innerWidth-panel.offsetWidth)/2,top:(window.innerHeight-panel.offsetHeight)/2,
      width:panel.offsetWidth,height:panel.offsetHeight,
    });
  },[]);

  useLayoutEffect(()=>{
    const dialog=dialogRef.current;
    if(!dialog)return;
    mountedRef.current=true;closingRef.current=false;finishedRef.current=false;
    dialog.dataset['phase']='opening';
    // 原生模态对话框：浏览器负责背景 inert、Tab 焦点约束和 Esc。
    if(!dialog.open)dialog.showModal();
    const motion=typeof window.matchMedia==='function'&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const panel=panelRef.current,content=contentRef.current,spatial=spatialMotion();
    if(motion&&panel?.animate&&spatial){
      panel.style.transformOrigin=spatial.origin;
      const animation=panel.animate([{transform:spatial.enter,opacity:0},{transform:'translate3d(0,0,0) scale(1)',opacity:1}],{
        duration:360,easing:'cubic-bezier(.16,1,.3,1)',fill:'both',
      });
      animationsRef.current.push(animation);
      if(content?.animate)animationsRef.current.push(content.animate([
        {opacity:0,transform:'translateY(8px)'},{opacity:1,transform:'translateY(0)'},
      ],{duration:230,delay:55,easing:'cubic-bezier(.2,.8,.2,1)',fill:'both'}));
      void animation.finished.then(()=>{
        if(mountedRef.current&&!closingRef.current){dialog.dataset['phase']='open';cancelAnimations();}
      },()=>{});
    }else{
      dialog.dataset['phase']='open';
    }
    return()=>{
      mountedRef.current=false;
      cancelAnimations();
      if(dialog.open)dialog.close();
    };
  },[cancelAnimations,spatialMotion]);

  const finishClose=useCallback(()=>{
    if(!mountedRef.current||finishedRef.current)return;
    finishedRef.current=true;
    const dialog=dialogRef.current;
    if(dialog?.open)dialog.close();
    if(originRef.current.returnFocus?.isConnected){originRef.current.returnFocus.focus({preventScroll:true});}
    callbackRef.current();
  },[]);
  const requestClose=useCallback(()=>{
    if(closingRef.current)return;
    closingRef.current=true;
    const panel=panelRef.current;
    const motion=typeof window.matchMedia==='function'&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if(!motion||!panel?.animate){finishClose();return;}
    const current=getComputedStyle(panel),spatial=spatialMotion();
    const from={transform:current.transform,opacity:current.opacity};
    const opacity=Number.parseFloat(current.opacity)||0;
    const content=contentRef.current;
    const contentOpacity=content?getComputedStyle(content).opacity:'1';
    const duration=Math.round(140+90*Math.min(1,opacity));
    const dialog=dialogRef.current;
    if(dialog){
      dialog.style.setProperty('--module-backdrop-from',getComputedStyle(dialog,'::backdrop').opacity);
      dialog.style.setProperty('--module-exit-duration',`${duration}ms`);
      dialog.dataset['phase']='closing';
    }
    cancelAnimations();
    if(spatial)panel.style.transformOrigin=spatial.origin;
    const animation=panel.animate([from,{transform:spatial?.exit??'scale(.98)',opacity:0}],{
      duration,easing:'cubic-bezier(.4,0,.6,1)',fill:'forwards',
    });
    animationsRef.current.push(animation);
    if(content?.animate)animationsRef.current.push(content.animate([{opacity:contentOpacity},{opacity:0}],{
      duration:Math.min(140,duration),easing:'ease-out',fill:'forwards',
    }));
    void animation.finished.then(finishClose,finishClose);
  },[finishClose,cancelAnimations,spatialMotion]);

  // 内容被动更新时不关闭弹层；只处理显式的退出操作。
  useEffect(()=>{const dialog=dialogRef.current;return()=>{if(dialog?.open)dialog.close();};},[]);

  return createPortal(<dialog ref={dialogRef} className="local-module-overlay"
    aria-labelledby={headingId}
    onClose={event=>{if(!event.currentTarget.open)finishClose();}}
    onCancel={event=>{event.preventDefault();requestClose();}}
    onClick={event=>{if(event.target===event.currentTarget)requestClose();}}>
    <div ref={panelRef} className="local-module-overlay__panel">
      <header className="local-module-overlay__header">
        <h2 id={headingId}>{title}</h2>
        <button type="button" className="local-module-overlay__close" onClick={requestClose}
          aria-label={`收起${title}完整页面`} title="收起并返回首页" autoFocus>
          <span aria-hidden="true">×</span><span>收起</span>
        </button>
      </header>
      <div ref={contentRef} className="local-module-overlay__content">{children}</div>
    </div>
  </dialog>,document.body);
}
