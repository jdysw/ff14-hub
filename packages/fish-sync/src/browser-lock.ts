import {z} from 'zod';
import {CoordinatorError,type ProfileLockPort} from './coordinator';

/** Same-origin browser locks. Unsupported/denied environments fail closed, never fall back to memory. */
export function createBrowserProfileLock(manager:LockManager|null|undefined=typeof navigator==='undefined'?undefined:navigator.locks):ProfileLockPort{
  return {acquire:(profileId)=>{
    z.uuid().parse(profileId);
    if(manager==null)return Promise.reject(new CoordinatorError('lock-unavailable','当前环境不能取得浏览器互斥锁，已停止同步'));
    return new Promise((resolve,reject)=>{
      let unlock=():void=>undefined;
      const held=new Promise<void>((done)=>{unlock=done;});
      try{
        const finished=manager.request(`ff14-hub:fish-sync:${profileId}`,{mode:'exclusive',ifAvailable:true},async(lock)=>{
          if(lock===null){reject(new CoordinatorError('lock-busy','其他标签页正在操作该档案'));return;}
          let released=false;
          resolve(async()=>{if(!released){released=true;unlock();}await finished;});
          await held;
        });
        void finished.catch(()=>reject(new CoordinatorError('lock-unavailable','浏览器互斥锁不可用，已停止同步')));
      }catch{reject(new CoordinatorError('lock-unavailable','浏览器互斥锁不可用，已停止同步'));}
    });
  }};
}
