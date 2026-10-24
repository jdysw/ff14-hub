/** 当前鱼类公共目录读取；个人鱼类进度已经移至浏览器 IndexedDB + WebDAV/S3。 */
import {ApiError,fishRecordSchema,type FishRegion} from '@ff14-hub/shared';
import {readGameData} from '../admin/game-data';

export async function readFish(db: D1Database, region: FishRegion) {
  const rows = await db.prepare('SELECT record_json FROM fish_catalog WHERE region=? ORDER BY fish_id LIMIT 5001').bind(region)
    .all<{record_json:string}>();
  if (rows.results.length > 5000) throw new ApiError('validation_failed','鱼类目录超出读取上限');
  const overrides=(await readGameData(db)).data.fish.filter(item=>item.region===region);
  const records=rows.results.map((row) => {const original=fishRecordSchema.parse(JSON.parse(row.record_json) as unknown);const correction=overrides.find(item=>item.id===original.id);return correction?fishRecordSchema.parse({...original,name:correction.name,...(correction.rule?{rule:{...correction.rule,validationStatus:'unverified'}}:{})}):original;}).filter(record=>!overrides.some(item=>item.id===record.id&&item.rule===null));
  // 正式目录存在时不再把合成测试鱼呈现给玩家；保留测试数据行以免破坏已有外键。
  return records.some(record=>!record.demo)?records.filter(record=>!record.demo):records;
}
