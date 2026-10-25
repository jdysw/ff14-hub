export declare const STOP_SEQUENCE:unique symbol;
export declare function forEachSequential<T>(items:Iterable<T>,visit:(item:T)=>Promise<void|typeof STOP_SEQUENCE>):Promise<void>;
export declare function firstDefinedSequential<T,R>(items:Iterable<T>,visit:(item:T)=>Promise<R|undefined>):Promise<R|undefined>;
export declare function retrySequential<R>(attempts:number,run:(attempt:number)=>Promise<R>,pause:(attempt:number,error:unknown)=>Promise<void>):Promise<R>;
