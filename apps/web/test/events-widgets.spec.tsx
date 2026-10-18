/**
 * 活动 Widget 测试（HUB-011，jsdom + React Testing Library）。
 *
 * 两条硬约束：
 * 1. **不发真实网络请求**。组件测试注入一个假的 `ModuleDataPort`（`data.call` 用 `vi.fn()`
 *    返回受控数据）；端口测试把 `fetch` 换成受控 stub，于是「请求了什么」可以被精确断言。
 * 2. 断言的是**行为与顺序**（谁被调用、传了什么、渲染顺序），而不是把实现里的常量抄一遍。
 *    时间断言刻意用本地时间构造的期望值（`new Date(y, m, d, h, min)`），
 *    因此测试在任何时区下都成立——这正是「本地时间 → UTC 毫秒」该有的验证方式。
 */
// @vitest-environment jsdom
import {
  EVENTS_MESSAGES,
  EVENTS_MODULE_ID,
  EVENTS_WIDGET_IDS,
  sortEvents,
  type ModuleCapability,
  type WorkspaceEvent,
} from '@ff14-hub/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { EventsManageWidget } from '../src/app/events/EventsManageWidget';
import { EVENTS_PORT_OPERATIONS, EventsPortError, eventsModulePortFactory } from '../src/app/events/events-data-port';
import { EventsUpcomingWidget, MISSING_PORT_MESSAGE } from '../src/app/events/EventsUpcomingWidget';
import { createModuleDataPort } from '../src/app/widgets/module-data-ports';
import type { ModuleDataPort, WidgetRuntimeProps } from '../src/app/widgets/types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 服务端时间基准（本地 2026-10-18 09:00）：阶段判定一律以它为准，不用设备时钟。 */
const SERVER_TIME_MS = new Date(2026, 9, 18, 9, 0).getTime();

/** 本地时间构造器：让「本地 → UTC 毫秒」的期望值在任何时区下都成立。 */
function at(day: number, hour: number, minute: number): number {
  return new Date(2026, 9, day, hour, minute).getTime();
}

interface Reports {
  readonly reportReady: Mock<() => void>;
  readonly reportEmpty: Mock<() => void>;
  readonly reportAsyncError: Mock<(error: unknown) => void>;
}

function createReports(): Reports {
  return {
    reportReady: vi.fn<() => void>(),
    reportEmpty: vi.fn<() => void>(),
    reportAsyncError: vi.fn<(error: unknown) => void>(),
  };
}

/** 假端口：`data.call` 是 spy，测试可断言「调了什么、传了什么、调了几次」。 */
type PortSpy = Mock<(operation: string, input: unknown) => Promise<unknown>>;

function fakePort(handler: (operation: string, input: unknown) => unknown): {
  readonly port: ModuleDataPort;
  readonly spy: PortSpy;
} {
  const spy = vi.fn<(operation: string, input: unknown) => Promise<unknown>>((operation, input) =>
    // 用 `Promise.resolve().then` 包一层：handler 同步抛错时也变成 Promise 拒绝，
    // 与真实端口的异步失败语义一致（`async` 关键字在这里会触发 require-await，故不用）。
    Promise.resolve().then(() => handler(operation, input)),
  );
  return {
    spy,
    port: {
      moduleId: EVENTS_MODULE_ID,
      operations: Object.values(EVENTS_PORT_OPERATIONS),
      // 保持与真实端口同样的泛型签名（调用方用 `call<T>` 指定返回类型）。
      call: <T = unknown,>(operation: string, input?: unknown): Promise<T> => spy(operation, input) as Promise<T>,
    },
  };
}

function workspaceEvent(overrides: Partial<WorkspaceEvent> & { readonly id: string }): WorkspaceEvent {
  return {
    region: 'cn',
    title: '测试活动',
    description: '',
    startsAt: at(18, 10, 30),
    endsAt: at(18, 11, 0),
    sourceUrl: null,
    verificationStatus: 'unverified',
    revision: 1,
    deletedAt: null,
    createdAt: SERVER_TIME_MS,
    updatedAt: SERVER_TIME_MS,
    ...overrides,
  };
}

function upcomingProps(input: {
  readonly reports: Reports;
  readonly data?: ModuleDataPort | undefined;
  readonly config?: unknown;
}): WidgetRuntimeProps {
  return {
    instanceId: 'up-1',
    moduleId: EVENTS_MODULE_ID,
    widgetId: EVENTS_WIDGET_IDS.upcoming,
    config: input.config ?? { title: '近期活动', region: null, phase: 'all', limit: 5 },
    retryToken: 0,
    data: input.data,
    reportReady: input.reports.reportReady,
    reportEmpty: input.reports.reportEmpty,
    reportAsyncError: input.reports.reportAsyncError,
  };
}

function manageProps(input: {
  readonly reports: Reports;
  readonly data?: ModuleDataPort | undefined;
  readonly config?: unknown;
}): WidgetRuntimeProps {
  return {
    instanceId: 'mg-1',
    moduleId: EVENTS_MODULE_ID,
    widgetId: EVENTS_WIDGET_IDS.manage,
    config: input.config ?? { title: '活动维护', region: null },
    retryToken: 0,
    data: input.data,
    reportReady: input.reports.reportReady,
    reportEmpty: input.reports.reportEmpty,
    reportAsyncError: input.reports.reportAsyncError,
  };
}

/** 取出第 n 次（0 起）对某个操作的输入；没有该调用时明确抛错，而不是返回 undefined 让断言失真。 */
function callInput(spy: PortSpy, operation: string, index = 0): Record<string, unknown> {
  const matches = spy.mock.calls.filter(([name]) => name === operation);
  const call = matches[index];
  if (call === undefined || call[1] === null || typeof call[1] !== 'object') {
    throw new Error(`没有找到第 ${String(index + 1)} 次 ${operation} 调用的输入`);
  }
  return call[1] as Record<string, unknown>;
}

function callCount(spy: PortSpy, operation: string): number {
  return spy.mock.calls.filter(([name]) => name === operation).length;
}

describe('events-upcoming', () => {
  it('有数据时渲染标题、阶段徽章、未验证文案、本地时间区间与来源链接', async () => {
    const reports = createReports();
    const event = workspaceEvent({
      id: 'e1',
      title: '国服烟花大会',
      startsAt: at(18, 10, 30),
      endsAt: at(18, 11, 0),
      sourceUrl: 'https://example.com/events/e1',
    });
    const { port } = fakePort((operation) =>
      operation === EVENTS_PORT_OPERATIONS.listPersonal
        ? { events: [event], serverTimeMs: SERVER_TIME_MS }
        : { events: [], serverTimeMs: SERVER_TIME_MS },
    );

    render(<EventsUpcomingWidget {...upcomingProps({ reports, data: port })} />);

    // 可访问名称：`<section aria-labelledby>` 由标题给出名字。
    expect(await screen.findByRole('region', { name: '近期活动' })).toBeTruthy();
    expect(screen.getByText('国服烟花大会')).toBeTruthy();
    // serverTimeMs（本地 09:00）早于 startsAt（10:30）→ 未开始
    expect(screen.getByText('未开始')).toBeTruthy();
    expect(screen.getByText('国服')).toBeTruthy();
    expect(screen.getByText(EVENTS_MESSAGES.unverifiedBadge)).toBeTruthy();
    // 区间按**浏览器本地时间** YYYY-MM-DD HH:mm 渲染（不是 UTC，也不是语言相关格式）
    expect(screen.getByText('2026-10-18 10:30 — 2026-10-18 11:00')).toBeTruthy();

    const link = screen.getByRole('link', { name: 'https://example.com/events/e1' });
    expect(link.getAttribute('href')).toBe('https://example.com/events/e1');
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
    expect(link.getAttribute('target')).toBe('_blank');

    await waitFor(() => {
      expect(reports.reportReady).toHaveBeenCalledTimes(1);
    });
    expect(reports.reportEmpty).not.toHaveBeenCalled();
    expect(reports.reportAsyncError).not.toHaveBeenCalled();
  });

  it('没有数据时报告空态，并显示共享的诚实文案（不编造活动）', async () => {
    const reports = createReports();
    const { port } = fakePort(() => ({ events: [], serverTimeMs: SERVER_TIME_MS }));

    render(<EventsUpcomingWidget {...upcomingProps({ reports, data: port })} />);

    await waitFor(() => {
      expect(reports.reportEmpty).toHaveBeenCalledTimes(1);
    });
    expect(reports.reportReady).not.toHaveBeenCalled();
    expect(reports.reportAsyncError).not.toHaveBeenCalled();
    expect(screen.getByText(EVENTS_MESSAGES.publicEmpty)).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('端口抛错时报告异步错误（错误边界捕获不到它）', async () => {
    const reports = createReports();
    const { port } = fakePort((operation) => {
      if (operation === EVENTS_PORT_OPERATIONS.listPersonal) {
        throw new Error('端口故障');
      }
      return { events: [], serverTimeMs: SERVER_TIME_MS };
    });

    render(<EventsUpcomingWidget {...upcomingProps({ reports, data: port })} />);

    await waitFor(() => {
      expect(reports.reportAsyncError).toHaveBeenCalledTimes(1);
    });
    expect(reports.reportReady).not.toHaveBeenCalled();
    expect(reports.reportEmpty).not.toHaveBeenCalled();
    // 失败后不保留「正在加载」的假象，也不渲染任何数据（标题保留只是让用户知道
    // 是哪个组件失败；失败原因由 Host 的错误卡片给出）。
    expect(screen.queryByText('正在加载活动…')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('没有数据端口时拒绝执行：报告异步错误，且不渲染任何数据（组件不能自行取数）', async () => {
    const reports = createReports();
    const { container } = render(<EventsUpcomingWidget {...upcomingProps({ reports })} />);

    await waitFor(() => {
      expect(reports.reportAsyncError).toHaveBeenCalledTimes(1);
    });
    const error: unknown = reports.reportAsyncError.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(MISSING_PORT_MESSAGE);
    expect(reports.reportReady).not.toHaveBeenCalled();
    expect(reports.reportEmpty).not.toHaveBeenCalled();
    // 组件整体不渲染：没有标题、没有列表，也没有「假装加载中」的文案。
    expect(container.childElementCount).toBe(0);
    expect(screen.queryByText('近期活动')).toBeNull();
  });
});

describe('events-manage', () => {
  it('有可访问名称与表单标签（getByLabelText 可定位每个输入）', async () => {
    const reports = createReports();
    const { port } = fakePort(() => ({ events: [], serverTimeMs: SERVER_TIME_MS }));

    render(<EventsManageWidget {...manageProps({ reports, data: port })} />);

    expect(await screen.findByRole('region', { name: '活动维护' })).toBeTruthy();
    expect(screen.getByRole('form', { name: '新建活动' })).toBeTruthy();
    for (const label of [
      '标题',
      '区服',
      '开始时间（本地时间）',
      '结束时间（本地时间）',
      '描述',
      '来源链接（可选，必须是 https）',
    ]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    await waitFor(() => {
      expect(reports.reportReady).toHaveBeenCalledTimes(1);
    });
  });

  it('endsAt 早于 startsAt 时就地报错，且不发出任何写入请求', async () => {
    const reports = createReports();
    const user = userEvent.setup();
    const { port, spy } = fakePort(() => ({ events: [], serverTimeMs: SERVER_TIME_MS }));

    render(<EventsManageWidget {...manageProps({ reports, data: port })} />);
    await waitFor(() => {
      // 挂载时只有一次列表加载
      expect(spy).toHaveBeenCalledTimes(1);
    });

    await user.type(screen.getByLabelText('标题'), '时间写反的活动');
    fireEvent.change(screen.getByLabelText('开始时间（本地时间）'), { target: { value: '2026-10-18T12:00' } });
    fireEvent.change(screen.getByLabelText('结束时间（本地时间）'), { target: { value: '2026-10-18T11:00' } });
    await user.click(screen.getByRole('button', { name: '添加活动' }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('结束时间不能早于开始时间');
    });
    // 写入请求数为 0：本地拒绝发生在发请求之前（共享 validateEventRange 判定）。
    expect(callCount(spy, EVENTS_PORT_OPERATIONS.create)).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('合法提交：调用 events.create，起止时间是 UTC 毫秒，成功后刷新列表', async () => {
    const reports = createReports();
    const user = userEvent.setup();
    const { port, spy } = fakePort(() => ({ events: [], serverTimeMs: SERVER_TIME_MS }));

    render(<EventsManageWidget {...manageProps({ reports, data: port })} />);
    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });

    await user.type(screen.getByLabelText('标题'), '秋季活动');
    fireEvent.change(screen.getByLabelText('开始时间（本地时间）'), { target: { value: '2026-10-18T18:30' } });
    fireEvent.change(screen.getByLabelText('结束时间（本地时间）'), { target: { value: '2026-10-18T20:00' } });
    await user.click(screen.getByRole('button', { name: '添加活动' }));

    await waitFor(() => {
      expect(callCount(spy, EVENTS_PORT_OPERATIONS.create)).toBe(1);
    });

    const input = callInput(spy, EVENTS_PORT_OPERATIONS.create);
    // 具体数值断言：本地 18:30 对应的 UTC 毫秒（用偏移表达，因此在任何时区下都成立）。
    const startOffsetMs = new Date('2026-10-18T18:30').getTimezoneOffset() * 60_000;
    const endOffsetMs = new Date('2026-10-18T20:00').getTimezoneOffset() * 60_000;
    expect(input['startsAt']).toBe(Date.UTC(2026, 9, 18, 18, 30) + startOffsetMs);
    expect(input['startsAt']).toBe(new Date('2026-10-18T18:30').getTime());
    expect(input['endsAt']).toBe(Date.UTC(2026, 9, 18, 20, 0) + endOffsetMs);
    expect(Number.isInteger(input['startsAt'])).toBe(true);
    expect(Number.isInteger(input['endsAt'])).toBe(true);
    expect(input['title']).toBe('秋季活动');
    expect(input['region']).toBe('cn');
    expect(input['sourceUrl']).toBeNull();
    // 不声称来源已核实：个人活动的验证状态由服务端默认，组件不传该字段。
    expect(input['verificationStatus']).toBeUndefined();

    // 提交成功后重新拉取列表（挂载 1 次 + 刷新 1 次），而不是把本地草稿当成已保存。
    await waitFor(() => {
      expect(callCount(spy, EVENTS_PORT_OPERATIONS.listPersonal)).toBe(2);
    });
  });

  it('删除必须先确认：点「删除」只出现确认按钮，确认后才真的调用 events.delete', async () => {
    const reports = createReports();
    const user = userEvent.setup();
    const event = workspaceEvent({ id: 'e1', title: '待删除活动', revision: 3 });
    const { port, spy } = fakePort(() => ({ events: [event], serverTimeMs: SERVER_TIME_MS }));

    render(<EventsManageWidget {...manageProps({ reports, data: port })} />);
    expect(await screen.findByText('待删除活动')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '删除' }));
    // 仅点击「删除」不构成确认：此时不能有任何删除请求。
    expect(callCount(spy, EVENTS_PORT_OPERATIONS.delete)).toBe(0);
    expect(screen.getByRole('button', { name: '确认删除' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => {
      expect(callCount(spy, EVENTS_PORT_OPERATIONS.delete)).toBe(1);
    });
    // 删除带 CAS（expectedRevision）：不会静默覆盖别人的修改。
    expect(callInput(spy, EVENTS_PORT_OPERATIONS.delete)).toEqual({ id: 'e1', expectedRevision: 3 });
  });

  it('列表按共享排序的期望顺序渲染（最新的在前，并列项按 ID 升序）', async () => {
    const reports = createReports();
    const events = [
      workspaceEvent({ id: 'e-late', title: '最新活动', startsAt: at(20, 10, 0), endsAt: at(20, 12, 0) }),
      workspaceEvent({ id: 'b', title: '并列 B', startsAt: at(19, 10, 0), endsAt: at(19, 12, 0) }),
      workspaceEvent({ id: 'a', title: '并列 A', startsAt: at(19, 10, 0), endsAt: at(19, 12, 0) }),
      workspaceEvent({ id: 'e-early', title: '最早活动', startsAt: at(18, 10, 0), endsAt: at(18, 12, 0) }),
    ];
    const { port } = fakePort(() => ({ events, serverTimeMs: SERVER_TIME_MS }));

    render(<EventsManageWidget {...manageProps({ reports, data: port })} />);
    expect(await screen.findByText('最新活动')).toBeTruthy();

    const rendered = screen
      .getAllByRole('listitem')
      .map((item) => item.querySelector('h5')?.textContent ?? '');
    expect(rendered).toEqual(['最新活动', '并列 A', '并列 B', '最早活动']);
    // 与共享 `sortEvents` 的期望顺序一致（唯一实现，前后端不会漂移）。
    expect(rendered).toEqual(sortEvents(events, 'startsAtDesc').map((event) => event.title));
  });

  it('编辑结束时间：区间不合法时就地报错不发请求；合法时带 expectedRevision 走 CAS', async () => {
    const reports = createReports();
    const user = userEvent.setup();
    const event = workspaceEvent({
      id: 'e1',
      title: '可编辑活动',
      revision: 7,
      startsAt: at(18, 11, 0),
      endsAt: at(18, 12, 0),
    });
    const { port, spy } = fakePort(() => ({ events: [event], serverTimeMs: SERVER_TIME_MS }));

    render(<EventsManageWidget {...manageProps({ reports, data: port })} />);
    expect(await screen.findByText('可编辑活动')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '编辑结束时间' }));
    // 结束时间早于开始时间（11:00）→ 就地报错，不发请求。
    fireEvent.change(screen.getByLabelText('新的结束时间'), { target: { value: '2026-10-18T10:00' } });
    await user.click(screen.getByRole('button', { name: '保存结束时间' }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('结束时间不能早于开始时间');
    });
    expect(callCount(spy, EVENTS_PORT_OPERATIONS.update)).toBe(0);

    fireEvent.change(screen.getByLabelText('新的结束时间'), { target: { value: '2026-10-18T13:30' } });
    await user.click(screen.getByRole('button', { name: '保存结束时间' }));
    await waitFor(() => {
      expect(callCount(spy, EVENTS_PORT_OPERATIONS.update)).toBe(1);
    });
    const offsetMs = new Date('2026-10-18T13:30').getTimezoneOffset() * 60_000;
    expect(callInput(spy, EVENTS_PORT_OPERATIONS.update)).toEqual({
      id: 'e1',
      expectedRevision: 7,
      patch: { endsAt: Date.UTC(2026, 9, 18, 13, 30) + offsetMs },
    });
  });
});

// ---------------------------------------------------------------------------
// 端口层：请求形状、幂等 ID、错误解析（不发真实网络请求：fetch 被替换成受控 stub）
// ---------------------------------------------------------------------------

type FetchSpy = Mock<(url: string, init: RequestInit) => Promise<unknown>>;

interface FakeResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

function fakeResponse(body: unknown, status = 200): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

/** 替换全局 fetch；响应由 `responder` 决定（第 n 次调用可见）。 */
function stubFetch(responder: (url: string, init: RequestInit) => unknown): FetchSpy {
  const spy = vi.fn<(url: string, init: RequestInit) => Promise<unknown>>((url, init) =>
    Promise.resolve().then(() => responder(url, init)),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

function nthFetchCall(spy: FetchSpy, index: number): [string, RequestInit] {
  const call = spy.mock.calls[index];
  if (call === undefined) {
    throw new Error(`第 ${String(index + 1)} 次 fetch 调用不存在`);
  }
  return call;
}

function requestBodyOf(init: RequestInit): Record<string, unknown> {
  const raw = init.body;
  if (typeof raw !== 'string') {
    throw new Error('请求体不是 JSON 字符串');
  }
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('请求体不是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

function headerOf(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

describe('活动数据端口', () => {
  const TOKEN = 'tok_secret_value';

  function portWith(onUnauthorized?: () => void): ModuleDataPort {
    return createModuleDataPort({
      moduleId: EVENTS_MODULE_ID,
      context: {
        token: TOKEN,
        apiBaseUrl: '',
        moduleAccess: () => ({
          status: 'enabled',
          grantedCapabilities: [] as readonly ModuleCapability[],
        }),
        onUnauthorized,
      },
      factories: { [EVENTS_MODULE_ID]: eventsModulePortFactory },
    });
  }

  it('新建活动：区间不合法时本地拒绝，连请求都不发（共享 Schema 的 refine 生效）', async () => {
    const fetchSpy = stubFetch(() => fakeResponse({}));
    const port = portWith();

    await expect(
      port.call(EVENTS_PORT_OPERATIONS.create, {
        title: '非法区间',
        region: 'cn',
        startsAt: 2_000,
        endsAt: 1_000,
      }),
    ).rejects.toThrow(/不合法/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('新建活动：凭证只走 Authorization 头，同一意图重试复用同一个 operationId', async () => {
    const fetchSpy = stubFetch(() => fakeResponse({}, 201));
    const port = portWith();
    const body = { title: '活动', description: '', region: 'cn', startsAt: 1_000, endsAt: 2_000, sourceUrl: null };

    await port.call(EVENTS_PORT_OPERATIONS.create, body);
    await port.call(EVENTS_PORT_OPERATIONS.create, body);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = nthFetchCall(fetchSpy, 0);
    const [, secondInit] = nthFetchCall(fetchSpy, 1);
    expect(firstUrl).toBe('/api/v1/me/events');
    // 凭证绝不进 URL。
    expect(firstUrl).not.toContain(TOKEN);
    expect(headerOf(firstInit, 'Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headerOf(firstInit, 'Content-Type')).toBe('application/json');
    const firstBody = requestBodyOf(firstInit);
    const secondBody = requestBodyOf(secondInit);
    expect(typeof firstBody['operationId']).toBe('string');
    expect(firstBody['operationId']).toBe(secondBody['operationId']);
  });

  it('个人活动列表：响应不符合共享契约时抛错，不返回半可信数据', async () => {
    stubFetch(() => fakeResponse({ events: [{ id: 'x' }], serverTimeMs: 1 }));
    const port = portWith();

    await expect(port.call(EVENTS_PORT_OPERATIONS.listPersonal, {})).rejects.toThrow(/不符合共享契约/);
  });

  it('401：先调用 onUnauthorized，再抛错；错误消息里不含凭证', async () => {
    stubFetch(() => fakeResponse({ code: 'unauthorized', message: '需要有效的设备凭证。', requestId: 'req-2' }, 401));
    const onUnauthorized = vi.fn<() => void>();
    const port = portWith(onUnauthorized);

    const error: unknown = await port.call(EVENTS_PORT_OPERATIONS.listPersonal, {}).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(EventsPortError);
    const portError = error as EventsPortError;
    expect(portError.status).toBe(401);
    expect(portError.message).not.toContain(TOKEN);
  });

  it('409 冲突：解析 details.conflict，抛出「服务器上是 revision N，你基于 M」', async () => {
    const conflict = {
      reason: 'revision_conflict',
      entityType: 'workspace_event',
      entityId: 'e1',
      field: null,
      baseRevision: 2,
      currentRevision: 5,
      resolutionOptions: ['server', 'local'],
    };
    stubFetch(() =>
      fakeResponse(
        { code: 'conflict', message: '资源状态冲突。', requestId: 'req-1', details: { conflict } },
        409,
      ),
    );
    const port = portWith();

    const error: unknown = await port
      .call(EVENTS_PORT_OPERATIONS.update, { id: 'e1', expectedRevision: 2, patch: { endsAt: 5_000 } })
      .then(
        () => null,
        (reason: unknown) => reason,
      );
    expect(error).toBeInstanceOf(EventsPortError);
    const portError = error as EventsPortError;
    expect(portError.status).toBe(409);
    expect(portError.conflict?.currentRevision).toBe(5);
    expect(portError.details).toEqual({ conflict });
    expect(portError.message).toContain('服务器上是 revision 5，你基于 2');
    expect(portError.message).not.toContain(TOKEN);
  });
});
