/**
 * 导航数据端口测试（阶段 04 / HUB-010）。
 *
 * 这些用例守护的是**边界**而不是实现细节：
 * - 未声明的操作名 / 模块门禁不可用 → 拒绝，且**一次网络请求都不发**；
 * - 输入不合法（例如危险协议的 URL）→ 拒绝且不发请求；
 * - 响应不符合契约 → 抛错，绝不把半可信数据交给组件；
 * - 凭证只走 `Authorization` 头，**绝不**出现在 URL 或错误消息里；
 * - `409` 的结构化冲突被解析成带 `details`（`conflict`）的错误。
 */
// @vitest-environment jsdom
import { NAV_MODULE_ID, type ModuleCapability } from '@ff14-hub/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavPortError, NAV_PORT_OPERATIONS } from '../src/app/nav/nav-data-port';
import { createModuleDataPort, type ModulePortContext } from '../src/app/widgets/module-data-ports';
import { link, snapshot } from './nav-fixtures';

const ALL_CAPABILITIES: readonly ModuleCapability[] = ['storage:own', 'navigation:read-catalog'];
const TOKEN = 'secret-device-token-abcdef';

function context(overrides: Partial<ModulePortContext> = {}): ModulePortContext {
  return {
    token: TOKEN,
    apiBaseUrl: '',
    moduleAccess: () => ({ status: 'enabled', grantedCapabilities: ALL_CAPABILITIES }),
    ...overrides,
  };
}

function portFor(overrides: Partial<ModulePortContext> = {}) {
  return createModuleDataPort({ moduleId: NAV_MODULE_ID, context: context(overrides) });
}

/** 形如 `fetch` 的替身：记录调用，按队列返回响应。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('操作表与拒绝语义', () => {
  it('声明的操作名正好是契约里的 16 个（不多不少）', () => {
    const port = portFor();
    expect([...port.operations].sort((a, b) => a.localeCompare(b))).toEqual([...NAV_PORT_OPERATIONS].sort((a, b) => a.localeCompare(b)));
  });

  it('未声明的操作名被拒绝，且不发生任何网络请求', async () => {
    const port = portFor();
    await expect(port.call('nav.purgeEverything')).rejects.toThrow(/未声明操作/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('模块门禁为 disabled / transitioning 时调用被拒绝，且 0 次 fetch', async () => {
    for (const status of ['disabled', 'transitioning', 'uninstalled', 'not_installed'] as const) {
      fetchMock.mockClear();
      const port = portFor({ moduleAccess: () => ({ status, grantedCapabilities: ALL_CAPABILITIES }) });
      await expect(port.call('nav.snapshot')).rejects.toThrow(/已被拒绝/);
      expect(fetchMock, `status=${status}`).not.toHaveBeenCalled();
    }
  });

  it('输入不满足契约（危险协议的 URL）时拒绝发请求', async () => {
    const port = portFor();
    await expect(
      port.call('nav.createLink', { title: '恶意', url: 'javascript:alert(1)' }),
    ).rejects.toBeInstanceOf(NavPortError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('组件无法通过输入夹带作用域字段（多带字段即被拒绝）', async () => {
    const port = portFor();
    await expect(
      port.call('nav.updateLink', { linkId: 'L1', expectedRevision: 1, title: '甲', workspaceId: 'other' }),
    ).rejects.toBeInstanceOf(NavPortError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('凭证纪律', () => {
  it('Authorization 头存在，且 Token 不出现在 URL 里', async () => {
    fetchMock.mockResolvedValue(jsonResponse(snapshot({ links: [link('L1')] })));
    const port = portFor();
    const result = await port.call('nav.snapshot');

    expect(result).toMatchObject({ revision: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/me/navigation');
    expect(url).not.toContain(TOKEN);
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('错误消息里不含 Token（只回显服务端已脱敏的 code/message/requestId）', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 'internal_error', message: '服务器内部错误。', requestId: 'req-9' }, 500),
    );
    const port = portFor();
    const error = await port.call('nav.snapshot').then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(NavPortError);
    expect(String(error)).not.toContain(TOKEN);
  });

  it('listLinks 的查询串只含筛选字段（不含凭证）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ links: [], revision: 3 }));
    const port = portFor();
    await port.call('nav.links', { text: '极神', region: 'cn', favoritesOnly: true, sort: 'manual' });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('text=');
    expect(url).toContain('favoritesOnly=true');
    expect(url).not.toContain(TOKEN);
  });
});

describe('响应校验与冲突', () => {
  it('响应不符合契约时抛错，不返回半可信数据', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ links: 'not-an-array' }));
    const port = portFor();
    await expect(port.call('nav.snapshot')).rejects.toThrow(/响应不符合契约/);
  });

  it('409 结构化冲突被解析成带 conflict 的错误（含 currentRevision）', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          code: 'conflict',
          message: '该数据已被其他设备修改，请先比较差异再提交。',
          requestId: 'req-409',
          details: {
            conflict: {
              reason: 'revision_conflict',
              entityType: 'nav_link',
              entityId: 'L1',
              field: null,
              baseRevision: 3,
              currentRevision: 7,
              resolutionOptions: ['local', 'server'],
            },
          },
        },
        409,
      ),
    );
    const port = portFor();
    const error = await port
      .call('nav.updateLink', { linkId: 'L1', expectedRevision: 3, title: '甲' })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(NavPortError);
    const portError = error as NavPortError;
    expect(portError.code).toBe('conflict');
    expect(portError.status).toBe(409);
    expect(portError.conflict).not.toBeNull();
    expect(portError.conflict?.baseRevision).toBe(3);
    expect(portError.conflict?.currentRevision).toBe(7);
    expect(portError.message).toContain('其他设备');
  });

  it('缺少 navigation:read-catalog 能力时读取目录被拒绝，且 0 次 fetch', async () => {
    const port = portFor({
      moduleAccess: () => ({ status: 'enabled', grantedCapabilities: ['storage:own'] }),
    });
    await expect(port.call('nav.catalog')).rejects.toThrow(/navigation:read-catalog/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('凭证失效时会调用 onUnauthorized（而不是只抛错）', async () => {
    const onUnauthorized = vi.fn();
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 'unauthorized', message: '需要有效的设备凭证。', requestId: 'req-1' }, 401),
    );
    const port = portFor({ onUnauthorized });
    await expect(port.call('nav.snapshot')).rejects.toBeInstanceOf(NavPortError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('operationId 由端口生成：组件不传也带上了合法 ID，且同一次调用只有一个', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ link: link('L9') }));
    const port = portFor();
    await port.call('nav.createLink', { title: '甲', url: 'https://example.com/a' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const rawBody = init.body;
    // ody 的类型是 BodyInit（可能是 Blob / FormData / stream），这里显式收窄成字符串，
    // 而不是依赖默认的 String() 序列化（那会把对象变成 "[object Object]"）。
    expect(typeof rawBody).toBe('string');
    const body = JSON.parse(typeof rawBody === 'string' ? rawBody : '{}') as { operationId?: string };
    expect(typeof body.operationId).toBe('string');
    expect(body.operationId?.length ?? 0).toBeGreaterThanOrEqual(8);
  });
});
