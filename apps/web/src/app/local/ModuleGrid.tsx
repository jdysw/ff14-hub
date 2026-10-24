import {Children,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import './personal-tools.css';

export function planModules(heights:readonly number[],previous:readonly number[]=[],allowSpan=true){
  if(allowSpan&&heights.length===1)return [2];
  const totals=[0,0],columns:number[]=[];
  for(let i=0;i<heights.length;i++){
    const column=Math.abs(totals[0]!-totals[1]!)<=48?(previous[i]??(totals[0]!<=totals[1]!?0:1)):(totals[0]!<totals[1]!?0:1);
    columns.push(column);totals[column]!+=(heights[i]??0)+24;
  }
  const last=heights.length-1;
  if(allowSpan&&last>0&&heights.length%2===1){
    const before=[0,0];for(let i=0;i<last;i++)before[columns[i]!]!+=heights[i]!+24;
    if(Math.abs(totals[0]!-totals[1]!)>96&&Math.abs(before[0]!-before[1]!)<=48)columns[last]=2;
  }
  return columns;
}

/** DOM order stays in reading order. Content updates move rows, never swap columns. */
export function ModuleGrid({children,identity,mode='auto'}:{children:ReactNode;identity:string;mode?:'auto'|'balanced'|'rows'}){
  const root=useRef<HTMLDivElement>(null);
  const [positions,setPositions]=useState<{column:number;row:number;height:number}[]>([]);
  useLayoutEffect(()=>{
    const element=root.current;if(!element||typeof ResizeObserver==='undefined')return;
    let columns:number[]=[],width=0,frame=0,settleTimer=0,settled=false;
    const measure=()=>{
      const items=Array.from(element.children) as HTMLElement[];
      const nextWidth=element.clientWidth;
      const heights=items.map(item=>Math.ceil(item.getBoundingClientRect().height));
      if(nextWidth<800||mode==='rows'){setPositions([]);return;}
      if(!columns.length||Math.abs(nextWidth-width)>2){columns=planModules(heights,columns,mode==='auto');width=nextWidth;}
      if(!settled){window.clearTimeout(settleTimer);if(!items.some(item=>/正在.{0,12}(获取|计算|读取)/.test(item.innerText)))settleTimer=window.setTimeout(()=>{settled=true;columns=[];measure();},750);}
      const totals=[0,0];
      const next=items.map((_,i)=>{const column=columns[i]??0,row=column===2?Math.max(...totals):totals[column]!;const height=heights[i]!;
        if(column===2)totals.fill(row+height+24);else totals[column]=row+height+24;
        return {column,row,height};});
      setPositions(old=>JSON.stringify(old)===JSON.stringify(next)?old:next);
    };
    const observer=new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(measure);});
    observer.observe(element);for(const child of element.children)observer.observe(child);
    measure();return()=>{observer.disconnect();cancelAnimationFrame(frame);window.clearTimeout(settleTimer);};
  },[identity,mode]);
  return <div className={`local-dashboard__module-grid personal-module-grid ${positions.length?'is-packed':''}`} ref={root}>
    {Children.map(children,(child,i)=><div className="personal-module-slot" style={positions[i]?{gridColumn:positions[i].column===2?'1 / -1':positions[i].column+1,gridRow:`${positions[i].row+1} / span ${Math.max(1,positions[i].height+24)}`} :undefined}>{child}</div>)}
  </div>;
}
