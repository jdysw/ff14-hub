import {ApiError,DEFAULT_GAME_DATA,siteGameDataSchema,type SiteGameData} from '@ff14-hub/shared';
export async function readGameData(db:D1Database){const row=await db.prepare('SELECT payload,revision FROM site_game_data WHERE singleton=1').first<{payload:string;revision:number}>();return {revision:row?.revision??0,data:row?siteGameDataSchema.parse(JSON.parse(row.payload)):DEFAULT_GAME_DATA};}
export async function saveGameData(db:D1Database,data:SiteGameData,expectedRevision:number){
  const payload=JSON.stringify(siteGameDataSchema.parse(data)),now=Date.now();
  const results=await db.batch([db.prepare('INSERT INTO site_game_data(singleton,payload,revision,updated_at) SELECT 1,?,1,? WHERE ?=0 OR EXISTS(SELECT 1 FROM site_game_data WHERE singleton=1) ON CONFLICT(singleton) DO UPDATE SET payload=excluded.payload,revision=site_game_data.revision+1,updated_at=excluded.updated_at WHERE site_game_data.revision=?').bind(payload,now,expectedRevision,expectedRevision),db.prepare('INSERT OR IGNORE INTO site_game_data_history(revision,payload,updated_at) SELECT revision,payload,updated_at FROM site_game_data WHERE singleton=1 AND revision=? AND payload=?').bind(expectedRevision+1,payload)]);
  const changed=results[0]!;
  if(changed.meta.changes<1)throw new ApiError('conflict','数据版本已更新，请重新读取，草稿仍保留');
  return {revision:expectedRevision+1,data};
}
