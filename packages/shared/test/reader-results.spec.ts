import {describe,it,expect,vi} from 'vitest';
import {readerResults} from '../src/reader-results';

describe('bounded stream ownership',()=>{
  it('awaits cancellation on an early consumer return',async()=>{
    let cancelled=false;
    const reader={read:()=>Promise.resolve({done:false,value:1}),cancel:async()=>{await Promise.resolve();cancelled=true;}};
    for await(const chunk of readerResults<number>(reader)){expect(chunk.value).toBe(1);break;}
    expect(cancelled).toBe(true);
  });
  it('preserves consumer failure while cancelling the reader',async()=>{
    const cancel=vi.fn(()=>Promise.resolve());
    const read=()=>Promise.resolve({done:false,value:1});
    await expect((async()=>{for await(const chunk of readerResults<number>({read,cancel})){if(chunk.value){throw new Error('cap exceeded');}}})()).rejects.toThrow('cap exceeded');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('finishes a complete stream without cancelling a completed reader',async()=>{
    let count=0;
    const cancel=vi.fn(()=>Promise.resolve());
    const values:number[]=[];
    for await(const chunk of readerResults<number>({read:()=>Promise.resolve({done:count++>0,value:42}),cancel})){values.push(chunk.value);}
    expect(values).toEqual([42]);
    expect(cancel).not.toHaveBeenCalled();
  });
});
