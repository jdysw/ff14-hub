/**
 * 活动契约测试（HUB-011 / ADR-0004 D8 · D9）。
 *
 * 这里测的是**唯一的判定实现**：阶段推导、区间校验、区服/文本/阶段筛选与排序，
 * 以及 Widget 配置契约与 Manifest 的一致性。服务端查询端点、前端 Widget 与
 * 本文件调用的是同一份代码，因此这些用例就是两端行为的共同基线。
 *
 * 相对导入 `../src/events-api` 而不是 `../src/index`：本文件要能独立验证新契约，
 * 不依赖 barrel（`index.ts`）是否已经接线。
 */
import { describe, expect, it } from 'vitest';
import {
  EVENTS_MESSAGES,
  EVENTS_MODULE_ID,
  EVENTS_MODULE_MANIFEST,
  EVENTS_UPCOMING_CONFIG_VERSION,
  EVENTS_WIDGET_CONFIG_CONTRACTS,
  EVENTS_WIDGET_IDS,
  EVENT_PHASES,
  EVENT_REGIONS,
  EVENT_VERIFICATION_STATUSES,
  MAX_EVENT_DESCRIPTION_LENGTH,
  MAX_EVENT_SOURCE_URL_LENGTH,
  MAX_EVENT_TITLE_LENGTH,
  createWorkspaceEventRequestSchema,
  deleteWorkspaceEventRequestSchema,
  eventListResponseSchema,
  eventPhase,
  eventSourceUrlSchema,
  eventsManageConfigSchema,
  eventsUpcomingConfigSchema,
  filterEvents,
  findEventsWidgetConfigContract,
  isHttpsEventSourceUrl,
  normalizeEventText,
  publicEventListResponseSchema,
  publicEventSchema,
  sortEvents,
  updateWorkspaceEventRequestSchema,
  validateEventRange,
  workspaceEventSchema,
  type EventPhase,
  type EventRegion,
} from '../src/events-api';
import { validateModuleManifest } from '../src/module-manifest';

/** 一个可参与筛选/排序的最小行（只带这两个纯函数需要的字段）。 */
interface TestEvent {
  readonly id: string;
  readonly region: EventRegion;
  readonly title: string;
  readonly description: string;
  readonly startsAt: number;
  readonly endsAt: number;
}

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

const OPERATION_ID = 'op-events-0001';

function testEvent(overrides: Partial<TestEvent> & { readonly id: string }): TestEvent {
  return {
    region: 'cn',
    title: '活动',
    description: '',
    startsAt: T0,
    endsAt: T0 + HOUR,
    ...overrides,
  };
}

const publicEventRow = {
  id: 'evt-public-1',
  region: 'cn',
  title: '公共活动',
  description: '说明',
  startsAt: T0,
  endsAt: T0 + HOUR,
  sourceUrl: 'https://example.com/events/1',
  sourceName: '官方公告',
  verificationStatus: 'unverified',
  createdAt: T0 - HOUR,
  updatedAt: T0 - HOUR,
};

const workspaceEventRow = {
  id: 'evt-ws-1',
  region: 'global',
  title: '自记活动',
  description: '',
  startsAt: T0,
  endsAt: T0 + HOUR,
  sourceUrl: null,
  verificationStatus: 'unverified',
  revision: 3,
  deletedAt: null,
  createdAt: T0 - HOUR,
  updatedAt: T0 - HOUR,
};

// ---------------------------------------------------------------------------

describe('常量与迁移 0009 CHECK 一致', () => {
  it('区服只有 cn / global，刻意没有 both（INV-08：不混用区服规则）', () => {
    expect(EVENT_REGIONS).toEqual(['cn', 'global']);
    expect(EVENT_REGIONS).not.toContain('both');
  });

  it('验证状态与阶段枚举与迁移 CHECK 一致', () => {
    expect(EVENT_VERIFICATION_STATUSES).toEqual(['verified', 'unverified']);
    expect(EVENT_PHASES).toEqual(['upcoming', 'active', 'ended']);
  });

  it('模块 ID / Widget ID / 长度上限取自同一份常量', () => {
    expect(EVENTS_MODULE_ID).toBe('ff14.events');
    expect(EVENTS_WIDGET_IDS).toEqual({ upcoming: 'events-upcoming', manage: 'events-manage' });
    expect(MAX_EVENT_TITLE_LENGTH).toBe(120);
    expect(MAX_EVENT_DESCRIPTION_LENGTH).toBe(1000);
    expect(MAX_EVENT_SOURCE_URL_LENGTH).toBe(2048);
  });

  it('公共来源为空时有诚实文案（不编造数据）', () => {
    expect(EVENTS_MESSAGES.publicEmpty.length).toBeGreaterThan(0);
    expect(EVENTS_MESSAGES.manualOnly).toContain('人工维护');
  });
});

describe('eventPhase：边界包含关系', () => {
  const range = { startsAt: T0, endsAt: T0 + HOUR };
  const cases: readonly { readonly label: string; readonly nowMs: number; readonly expected: EventPhase }[] = [
    { label: '开始前一毫秒', nowMs: T0 - 1, expected: 'upcoming' },
    { label: 'now == startsAt（开始那一毫秒算进行中）', nowMs: T0, expected: 'active' },
    { label: '区间内部', nowMs: T0 + 1, expected: 'active' },
    { label: 'now == endsAt（结束那一毫秒仍算进行中）', nowMs: T0 + HOUR, expected: 'active' },
    { label: '结束后一毫秒', nowMs: T0 + HOUR + 1, expected: 'ended' },
  ];

  for (const testCase of cases) {
    it(testCase.label, () => {
      expect(eventPhase(range, testCase.nowMs)).toBe(testCase.expected);
    });
  }

  it('零长度活动（startsAt == endsAt）只在那一毫秒是进行中', () => {
    const instant = { startsAt: T0, endsAt: T0 };
    expect(eventPhase(instant, T0 - 1)).toBe('upcoming');
    expect(eventPhase(instant, T0)).toBe('active');
    expect(eventPhase(instant, T0 + 1)).toBe('ended');
  });

  it('nowMs 不是有限数时明确抛错，而不是伪造一个阶段', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => eventPhase(range, bad)).toThrow(RangeError);
    }
  });

  it('反向区间（数据库 CHECK 已阻止的坏行）也有确定结果，不会崩溃或返回未知阶段', () => {
    const broken = { startsAt: T0 + HOUR, endsAt: T0 };
    expect(EVENT_PHASES).toContain(eventPhase(broken, T0 + HOUR));
    expect(eventPhase(broken, T0)).toBe('upcoming');
  });
});

describe('validateEventRange：唯一区间判定', () => {
  it('合法区间（含零长度）通过', () => {
    expect(validateEventRange({ startsAt: T0, endsAt: T0 + HOUR })).toEqual({ ok: true });
    expect(validateEventRange({ startsAt: T0, endsAt: T0 })).toEqual({ ok: true });
  });

  it('endsAt 早于 startsAt → ends_before_starts', () => {
    expect(validateEventRange({ startsAt: T0 + 1, endsAt: T0 })).toEqual({
      ok: false,
      reason: 'ends_before_starts',
    });
  });

  it('非整数（小数 / NaN / Infinity）→ not_integer，且不因比较恒假而被当成合法', () => {
    const bad = [
      { startsAt: T0 + 0.5, endsAt: T0 + HOUR },
      { startsAt: T0, endsAt: T0 + HOUR + 0.5 },
      { startsAt: Number.NaN, endsAt: T0 + HOUR },
      { startsAt: T0, endsAt: Number.POSITIVE_INFINITY },
      { startsAt: T0, endsAt: Number.NEGATIVE_INFINITY },
    ];
    for (const range of bad) {
      expect(validateEventRange(range)).toEqual({ ok: false, reason: 'not_integer' });
    }
  });
});

describe('normalizeEventText：NFKC + 小写 + 折叠空白', () => {
  it('全角与半角等价、大小写等价、连续空白折叠', () => {
    expect(normalizeEventText('ＡＣＴ  零式')).toBe('act 零式');
    expect(normalizeEventText('  Act\t零式\n')).toBe('act 零式');
  });
});

describe('filterEvents：区服 / 文本 / 阶段', () => {
  const events: readonly TestEvent[] = [
    testEvent({ id: 'a', region: 'cn', title: 'ＡＣＴ 零式', description: '开荒  记录', startsAt: T0, endsAt: T0 + HOUR }),
    testEvent({ id: 'b', region: 'global', title: 'ACT Zero', description: 'global run', startsAt: T0 + HOUR, endsAt: T0 + 2 * HOUR }),
    testEvent({ id: 'c', region: 'cn', title: '季节活动', description: '限时', startsAt: T0 - 2 * HOUR, endsAt: T0 - HOUR }),
  ];

  it('区服精确匹配：region=cn 不返回 global 行', () => {
    const result = filterEvents(events, { region: 'cn', nowMs: T0 });
    expect(result.map((event) => event.id)).toEqual(['a', 'c']);
  });

  it("region='both' 不是通配符：结果为空（绝不退化成两个区服都返回）", () => {
    // 模拟未经校验的字符串从 JS 调用方传进来的情况（TypeScript 类型之外的真实输入）。
    const untrustedRegion: string = 'both';
    const result = filterEvents(events, { region: untrustedRegion as EventRegion, nowMs: T0 });
    expect(result).toEqual([]);
  });

  it('文本匹配同时覆盖标题与描述，且经过 NFKC / 小写 / 空白折叠', () => {
    expect(filterEvents(events, { text: 'act', nowMs: T0 }).map((event) => event.id)).toEqual(['a', 'b']);
    expect(filterEvents(events, { text: '开荒 记录', nowMs: T0 }).map((event) => event.id)).toEqual(['a']);
    expect(filterEvents(events, { text: 'act 开荒', nowMs: T0 }).map((event) => event.id)).toEqual(['a']);
    expect(filterEvents(events, { text: 'act 限时', nowMs: T0 })).toEqual([]);
  });

  it('空文本 / 缺省文本不筛选', () => {
    expect(filterEvents(events, { nowMs: T0 })).toHaveLength(3);
    expect(filterEvents(events, { text: '   ', nowMs: T0 })).toHaveLength(3);
  });

  it('阶段筛选调用 eventPhase（同一实现），边界包含关系一致', () => {
    expect(filterEvents(events, { phase: 'active', nowMs: T0 }).map((event) => event.id)).toEqual(['a']);
    expect(filterEvents(events, { phase: 'upcoming', nowMs: T0 }).map((event) => event.id)).toEqual(['b']);
    expect(filterEvents(events, { phase: 'ended', nowMs: T0 }).map((event) => event.id)).toEqual(['c']);
    // now == endsAt 仍算进行中：'c' 在 endsAt 那一毫秒属于 active。
    expect(filterEvents(events, { phase: 'active', nowMs: T0 - HOUR }).map((event) => event.id)).toEqual(['c']);
  });

  it('多个条件是与关系，且不改变入参顺序', () => {
    const result = filterEvents(events, { region: 'cn', phase: 'active', text: '零式', nowMs: T0 });
    expect(result.map((event) => event.id)).toEqual(['a']);
  });

  it('输入是只读数组也不会被修改', () => {
    const snapshot = events.map((event) => event.id);
    filterEvents(events, { region: 'cn', text: 'act', nowMs: T0 });
    expect(events.map((event) => event.id)).toEqual(snapshot);
  });
});

describe('sortEvents：确定性排序', () => {
  const tied: readonly TestEvent[] = [
    testEvent({ id: 'c', startsAt: T0 + HOUR }),
    testEvent({ id: 'a', startsAt: T0 }),
    testEvent({ id: 'b', startsAt: T0 }),
    testEvent({ id: 'd', startsAt: T0 - HOUR }),
  ];

  it('升序：按 startsAt，同一时刻用 id 升序兜底', () => {
    expect(sortEvents(tied, 'startsAt').map((event) => event.id)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('降序：startsAt 反向，但并列项的 id 兜底仍为升序（不是简单反转）', () => {
    expect(sortEvents(tied, 'startsAtDesc').map((event) => event.id)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('两次调用结果完全一致（确定性），且不修改入参', () => {
    const before = tied.map((event) => event.id);
    const first = sortEvents(tied, 'startsAt').map((event) => event.id);
    const second = sortEvents(tied, 'startsAt').map((event) => event.id);
    expect(second).toEqual(first);
    expect(tied.map((event) => event.id)).toEqual(before);
  });
});

describe('来源链接只允许 https（ADR-0004 D3）', () => {
  const accepted = [
    'https://example.com',
    'https://example.com/events/1?x=1#frag',
    'HTTPS://EXAMPLE.COM/path',
    'https://[::1]:8443/x',
    'https://xn--fiqs8s.example/path',
  ];
  const rejected = [
    'http://example.com',
    'javascript:alert(1)',
    'data:text/html,<b>x</b>',
    'file:///c:/secret.txt',
    'blob:https://example.com/abc',
    'ftp://example.com',
    'mailto:a@b.example',
    'https://user:pw@example.com',
    'https://',
    'https:// example.com',
    'https://example.com/\nHost: evil',
    `https://example.com/${'a'.repeat(MAX_EVENT_SOURCE_URL_LENGTH)}`,
    '',
  ];

  it('接受的形态', () => {
    for (const url of accepted) {
      expect(isHttpsEventSourceUrl(url)).toBe(true);
      expect(eventSourceUrlSchema.safeParse(url).success).toBe(true);
    }
  });

  it('拒绝非 https、无主机、带用户名密码、含空白/控制字符、超长的形态', () => {
    for (const url of rejected) {
      expect(isHttpsEventSourceUrl(url)).toBe(false);
      expect(eventSourceUrlSchema.safeParse(url).success).toBe(false);
    }
  });
});

describe('Schema：公共行 / 个人行 / 请求体都是 strict', () => {
  it('公共活动行合法，缺来源链接或区服为 both 时被拒绝', () => {
    expect(publicEventSchema.safeParse(publicEventRow).success).toBe(true);
    expect(publicEventSchema.safeParse({ ...publicEventRow, sourceUrl: undefined }).success).toBe(false);
    expect(publicEventSchema.safeParse({ ...publicEventRow, region: 'both' }).success).toBe(false);
    expect(publicEventSchema.safeParse({ ...publicEventRow, extra: 1 }).success).toBe(false);
  });

  it('个人活动行允许 sourceUrl=null 与墓碑，但拒绝未知字段与负 revision', () => {
    expect(workspaceEventSchema.safeParse(workspaceEventRow).success).toBe(true);
    expect(workspaceEventSchema.safeParse({ ...workspaceEventRow, deletedAt: T0 }).success).toBe(true);
    expect(workspaceEventSchema.safeParse({ ...workspaceEventRow, sourceUrl: 'http://x.example' }).success).toBe(false);
    expect(workspaceEventSchema.safeParse({ ...workspaceEventRow, revision: -1 }).success).toBe(false);
    expect(workspaceEventSchema.safeParse({ ...workspaceEventRow, workspaceId: 'ws-1' }).success).toBe(false);
  });

  it('新建请求：合法最小体通过，非法区间/非 https 来源/未知字段被拒绝', () => {
    const minimal = {
      title: '新活动',
      region: 'cn',
      startsAt: T0,
      endsAt: T0 + HOUR,
      operationId: OPERATION_ID,
    };
    expect(createWorkspaceEventRequestSchema.safeParse(minimal).success).toBe(true);
    expect(
      createWorkspaceEventRequestSchema.safeParse({ ...minimal, description: '说明', sourceUrl: null }).success,
    ).toBe(true);
    expect(
      createWorkspaceEventRequestSchema.safeParse({ ...minimal, startsAt: T0 + HOUR, endsAt: T0 }).success,
    ).toBe(false);
    expect(
      createWorkspaceEventRequestSchema.safeParse({ ...minimal, sourceUrl: 'http://example.com' }).success,
    ).toBe(false);
    expect(createWorkspaceEventRequestSchema.safeParse({ ...minimal, region: 'both' }).success).toBe(false);
    expect(createWorkspaceEventRequestSchema.safeParse({ ...minimal, extra: true }).success).toBe(false);
    expect(createWorkspaceEventRequestSchema.safeParse({ ...minimal, operationId: 'short' }).success).toBe(false);
  });

  it('更新请求：必须带 expectedRevision + operationId 且至少一个待改字段', () => {
    const base = { expectedRevision: 1, operationId: OPERATION_ID };
    expect(updateWorkspaceEventRequestSchema.safeParse({ ...base, title: '改标题' }).success).toBe(true);
    expect(updateWorkspaceEventRequestSchema.safeParse(base).success).toBe(false);
    expect(updateWorkspaceEventRequestSchema.safeParse({ title: '改标题', operationId: OPERATION_ID }).success).toBe(
      false,
    );
    expect(
      updateWorkspaceEventRequestSchema.safeParse({ ...base, title: '改标题', startsAt: T0 + HOUR + 1, endsAt: T0 })
        .success,
    ).toBe(false);
    expect(updateWorkspaceEventRequestSchema.safeParse({ ...base, title: '改标题', extra: 1 }).success).toBe(false);
  });

  it('删除请求：只有 expectedRevision + operationId，多字段即拒绝', () => {
    expect(
      deleteWorkspaceEventRequestSchema.safeParse({ expectedRevision: 2, operationId: OPERATION_ID }).success,
    ).toBe(true);
    expect(deleteWorkspaceEventRequestSchema.safeParse({ operationId: OPERATION_ID }).success).toBe(false);
    expect(
      deleteWorkspaceEventRequestSchema.safeParse({ expectedRevision: 2, operationId: OPERATION_ID, hard: true })
        .success,
    ).toBe(false);
  });

  it('列表响应形状（公共 / 个人）都带 serverTimeMs', () => {
    expect(
      publicEventListResponseSchema.safeParse({ events: [publicEventRow], serverTimeMs: T0 }).success,
    ).toBe(true);
    expect(publicEventListResponseSchema.safeParse({ events: [publicEventRow] }).success).toBe(false);
    expect(
      eventListResponseSchema.safeParse({ events: [workspaceEventRow], serverTimeMs: T0 }).success,
    ).toBe(true);
    expect(
      eventListResponseSchema.safeParse({ events: [publicEventRow], serverTimeMs: T0 }).success,
    ).toBe(false);
    expect(eventListResponseSchema.safeParse({ events: [], serverTimeMs: T0, extra: 1 }).success).toBe(false);
  });
});

describe('Manifest 与 Widget 配置契约一致', () => {
  it('Manifest 通过 validateModuleManifest', () => {
    const validation = validateModuleManifest(EVENTS_MODULE_MANIFEST);
    if (!validation.ok) {
      throw new Error(`Manifest 校验失败：${validation.issues.join('; ')}`);
    }
    expect(validation.manifest.id).toBe(EVENTS_MODULE_ID);
    expect(validation.manifest.version).toBe('1.0.0');
    expect(validation.manifest.capabilities).toEqual(['storage:own']);
    expect(validation.manifest.settingsSchemaVersion).toBe(1);
    expect(validation.manifest.routes).toEqual([{ path: '/events', viewId: 'events' }]);
    expect(validation.manifest.lifecycle).toEqual({
      onEnable: 'ff14.events.enable',
      onDisable: 'ff14.events.disable',
      onUninstall: 'ff14.events.uninstall',
    });
  });

  it('Widget 定义（ID / 多实例 / 尺寸 / 配置版本）与规格一致', () => {
    const byId = new Map(EVENTS_MODULE_MANIFEST.widgets.map((widget) => [widget.id, widget]));
    expect([...byId.keys()].sort()).toEqual([EVENTS_WIDGET_IDS.manage, EVENTS_WIDGET_IDS.upcoming].sort());

    const upcoming = byId.get(EVENTS_WIDGET_IDS.upcoming);
    expect(upcoming).toMatchObject({
      moduleId: EVENTS_MODULE_ID,
      allowMultiple: true,
      defaultSize: { w: 6, h: 4 },
      minSize: { w: 3, h: 2 },
      configSchemaVersion: EVENTS_UPCOMING_CONFIG_VERSION,
    });

    const manage = byId.get(EVENTS_WIDGET_IDS.manage);
    expect(manage).toMatchObject({
      moduleId: EVENTS_MODULE_ID,
      allowMultiple: true,
      defaultSize: { w: 6, h: 5 },
      minSize: { w: 4, h: 3 },
      configSchemaVersion: 1,
    });
  });

  it('每个契约的 configSchemaVersion 与 Manifest 同名 Widget 一致', () => {
    const manifestVersions = new Map(
      EVENTS_MODULE_MANIFEST.widgets.map((widget) => [widget.id, widget.configSchemaVersion]),
    );
    expect(EVENTS_WIDGET_CONFIG_CONTRACTS).toHaveLength(2);
    for (const contract of EVENTS_WIDGET_CONFIG_CONTRACTS) {
      expect(manifestVersions.get(contract.widgetId)).toBe(contract.configSchemaVersion);
      expect(contract.configSchemaVersion).toBe(1);
      expect(contract.migrations).toEqual({});
      // 默认配置必须能通过自己的 Schema（否则新建实例立刻是非法状态）。
      expect(contract.schema.safeParse(contract.defaultConfig).success).toBe(true);
    }
  });

  it('找不到的 Widget 返回 null（不猜默认契约）', () => {
    expect(findEventsWidgetConfigContract(EVENTS_WIDGET_IDS.upcoming)).not.toBeNull();
    expect(findEventsWidgetConfigContract('events-unknown')).toBeNull();
  });

  it('events-upcoming 默认值：region=null 表示不筛区服（不是 both）、phase=upcoming、limit=5', () => {
    expect(eventsUpcomingConfigSchema.parse({})).toEqual({
      title: '活动',
      region: null,
      phase: 'upcoming',
      limit: 5,
    });
    expect(eventsUpcomingConfigSchema.safeParse({ title: '', region: null, phase: 'all', limit: 1 }).success).toBe(
      false,
    );
    expect(eventsUpcomingConfigSchema.safeParse({ region: 'both' }).success).toBe(false);
    expect(eventsUpcomingConfigSchema.safeParse({ phase: 'ended' }).success).toBe(false);
    expect(eventsUpcomingConfigSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(eventsUpcomingConfigSchema.safeParse({ limit: 21 }).success).toBe(false);
    expect(eventsUpcomingConfigSchema.safeParse({ limit: 20, region: 'global', phase: 'active' }).success).toBe(true);
    expect(eventsUpcomingConfigSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('events-manage 默认值与边界', () => {
    expect(eventsManageConfigSchema.parse({})).toEqual({ title: '活动维护', region: null });
    expect(eventsManageConfigSchema.safeParse({ title: 'x'.repeat(41) }).success).toBe(false);
    expect(eventsManageConfigSchema.safeParse({ region: 'cn' }).success).toBe(true);
    expect(eventsManageConfigSchema.safeParse({ region: 'both' }).success).toBe(false);
    expect(eventsManageConfigSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});
