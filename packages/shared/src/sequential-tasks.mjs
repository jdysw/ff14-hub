/** Stop a sequential traversal without scheduling any later task. */
export const STOP_SEQUENCE=Symbol('STOP_SEQUENCE');

/**
 * Requesting the next iterator result starts exactly one task.
 * @template T,R
 * @param {Iterable<T>} items
 * @param {(item:T)=>Promise<R>} visit
 */
async function* sequentialTasks(items,visit){
  for(const item of items){yield visit(item);}
}

/**
 * Preserve ordered effects and fail fast; never prefetch or run concurrently.
 * @template T
 * @param {Iterable<T>} items
 * @param {(item:T)=>Promise<void|typeof STOP_SEQUENCE>} visit
 */
export async function forEachSequential(items,visit){
  const tasks=sequentialTasks(items,visit);
  try{
    for await(const result of tasks){
      if(result===STOP_SEQUENCE){break;}
    }
  }finally{await tasks.return(undefined);}
}

/**
 * Evaluate lazily until a task produces a defined result, then close the iterator.
 * @template T,R
 * @param {Iterable<T>} items
 * @param {(item:T)=>Promise<R|undefined>} visit
 */
export async function firstDefinedSequential(items,visit){
  const tasks=sequentialTasks(items,visit);
  try{
    for await(const result of tasks){
      if(result!==undefined){return result;}
    }
    return undefined;
  }finally{await tasks.return(undefined);}
}

/**
 * Retry without rescheduling successful effects or starting concurrent attempts.
 * @template R
 * @param {number} attempts
 * @param {(attempt:number)=>Promise<R>} run
 * @param {(attempt:number,error:unknown)=>Promise<void>} pause
 */
export async function retrySequential(attempts,run,pause){
  if(!Number.isInteger(attempts)||attempts<1){throw new RangeError('Invalid retry count');}
  /** @type {{completed:boolean,value?:R,error?:unknown}} */
  const outcome={completed:false};
  await forEachSequential(Array.from({length:attempts},(_,index)=>index),async index=>{
    try{
      outcome.value=await run(index);outcome.completed=true;return STOP_SEQUENCE;
    }catch(error){
      outcome.error=error;
      if(index+1<attempts){await pause(index,error);}
    }
  });
  if(!outcome.completed){throw outcome.error;}
  return /** @type {R} */ (outcome.value);
}
