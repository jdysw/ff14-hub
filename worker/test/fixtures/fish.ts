import {forEachSequential} from "../../../packages/shared/src/sequential-tasks.mjs";
import { fishDataBundleSchema, type FishRecord } from '@ff14-hub/shared';

/** Offline importer: validates the whole bundle before writing, bounded transactions. */
export async function importFishBundle(db: D1Database, raw: unknown): Promise<number> {
  const bundle = fishDataBundleSchema.parse(raw);
  // A bundle may extend the catalog but never deletes identities referenced by progress.
  await forEachSequential(Array.from({length:Math.ceil(bundle.records.length/50)},(_,index)=>index*50),async offset=>{
    await db.batch(bundle.records.slice(offset,offset+50).map(record=>db.prepare(
      'INSERT INTO fish_catalog(region,fish_id,record_json) VALUES(?,?,?) ON CONFLICT(region,fish_id) DO UPDATE SET record_json=excluded.record_json',
    ).bind(record.region,record.id,JSON.stringify(record))));
  });
  return bundle.records.length;
}

/** Synthetic records, explicitly not actual game rules or historical validation. */
export function demoFish(region: 'cn'|'global'): FishRecord[] {
  return [{id:9000001,region,name:'示例·海港鱼（非真实鱼类）',fishType:'normal',demo:true,
    source:{url:'https://github.com/jdysw/ff14-hub',version:'synthetic-v1',fetchedAt:1792252800000,
      authorizationStatus:'permitted',verificationStatus:'unverified'},
    rule:{schemaVersion:1,region,fishId:9000001,version:'synthetic-v1',zoneId:'demo-harbor',
      startHour:22,endHour:4,weatherRates:[{weather:'示例晴天',chance:60},{weather:'示例雨天',chance:40}],
      currentWeather:[],previousWeather:[],conditions:[],validationStatus:'unverified'}}];
}
