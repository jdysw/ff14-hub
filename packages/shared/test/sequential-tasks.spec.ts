import {describe,it,expect} from 'vitest';
import {forEachSequential,firstDefinedSequential,retrySequential,STOP_SEQUENCE} from '../src/sequential-tasks.mjs';

describe('ordered asynchronous effects',()=>{
  it('does not start later tasks before the preceding operation finishes',async()=>{
    const events:number[]=[];
    let release:()=>void=()=>{};
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const pending=forEachSequential([1,2],async value=>{
      events.push(value);
      if(value===1){await gate;}
      events.push(-value);
    });
    expect(events).toEqual([1]);
    release();
    await pending;
    expect(events).toEqual([1,-1,2,-2]);
  });
  it('stops before later effects on rejection and closes the input iterator',async()=>{
    let closed=false;
    function* entries(){try{yield 1;yield 2;}finally{closed=true;}}
    await expect(forEachSequential(entries(),()=>Promise.reject(new Error('failed')))).rejects.toThrow('failed');
    expect(closed).toBe(true);
  });
  it('supports an explicit early stop and closes the iterator',async()=>{
    const events:number[]=[];
    let closed=false;
    function* entries(){try{yield 1;yield 2;}finally{closed=true;}}
    await forEachSequential(entries(),item=>{events.push(item);return Promise.resolve(STOP_SEQUENCE);});
    expect(events).toEqual([1]);
    expect(closed).toBe(true);
  });
});

it('returns a defined zero result and closes the lazy iterator immediately',async()=>{
  const calls:number[]=[];let closed=false;
  function* entries(){try{yield 0;yield 1;yield 2;}finally{closed=true;}}
  const result=await firstDefinedSequential(entries(),value=>{calls.push(value);return Promise.resolve(value===1?0:undefined);});
  expect(result).toBe(0);expect(calls).toEqual([0,1]);expect(closed).toBe(true);
});
it('treats an undefined successful retry result as success and pauses only between failures',async()=>{
  let calls=0;const pauses:number[]=[];
  const result=await retrySequential(3,()=>{
    calls++;return calls<3?Promise.reject(new Error('pending')):Promise.resolve(undefined);
  },attempt=>{pauses.push(attempt);return Promise.resolve();});
  expect(result).toBeUndefined();expect(calls).toBe(3);expect(pauses).toEqual([0,1]);
});
it('propagates the final retry failure without an extra attempt or final delay',async()=>{
  const last=new Error('last failure');const pauses:number[]=[];
  await expect(retrySequential(3,attempt=>Promise.reject(attempt===2?last:new Error('earlier')),attempt=>{pauses.push(attempt);return Promise.resolve();})).rejects.toBe(last);
  expect(pauses).toEqual([0,1]);
});
