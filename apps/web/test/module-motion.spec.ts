import {expect,it} from 'vitest';
import {moduleMotion} from '../src/app/local/module-motion';

it('keeps ultrawide travel bounded and uses a uniform scale so text is not stretched',()=>{
  const motion=moduleMotion({left:-3000,top:-2000,width:1200,height:400},{left:760,top:160,width:1920,height:1120});
  expect(motion.enter).toBe('translate3d(-64px,-40px,0) scale(.96)');
  expect(motion.exit).toBe('translate3d(-44.8px,-28px,0) scale(.98)');
  expect(motion.origin).toBe('10% 10%');
});
it('preserves left/right spatial direction and limits travel on a phone',()=>{
  const target={left:8,top:8,width:374,height:828};
  const left=moduleMotion({left:-1000,top:200,width:200,height:100},target);
  const right=moduleMotion({left:1000,top:200,width:200,height:100},target);
  expect(Number(left.enter.match(/translate3d\(([-\d.]+)px/)?.[1])).toBeCloseTo(-22.44,2);
  expect(Number(right.enter.match(/translate3d\(([-\d.]+)px/)?.[1])).toBeCloseTo(22.44,2);
});
it('falls back to the center if a removed source has unusable geometry',()=>{
  const motion=moduleMotion({left:NaN,top:NaN,width:0,height:0},{left:100,top:100,width:800,height:600});
  expect(motion.origin).toBe('50% 50%');
  expect(motion.enter).toBe('translate3d(0px,0px,0) scale(.96)');
});
