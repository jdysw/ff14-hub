/** Stream iteration that awaits cancellation before an early break, return or exception. */
export function readerResults<T>(reader:{
  read:()=>Promise<{done:boolean;value?:T|undefined}>;
  cancel:()=>Promise<void>;
}):AsyncIterable<{value:T}>{
  const iterator:AsyncIterator<{value:T}>={
    async next(){
      const result=await reader.read();
      if(result.done){return {done:true,value:undefined};}
      return {done:false,value:{value:result.value as T}};
    },
    async return(){
      await reader.cancel();
      return {done:true,value:undefined};
    },
  };
  return {[Symbol.asyncIterator]:()=>iterator};
}
