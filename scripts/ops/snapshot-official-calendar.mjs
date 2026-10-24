/**
 * 从 GitHub Actions 运行器读取固定的盛趣官方公告接口，生成可在 D1 原子更新的 SQL。
 * 与 Worker 复用同一套活动去重、日期提取及官方域名校验实现，避免第二套抓取逻辑。
 * 仅传公共活动 JSON；不读取用户凭证，不在 SQL 中拼接未经转义的字符串。
 *
 * 用法：node scripts/ops/snapshot-official-calendar.mjs <output-sql-path>
 * 需要 Node 24 原生 TypeScript 类型剥离支持。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readCnCalendar } from '../../worker/modules/events/calendar-feed.ts';

/** 仅向本项目固定的临时目录写入安全文件名，不允许绝对路径与 ../ 逃逸。 */
export function snapshotOutputPath(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,80}\.sql$/.test(name)) {
    throw new Error('快照输出文件名必须是安全的 .sql 文件名');
  }
  return path.join(fileURLToPath(new URL('../../.wrangler/', import.meta.url)), name);
}

export function officialCalendarUpsertSql(calendar) {
  if (!calendar || !Array.isArray(calendar.events) || calendar.events.length === 0 ||
      calendar.events.length > 250 || calendar.source?.stale !== false ||
      !Number.isSafeInteger(calendar.source?.checkedAtMs) ||
      Math.abs(Date.now() - calendar.source.checkedAtMs) > 15 * 60_000) {
    throw new Error('官方日历为空、过期或来源异常，拒绝覆盖已有生产快照');
  }
  if (calendar.source.homeUrl !== 'https://ff.web.sdo.com/web8/index.html#/newstab/newslist') {
    throw new Error('官方公告来源不匹配');
  }
  for (const event of calendar.events) {
    if (event.region !== 'cn' || !event.id?.startsWith('official:') ||
        typeof event.title !== 'string' || !event.title.trim() ||
        (event.sourceUrl !== null && (() => {
          try {
            const url = new URL(event.sourceUrl);
            return url.protocol !== 'https:' ||
              !(url.hostname === 'sdo.com' || url.hostname.endsWith('.sdo.com'));
          } catch { return true; }
        })())) {
      throw new Error('官方活动来源数据不合法，拒绝覆盖快照');
    }
  }
  // SQLite 十六进制文字保持 JSON 字节原样，不受标题中引号或特殊字符影响。
  const hex = Buffer.from(JSON.stringify(calendar), 'utf8').toString('hex');
  return "INSERT INTO official_calendar_snapshots (source, payload, checked_at_ms) VALUES " +
    "('cn', CAST(X'" + hex + "' AS TEXT), " + calendar.source.checkedAtMs + ") " +
    'ON CONFLICT(source) DO UPDATE SET payload = excluded.payload, ' +
    'checked_at_ms = excluded.checked_at_ms;';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const dest = snapshotOutputPath(process.argv[2]);
    const feed = await readCnCalendar();
    const sql = officialCalendarUpsertSql(feed);
    await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    await writeFile(dest, sql + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({
      kind: 'official_calendar_snapshot',
      count: feed.events.length, checkedAtMs: feed.source.checkedAtMs,
      destination: path.basename(dest),
    }));
  } catch (error) {
    console.error('国服官方活动同步失败：' + (error instanceof Error ? error.message : 'unknown'));
    process.exitCode = 1;
  }
}
