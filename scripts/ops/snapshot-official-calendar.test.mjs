import assert from 'node:assert/strict';
import { test } from 'node:test';
import { officialCalendarUpsertSql, snapshotOutputPath } from './snapshot-official-calendar.mjs';
import path from 'node:path';

test('快照生成器只能选择 .wrangler 下的单个安全 SQL 文件', () => {
  const target = snapshotOutputPath('calendar-snapshot.sql');
  assert.equal(path.basename(target), 'calendar-snapshot.sql');
  assert.equal(path.basename(path.dirname(target)), '.wrangler');
  for (const bad of ['../private.sql', '/tmp/unsafe.sql', 'a/../private.sql', '..\\\\private.sql',
    '.secret.sql', 'out.txt', 'file.sql?query=1', '']) {
    assert.throws(() => snapshotOutputPath(bad));
  }
});

function feed(overrides = {}) {
  const now = Date.now();
  return {
    serverTimeMs: now,
    source: {
      name: '盛趣游戏 · FF14 国服官方公告',
      homeUrl: 'https://ff.web.sdo.com/web8/index.html#/newstab/newslist',
      checkedAtMs: now, stale: false,
    },
    events: [{
      id: 'official:42', region: 'cn', title: "守护天节's 活动",
      category: '季节活动', description: '', location: '', startsAt: null,
      endsAt: null, allDay: false, sourceUrl: 'https://ff.web.sdo.com/web8/index.html#/newstab/newscont/42',
    }],
    ...overrides,
  };
}

test('D1 SQL 采用十六进制 JSON 字节，官方标题中的单引号不会破坏语句', () => {
  const data = feed();
  const statement = officialCalendarUpsertSql(data);
  assert.match(statement, /INSERT INTO official_calendar_snapshots/);
  assert.match(statement, /ON CONFLICT\(source\) DO UPDATE/);
  assert.doesNotMatch(statement, /守护天节's/);
  const match = /CAST\(X'([0-9a-f]+)' AS TEXT\)/.exec(statement);
  assert.ok(match);
  const decoded = Buffer.from(match[1], 'hex').toString('utf8');
  assert.deepEqual(JSON.parse(decoded), data);
});

test('官方源不可用或返回空活动时禁止覆盖上一份有效快照', () => {
  assert.throws(() => officialCalendarUpsertSql(feed({ events: [] })));
  assert.throws(() => officialCalendarUpsertSql(feed({
    source: { ...feed().source, stale: true },
  })));
  assert.throws(() => officialCalendarUpsertSql(feed({
    events: [{ ...feed().events[0], sourceUrl: 'https://evil.example/events' }],
  })));
});
