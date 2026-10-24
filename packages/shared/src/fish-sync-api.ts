/** 鱼糕进度文件格式及双向差异合并，独立于已下线的 Hub 服务器同步 API。 */
export {
  parseFishDocument,serializeFishDocument,mergeFishDocuments,fieldsToDocument,
  documentChanges,canonicalJson,fishDocumentSchema,
} from '@ff14-hub/fish-sync';
export type {FishDocument,MergeConflict} from '@ff14-hub/fish-sync';
