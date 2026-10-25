import {Children,useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import './personal-tools.css';

type HomeLayoutMode='auto'|'balanced'|'rows';
type ModulePosition={column:number;row:number;height:number;holding:boolean};
type SavedModuleLayout={
  version:number;identity:string;mode:HomeLayoutMode;width:number;viewportWidth:number;
  columns:readonly number[];heights:readonly number[];
};
/** 仅存储首页模块的位置/尺寸，不包含鱼类、活动正文、账户或个人记录。 */
const HOME_MODULE_LAYOUT_KEY='ff14-hub:home-module-columns:v3';
const HOME_MODULE_LAYOUT_VERSION=3;
const MODULE_GAP=18;

/** 保留原有 48px 稳定阈值：微小高度差优先复用上次的列位置。 */
function chooseModuleColumn(totals:readonly number[],previous:number|undefined):number{
  if(Math.abs(totals[0]!-totals[1]!)>48)return totals[0]!<totals[1]!?0:1;
  return previous??(totals[0]!<=totals[1]!?0:1);
}

/** 只有跨栏能显著缩小奇数模块造成的高度差时，才使用通栏布局。 */
function shouldSpanLastModule(heights:readonly number[],columns:readonly number[],totals:readonly number[]):boolean{
  const last=heights.length-1;
  if(last<=0||heights.length%2===0)return false;
  const before=[0,0];
  for(let i=0;i<last;i++)before[columns[i]!]!+=heights[i]!+MODULE_GAP;
  return Math.abs(totals[0]!-totals[1]!)>96&&Math.abs(before[0]!-before[1]!)<=48;
}

export function planModules(heights:readonly number[],previous:readonly number[]=[],allowSpan=true){
  if(allowSpan&&heights.length===1)return [2];
  const totals=[0,0],columns:number[]=[];
  for(let i=0;i<heights.length;i++){
    const column=chooseModuleColumn(totals,previous[i]);
    columns.push(column);totals[column]!+=(heights[i]??0)+MODULE_GAP;
  }
  if(allowSpan&&shouldSpanLastModule(heights,columns,totals))columns[heights.length-1]=2;
  return columns;
}

/** 智能布局默认使用「活动｜钓鱼」首行、「PVP 通栏」次行；其他组合保留自由排版。 */
export function planHomeModules(
  heights:readonly number[],identity:string,mode:HomeLayoutMode,previous:readonly number[]=[]
):number[]{
  return mode==='auto'&&identity==='events,fishing,pvp'&&heights.length===3
    ?[0,1,2]:planModules(heights,previous,mode==='auto');
}

/** 同一模块组合、布局设置及近似视口下才允许重用布局；损坏的持久数据一律丢弃。 */
function readSavedHomeLayout(
  identity:string,mode:HomeLayoutMode,width:number,viewportWidth:number,count:number
):SavedModuleLayout|null{
  try{
    const raw=window.localStorage.getItem(HOME_MODULE_LAYOUT_KEY);
    if(!raw)return null;
    const saved=JSON.parse(raw) as Partial<SavedModuleLayout>;
    if(saved.version!==HOME_MODULE_LAYOUT_VERSION||saved.identity!==identity||saved.mode!==mode
      ||typeof saved.width!=='number'||Math.abs(saved.width-width)>16
      ||typeof saved.viewportWidth!=='number'||Math.abs(saved.viewportWidth-viewportWidth)>16
      ||!Array.isArray(saved.columns)||saved.columns.length!==count
      ||saved.columns.some(column=>column!==0&&column!==1&&column!==2)
      ||mode==='balanced'&&saved.columns.includes(2)
      ||!Array.isArray(saved.heights)||saved.heights.length!==count
      ||saved.heights.some(height=>typeof height!=='number'||!Number.isFinite(height)||height<0||height>20_000))return null;
    return {...saved,version:HOME_MODULE_LAYOUT_VERSION,identity,mode,width,viewportWidth,
      columns:(saved.columns as readonly number[]).slice(),heights:(saved.heights as readonly number[]).slice()};
  }catch{return null;}
}

export function readSavedHomeColumns(
  identity:string,mode:HomeLayoutMode,width:number,viewportWidth:number,count:number
):number[]|null{
  const saved=readSavedHomeLayout(identity,mode,width,viewportWidth,count);
  return saved?[...saved.columns]:null;
}

function saveHomeLayout(layout:SavedModuleLayout){
  try{window.localStorage.setItem(HOME_MODULE_LAYOUT_KEY,JSON.stringify(layout));}
  catch{/* 隐私模式阻止本地存储时不影响首页显示 */}
}

/** 用户显式重新计算、全站首页设置更新时清除旧记录。 */
export function clearSavedHomeLayout():void{
  try{window.localStorage.removeItem(HOME_MODULE_LAYOUT_KEY);}catch{/* 本地存储不可用 */}
  window.dispatchEvent(new Event('ff14hub:home-layout-reset'));
}

function layoutPositions(heights:readonly number[],columns:readonly number[],holding:readonly boolean[]):ModulePosition[]{
  const totals=[0,0];
  return heights.map((height,i)=>{
    const column=columns[i]??0,row=column===2?Math.max(...totals):totals[column]!;
    if(column===2)totals.fill(row+height+MODULE_GAP);
    else totals[column]=row+height+MODULE_GAP;
    return {column,row,height,holding:holding[i]??false};
  });
}

/** 刷新时恢复上次模块位置与加载期占位；数据变化只调整高度，结构变化才重排。 */
export function ModuleGrid({children,identity,mode='auto'}:Readonly<{
  children:ReactNode;identity:string;mode?:HomeLayoutMode
}>){
  const root=useRef<HTMLDivElement>(null);
  const [positions,setPositions]=useState<ModulePosition[]>([]);
  useLayoutEffect(()=>{
    const element=root.current;if(!element||typeof ResizeObserver==='undefined')return;
    let columns:number[]=[],width=0,settled=false,settleTimer=0,lastSaved='';
    let remembered:SavedModuleLayout|null=null;
    const featured=mode==='auto'&&identity==='events,fishing,pvp';
    const measure=()=>{
      const items=Array.from(element.children) as HTMLElement[];
      const nextWidth=element.clientWidth;
      const heights=items.map(item=>Math.ceil((item.firstElementChild??item).getBoundingClientRect().height));
      const loading=items.map(item=>/正在.{0,12}(获取|计算|读取)/.test(item.innerText));
      if(nextWidth<800||mode==='rows'){window.clearTimeout(settleTimer);setPositions([]);return;}
      if(!columns.length||Math.abs(nextWidth-width)>16){
        width=nextWidth;
        remembered=readSavedHomeLayout(identity,mode,width,window.innerWidth,items.length);
        columns=remembered?[...remembered.columns]:planHomeModules(heights,identity,mode,columns);
        settled=remembered!==null||featured;
        lastSaved=remembered===null?'':JSON.stringify({width,columns,heights:remembered.heights});
      }
      if(!settled){
        window.clearTimeout(settleTimer);
        if(!loading.some(Boolean)){
          settleTimer=window.setTimeout(()=>{
            settled=true;
            columns=planHomeModules(
              Array.from(element.children).map(item=>Math.ceil((item.firstElementChild??item).getBoundingClientRect().height)),
              identity,mode,columns
            );
            measure();
          },550);
        }
        setPositions([]);
        return;
      }
      // 公开活动和鱼窗异步加载期间使用上次稳定的高度，避免刷新时 PVP 先上移再下移。
      const holding=loading.map((pending,i)=>Boolean(pending&&remembered?.heights[i]&&remembered.heights[i]>0));
      const effective=heights.map((height,i)=>holding[i]?Math.max(height,remembered?.heights[i]??0):height);
      const next=layoutPositions(effective,columns,holding);
      setPositions(old=>JSON.stringify(old)===JSON.stringify(next)?old:next);
      if(!loading.some(Boolean)){
        const signature=JSON.stringify({width,columns,heights});
        if(signature!==lastSaved){
          remembered={version:HOME_MODULE_LAYOUT_VERSION,identity,mode,width,viewportWidth:window.innerWidth,
            columns:[...columns],heights:[...heights]};
          saveHomeLayout(remembered);
          lastSaved=signature;
        }
      }
    };
    const reset=()=>{
      columns=[];width=0;settled=false;remembered=null;lastSaved='';
      measure();
    };
    const observer=new ResizeObserver(measure);
    observer.observe(element);for(const child of element.children)observer.observe(child);
    // 刷新期间保留卡片高度后，加载文案被真实内容替换可能不会改变尺寸。
    // 仅观察 DOM 子节点增删，不监听每秒变化的倒计时文本，防止重复计算和长期占位。
    const contentObserver=typeof MutationObserver==='undefined'?null:new MutationObserver(measure);
    contentObserver?.observe(element,{childList:true,subtree:true});
    window.addEventListener('ff14hub:home-layout-reset',reset);
    measure();
    return()=>{
      observer.disconnect();contentObserver?.disconnect();window.clearTimeout(settleTimer);
      window.removeEventListener('ff14hub:home-layout-reset',reset);
    };
  },[identity,mode]);
  const featured=mode==='auto'&&identity==='events,fishing,pvp';
  return <div className={`local-dashboard__module-grid personal-module-grid ${positions.length?'is-packed':''} ${featured?'is-featured':''}`} data-layout-mode={mode} ref={root}>
    {Children.map(children,(child,i)=>{
      const position=positions[i];
      const style=position?{
        gridColumn:position.column===2?'1 / -1':position.column+1,
        gridRow:`${position.row+1} / span ${Math.max(1,position.height+MODULE_GAP)}`,
        ...(position.holding?{'--home-reserved-height':`${position.height}px`}:{}),
      } as CSSProperties:undefined;
      return <div className="personal-module-slot" data-column={position?.column}
        data-restoring-height={position?.holding?'true':undefined} style={style}>{child}</div>;
    })}
  </div>;
}
