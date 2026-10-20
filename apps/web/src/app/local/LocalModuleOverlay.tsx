import {useCallback,useEffect,useId,useLayoutEffect,useRef,type ReactNode} from 'react';
import {createPortal} from 'react-dom';

export interface ModuleOrigin {
  readonly rect: Pick<DOMRect,'top'|'left'|'width'|'height'>;
  readonly returnFocus: HTMLElement|null;
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
  const closingRef=useRef(false);
  const headingId=useId();
  const callbackRef=useRef(onClose);
  callbackRef.current=onClose;
  const originRef=useRef(origin);
  const openAnimation=useRef<Animation|null>(null);

  const transitionFrames=useCallback((closing:boolean):Keyframe[]=>{
    const panel=panelRef.current;
    if(!panel)return [];
    const target=panel.getBoundingClientRect(),src=originRef.current.rect;
    const scaleX=Math.max(.12,Math.min(1,src.width/Math.max(1,target.width)));
    const scaleY=Math.max(.12,Math.min(1,src.height/Math.max(1,target.height)));
    const dx=src.left+src.width/2-(target.left+target.width/2);
    const dy=src.top+src.height/2-(target.top+target.height/2);
    const collapsed={transform:`translate(${dx}px,${dy}px) scale(${scaleX},${scaleY})`,opacity:.55,borderRadius:'18px'};
    const expanded={transform:'translate(0px, 0px) scale(1, 1)',opacity:1,borderRadius:'14px'};
    return closing?[expanded,collapsed]:[collapsed,expanded];
  },[]);

  useLayoutEffect(()=>{
    const dialog=dialogRef.current;
    if(!dialog)return;
    // 原生模态对话框：浏览器负责背景 inert、Tab 焦点约束和 Esc。
    dialog.showModal();
    const previousOverflow=document.documentElement.style.overflow;
    document.documentElement.style.overflow='hidden';
    const motion=typeof window.matchMedia==='function'&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if(motion&&panelRef.current?.animate){
      openAnimation.current=panelRef.current.animate(transitionFrames(false),{
        duration:270,easing:'cubic-bezier(.2,.8,.2,1)',fill:'both',
      });
    }
    return()=>{
      openAnimation.current?.cancel();
      document.documentElement.style.overflow=previousOverflow;
      if(dialog.open)dialog.close();
    };
  },[transitionFrames]);

  const finishClose=useCallback(()=>{
    const dialog=dialogRef.current;
    if(dialog?.open)dialog.close();
    originRef.current.returnFocus?.isConnected&&originRef.current.returnFocus.focus({preventScroll:true});
    callbackRef.current();
  },[]);
  const requestClose=useCallback(()=>{
    if(closingRef.current)return;
    closingRef.current=true;
    openAnimation.current?.cancel();
    const panel=panelRef.current;
    const motion=typeof window.matchMedia==='function'&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if(!motion||!panel?.animate){finishClose();return;}
    const animation=panel.animate(transitionFrames(true),{
      duration:190,easing:'cubic-bezier(.4,0,1,1)',fill:'forwards',
    });
    void animation.finished.then(finishClose,finishClose);
  },[finishClose,transitionFrames]);

  // 内容被动更新时不关闭弹层；只处理显式的退出操作。
  useEffect(()=>{const dialog=dialogRef.current;return()=>{if(dialog?.open)dialog.close();};},[]);

  return createPortal(<dialog ref={dialogRef} className="local-module-overlay"
    aria-labelledby={headingId}
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
      <div className="local-module-overlay__content">{children}</div>
    </div>
  </dialog>,document.body);
}
