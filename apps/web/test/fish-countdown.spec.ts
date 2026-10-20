import {expect,it} from 'vitest';
import {fishCountdown} from '../src/app/fish/countdown';
it('preserves seconds across minute, hour and day boundaries',()=>{
  expect(fishCountdown(1)).toBe('00:00:01');
  expect(fishCountdown(59000)).toBe('00:00:59');
  expect(fishCountdown(60000)).toBe('00:01:00');
  expect(fishCountdown(3661000)).toBe('01:01:01');
  expect(fishCountdown(90061000)).toBe('1 天 01:01:01');
});
it('does not show a negative, NaN or infinite countdown',()=>{
  for(const value of [0,-1,NaN,Infinity])expect(fishCountdown(value)).toBe('00:00:00');
});
