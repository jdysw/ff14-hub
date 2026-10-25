import {describe,expect,it} from 'vitest';
import {EVENT_PHASES,MAX_EVENT_SOURCE_URL_LENGTH,eventPhase,eventSourceUrlSchema,filterEvents,isHttpsEventSourceUrl,normalizeEventText,publicEventListResponseSchema,publicEventSchema,sortEvents,type EventPhase,type EventRegion} from '../src/events-api';

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

describe('公共活动响应',()=>{
  it('拒绝缺失来源、错误区服和未知字段',()=>{
    expect(publicEventSchema.safeParse(publicEventRow).success).toBe(true);
    expect(publicEventSchema.safeParse({...publicEventRow,sourceUrl:undefined}).success).toBe(false);
    expect(publicEventSchema.safeParse({...publicEventRow,region:'both'}).success).toBe(false);
    expect(publicEventSchema.safeParse({...publicEventRow,extra:1}).success).toBe(false);
  });
  it('要求服务端时间且拒绝额外响应字段',()=>{
    expect(publicEventListResponseSchema.safeParse({events:[publicEventRow],serverTimeMs:T0}).success).toBe(true);
    expect(publicEventListResponseSchema.safeParse({events:[publicEventRow]}).success).toBe(false);
    expect(publicEventListResponseSchema.safeParse({events:[],serverTimeMs:T0,extra:1}).success).toBe(false);
  });
});
