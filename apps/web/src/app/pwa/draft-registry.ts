/**
 * 私有草稿登记处（HUB-012 / HUB-051）。
 *
 * 为什么需要它：Service Worker 的更新激活必须**避开**「用户正在编辑」的时刻——
 * 否则一次无提示重载就会丢掉导航链接或工作台布局的未保存草稿。
 * 但「有没有草稿」只有各个编辑视图（导航视图、工作台视图）知道，而更新提示在 Shell 上。
 *
 * 因此这里做一个**极小的登记处**：
 * - 编辑视图在挂载时登记一个「读草稿状态」的函数（返回布尔值），卸载时注销；
 * - Shell 侧的更新提示在用户点「立即更新」时调用 `hasAnyPrivateDraft()`。
 *
 * 边界（刻意保持简单）：
 * - 不存草稿内容本身，只存**判定函数**；因此这里不可能是数据泄露的路径。
 * - 任一来源报 true 即视为「有草稿」（保守：宁可晚一点更新，也不要丢用户的输入）。
 * - 判定函数可能抛错（视图处于半拆状态）：抛错按「有草稿」处理，仍然保守。
 */
export type PrivateDraftSource = () => boolean;

const sources = new Set<PrivateDraftSource>();

/** 登记一个草稿来源；返回注销函数（视图卸载时调用）。 */
export function registerPrivateDraftSource(source: PrivateDraftSource): () => void {
  sources.add(source);
  return () => {
    sources.delete(source);
  };
}

/** 当前是否有任何未保存的私有草稿。保守：来源抛错也算有草稿。 */
export function hasAnyPrivateDraft(except?:PrivateDraftSource): boolean {
  for (const source of sources) {
    if(source===except)continue;
    try {
      if (source()) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

/** 仅供测试使用：清空全部登记（避免用例之间互相影响）。 */
export function resetPrivateDraftSources(): void {
  sources.clear();
}
import {useEffect,useRef} from 'react';
/** One lifecycle for private forms: track current dirtiness and unregister on unmount. */
export function usePrivateDraft(dirty:boolean):void{
  const current=useRef(dirty);
  useEffect(()=>{current.current=dirty;},[dirty]);
  useEffect(()=>registerPrivateDraftSource(()=>current.current),[]);
  useEffect(()=>{const guard=(event:BeforeUnloadEvent)=>{if(current.current)event.preventDefault();};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[]);
}
