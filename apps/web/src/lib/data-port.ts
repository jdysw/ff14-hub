/** A bounded data interface shared by the local store and public fishing catalogue. */
export interface DataPort {
  readonly moduleId:string;
  readonly operations:readonly string[];
  call<T=unknown>(operation:string,input?:unknown):Promise<T>;
}
