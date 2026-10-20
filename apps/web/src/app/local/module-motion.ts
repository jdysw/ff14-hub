export interface MotionRect {readonly top:number;readonly left:number;readonly width:number;readonly height:number}
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));

/** A restrained spatial cue toward the trigger, without stretching text or crossing the screen. */
export function moduleMotion(source:MotionRect,target:MotionRect){
  const usable=[source.left,source.top,source.width,source.height].every(Number.isFinite)&&source.width>0&&source.height>0;
  const x=usable?source.left+source.width/2:target.left+target.width/2;
  const y=usable?source.top+source.height/2:target.top+target.height/2;
  const width=Math.max(1,target.width),height=Math.max(1,target.height);
  const dx=clamp(x-target.left-width/2,-Math.min(64,width*.06),Math.min(64,width*.06));
  const dy=clamp(y-target.top-height/2,-Math.min(40,height*.06),Math.min(40,height*.06));
  return {
    origin:`${clamp((x-target.left)/width*100,10,90)}% ${clamp((y-target.top)/height*100,10,90)}%`,
    enter:`translate3d(${dx}px,${dy}px,0) scale(.96)`,
    exit:`translate3d(${dx*.7}px,${dy*.7}px,0) scale(.98)`,
  };
}
