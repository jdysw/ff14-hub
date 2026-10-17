/**
 * Widget Host 渲染与交互测试（HUB-044 验收，jsdom + React Testing Library）。
 *
 * 覆盖用户要求的验收点：
 * 多实例配置互不串扰、配置失效（需迁移 / 无迁移 / 版本过高 / 不合法）、
 * 加载态、空态、渲染错误、**异步错误**、重试（含键盘激活）、
 * 兄弟实例存活、Shell 存活、权限不足与模块停用/卸载的降级。
 */
// @vitest-environment jsdom
import { type ModuleCapability, type ModuleManifest, type WidgetConfigContract } from '@ff14-hub/shared';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createWidgetComponentRegistry,
  type WidgetComponentRegistry,
} from '../src/app/widgets/component-registry';
import type { WidgetInstance } from '../src/app/widgets/instance-store';
import { WidgetHost } from '../src/app/widgets/WidgetHost';
import type { ModuleAccess, WidgetRuntimeProps } from '../src/app/widgets/types';

afterEach(() => {
  cleanup();
});

const DEMO_WIDGET_IDS = {
  counter: 'demo-counter',
  fault: 'demo-fault',
  solo: 'demo-solo',
} as const;

function enabledAccess(granted: readonly ModuleCapability[] = []): (moduleId: string) => ModuleAccess {
  return () => ({ status: 'enabled', grantedCapabilities: granted });
}

function demoInstance(overrides: Partial<WidgetInstance> = {}): WidgetInstance {
  return {
    instanceId: 'i1',
    moduleId: 'demo.basics',
    widgetId: DEMO_WIDGET_IDS.counter,
    config: { step: 1, label: '甲', initDelayMs: 0 },
    configVersion: 1,
    hidden: false,
    ...overrides,
  };
}

function cardFor(instanceId: string): HTMLElement {
  const cards = screen.getAllByTestId('widget-instance');
  const card = cards.find((element) => element.getAttribute('data-instance-id') === instanceId);
  if (card === undefined) {
    throw new Error(`找不到实例卡片：${instanceId}`);
  }
  return card;
}

/** 构造一个只含自定义组件的注册表，用于验证权限 / 版本 / 超时等分支。 */
interface WidgetSpec {
  readonly widgetId: string;
  readonly moduleId?: string;
  readonly capabilities?: readonly ModuleCapability[];
  readonly Component: (props: WidgetRuntimeProps) => ReactNode;
  readonly configSchemaVersion?: number;
  readonly migrations?: Readonly<Record<number, (raw: unknown) => unknown>>;
  readonly schema?: z.ZodType;
}

/**
 * 按模块分组构造注册表（同 moduleId 的 spec 落在同一个 Manifest 里）。
 * 这样才能在同一个 Host 里同时放「会抛错的组件」与「正常组件」，用于兄弟隔离断言。
 */
function buildRegistry(specs: readonly WidgetSpec[]): WidgetComponentRegistry {
  const byModule = new Map<string, WidgetSpec[]>();
  for (const spec of specs) {
    const moduleId = spec.moduleId ?? 'test.module';
    const list = byModule.get(moduleId) ?? [];
    list.push(spec);
    byModule.set(moduleId, list);
  }
  const manifests: ModuleManifest[] = [];
  const contracts: WidgetConfigContract[] = [];
  const components: Record<string, (props: WidgetRuntimeProps) => ReactNode> = {};
  for (const [moduleId, moduleSpecs] of byModule) {
    const capabilities = [...new Set(moduleSpecs.flatMap((spec) => spec.capabilities ?? []))];
    manifests.push({
      id: moduleId,
      version: '1.0.0',
      displayName: `测试模块 ${moduleId}`,
      capabilities,
      widgets: moduleSpecs.map((spec) => ({
        id: spec.widgetId,
        moduleId,
        displayName: `测试组件 ${spec.widgetId}`,
        allowMultiple: true,
        defaultSize: { w: 2, h: 2 },
        minSize: { w: 1, h: 1 },
        configSchemaVersion: spec.configSchemaVersion ?? 1,
      })),
      routes: [],
      settingsSchemaVersion: 1,
      lifecycle: {},
    });
    for (const spec of moduleSpecs) {
      contracts.push({
        widgetId: spec.widgetId,
        configSchemaVersion: spec.configSchemaVersion ?? 1,
        schema: spec.schema ?? z.object({}).passthrough(),
        defaultConfig: {},
        migrations: spec.migrations ?? {},
      });
      components[spec.widgetId] = spec.Component;
    }
  }
  return createWidgetComponentRegistry({ manifests, contracts, components });
}

function registryWith(spec: WidgetSpec): WidgetComponentRegistry {
  return buildRegistry([spec]);
}

/** 永远不报告就绪的组件（用于加载超时兜底）。 */
function NeverReadyWidget(): ReactNode {
  return <p>我永远不会就绪</p>;
}

/** 第一次异步失败，重试后成功（用于验证重试真的重新执行了加载逻辑）。 */
function FlakyWidget(props: WidgetRuntimeProps) {
  const { retryToken, reportReady, reportAsyncError } = props;
  useEffect(() => {
    if (retryToken === 0) {
      reportAsyncError(new Error('第一次加载失败'));
      return;
    }
    reportReady();
  }, [retryToken, reportReady, reportAsyncError]);
  return <p>第二次加载成功</p>;
}

describe('多实例与配置隔离', () => {
  it('两个同类型实例各自独立：改变一个的计数不影响另一个', async () => {
    const user = userEvent.setup();
    render(
      <WidgetHost
        instances={[
          demoInstance({ instanceId: 'a', config: { step: 1, label: '甲', initDelayMs: 0 } }),
          demoInstance({ instanceId: 'b', config: { step: 3, label: '乙', initDelayMs: 0 } }),
        ]}
        access={enabledAccess()}
      />,
    );

    const cardA = cardFor('a');
    const cardB = cardFor('b');
    // 组件需要一次异步报告就绪，因此用 findBy（会等待）。
    expect(await within(cardA).findByText('甲')).toBeDefined();
    expect(await within(cardB).findByText('乙')).toBeDefined();

    await user.click(await within(cardA).findByRole('button', { name: '+1' }));
    await user.click(within(cardA).getByRole('button', { name: '+1' }));
    await user.click(within(cardA).getByRole('button', { name: '+1' }));

    expect(within(cardA).getByRole('status').textContent).toBe('3');
    // 另一个实例的计数与步长完全不受影响。
    expect(within(cardB).getByRole('status').textContent).toBe('0');
    expect(within(cardB).getByRole('button', { name: '+3' })).toBeDefined();
  });

  it('旧版本配置按显式迁移升级后，组件按新配置渲染', async () => {
    render(
      <WidgetHost
        instances={[demoInstance({ config: { increment: 4 }, configVersion: 0 })]}
        access={enabledAccess()}
      />,
    );
    // 迁移结果 step=4 体现在按钮文案上，说明迁移后的配置真的被用上了。
    expect(await screen.findByRole('button', { name: '+4' })).toBeDefined();
  });

  it('隐藏的实例不渲染；可见实例正常渲染', () => {
    render(
      <WidgetHost
        instances={[
          demoInstance({ instanceId: 'a' }),
          demoInstance({ instanceId: 'b', hidden: true }),
        ]}
        access={enabledAccess()}
      />,
    );
    expect(screen.getAllByTestId('widget-instance')).toHaveLength(1);
  });

  it('没有可见实例时显示空态说明', () => {
    render(<WidgetHost instances={[]} access={enabledAccess()} />);
    expect(screen.getByText(/当前没有可见的组件实例/)).toBeDefined();
  });
});

describe('配置失效', () => {
  it('配置版本高于组件当前版本：显示配置错误且不执行组件', () => {
    render(
      <WidgetHost
        instances={[demoInstance({ config: { step: 1 }, configVersion: 99 })]}
        access={enabledAccess()}
      />,
    );
    const card = cardFor('i1');
    expect(card.getAttribute('data-phase')).toBe('blocked:config');
    expect(within(card).getByText('配置无法使用')).toBeDefined();
    // 组件**没有**被执行：不该出现计数按钮。
    expect(within(card).queryByRole('button', { name: '+1' })).toBeNull();
  });

  it('缺少可用迁移：显示配置错误且不执行组件', () => {
    render(
      <WidgetHost
        instances={[
          demoInstance({
            // 归属必须与注册表一致（demo-solo 属于 demo.solo），否则会先被归属校验拦下。
            widgetId: DEMO_WIDGET_IDS.solo,
            moduleId: 'demo.solo',
            config: {},
            configVersion: 0,
          }),
        ]}
        access={enabledAccess()}
      />,
    );
    const card = cardFor('i1');
    expect(within(card).getByText(/缺少从版本 0 到 1 的显式迁移/)).toBeDefined();
  });

  it('未知组件类型：显示「不受支持的组件类型」而不是动态加载', () => {
    render(
      <WidgetHost
        instances={[demoInstance({ widgetId: 'ghost-widget' })]}
        access={enabledAccess()}
      />,
    );
    expect(screen.getByText('不受支持的组件类型')).toBeDefined();
  });

  it('配置不满足 Schema：显示配置错误', () => {
    render(
      <WidgetHost
        instances={[demoInstance({ config: { step: 'many' }, configVersion: 1 })]}
        access={enabledAccess()}
      />,
    );
    expect(screen.getByText('配置无法使用')).toBeDefined();
  });
});

describe('加载态、空态与超时', () => {
  it('组件未就绪时显示加载态，就绪后显示内容', async () => {
    render(
      <WidgetHost
        instances={[demoInstance({ config: { step: 1, label: '甲', initDelayMs: 30 } })]}
        access={enabledAccess()}
      />,
    );
    expect(screen.getByText('正在加载组件…')).toBeDefined();
    expect(await screen.findByRole('button', { name: '+1' })).toBeDefined();
    expect(screen.queryByText('正在加载组件…')).toBeNull();
  });

  it('组件报告空态时显示空态卡片并提供重试', async () => {
    const user = userEvent.setup();
    render(
      <WidgetHost
        instances={[
          demoInstance({
            widgetId: DEMO_WIDGET_IDS.fault,
            config: { mode: 'empty', delayMs: 0 },
          }),
        ]}
        access={enabledAccess()}
      />,
    );
    expect(await screen.findByText('暂无内容')).toBeDefined();
    expect(screen.getByRole('button', { name: '重试' })).toBeDefined();
    // 空态不会误报错误。
    expect(screen.queryByText(/失败/)).toBeNull();
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('暂无内容')).toBeDefined();
  });

  it('组件一直不就绪时由 Host 超时兜底，而不是永久卡在加载中', async () => {
    const registry = registryWith({ widgetId: 'never', Component: NeverReadyWidget });
    render(
      <WidgetHost
        instances={[demoInstance({ widgetId: 'never', moduleId: 'test.module', config: {} })]}
        access={enabledAccess()}
        registry={registry}
        loadingTimeoutMs={20}
      />,
    );
    expect(await screen.findByText('组件加载超时')).toBeDefined();
  });
});

describe('错误隔离', () => {
  it('渲染期错误被隔离：兄弟实例可交互，Shell 仍存活', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <h1>Shell 标题</h1>
        <WidgetHost
          instances={[
            demoInstance({ instanceId: 'bad', widgetId: DEMO_WIDGET_IDS.fault, config: { mode: 'render-error', delayMs: 0 } }),
            demoInstance({ instanceId: 'good', config: { step: 2, label: '正常实例', initDelayMs: 0 } }),
          ]}
          access={enabledAccess()}
        />
      </div>,
    );

    expect(await screen.findByText('组件渲染失败')).toBeDefined();
    expect(cardFor('bad').getAttribute('data-phase')).toBe('error');

    // Shell 没有被击穿。
    expect(screen.getByText('Shell 标题')).toBeDefined();
    // 兄弟实例仍然活着且可交互。
    const good = cardFor('good');
    await user.click(await within(good).findByRole('button', { name: '+2' }));
    expect(within(good).getByRole('status').textContent).toBe('2');
  });

  it('异步错误被单独处理（错误边界捕获不到它），且不影响兄弟实例的已有状态', async () => {
    const user = userEvent.setup();
    render(
      <WidgetHost
        instances={[
          demoInstance({ instanceId: 'good', config: { step: 1, label: '正常实例', initDelayMs: 0 } }),
          demoInstance({
            instanceId: 'bad',
            widgetId: DEMO_WIDGET_IDS.fault,
            config: { mode: 'async-error', delayMs: 0 },
          }),
        ]}
        access={enabledAccess()}
      />,
    );

    const good = cardFor('good');
    await user.click(await within(good).findByRole('button', { name: '+1' }));
    expect(within(good).getByRole('status').textContent).toBe('1');

    // 异步失败必须被 Host 渲染成错误卡片，而不是静默失败或炸掉页面。
    expect(await screen.findByText('组件异步加载失败')).toBeDefined();
    expect(screen.getByText('演示：异步加载失败（模拟网络错误）')).toBeDefined();

    // 兄弟实例的计数没有被重置。
    expect(within(cardFor('good')).getByRole('status').textContent).toBe('1');
  });

  it('重试会真正重新执行加载逻辑，并且可以用键盘激活', async () => {
    const user = userEvent.setup();
    const registry = registryWith({ widgetId: 'flaky', Component: FlakyWidget });
    render(
      <WidgetHost
        instances={[demoInstance({ widgetId: 'flaky', moduleId: 'test.module', config: {} })]}
        access={enabledAccess()}
        registry={registry}
      />,
    );

    expect(await screen.findByText('组件异步加载失败')).toBeDefined();
    const retry = screen.getByRole('button', { name: '重试' });
    retry.focus();
    expect(document.activeElement).toBe(retry);
    // 键盘激活（Enter）而不是鼠标点击。
    await user.keyboard('{Enter}');

    expect(await screen.findByText('第二次加载成功')).toBeDefined();
    expect(screen.queryByText('组件异步加载失败')).toBeNull();
  });
});

describe('权限与模块状态降级', () => {
  function NeverRendered(): ReactNode {
    throw new Error('降级时这个组件不应被执行');
  }

  it('缺少服务端授予的能力时降级，且不执行组件', () => {
    const registry = registryWith({
      widgetId: 'gated',
      capabilities: ['storage:own'],
      Component: NeverRendered,
    });
    render(
      <WidgetHost
        instances={[demoInstance({ widgetId: 'gated', moduleId: 'test.module', config: {} })]}
        access={enabledAccess([])}
        registry={registry}
      />,
    );
    const card = cardFor('i1');
    expect(card.getAttribute('data-phase')).toBe('blocked:permission');
    expect(within(card).getByText('权限不足，该实例未执行')).toBeDefined();
    expect(within(card).getByText(/storage:own/)).toBeDefined();
  });

  it('能力已授予时正常执行', async () => {
    const registry = registryWith({
      widgetId: 'gated',
      capabilities: ['storage:own'],
      Component: (props: WidgetRuntimeProps) => {
        const { reportReady, retryToken } = props;
        useEffect(() => {
          reportReady();
        }, [reportReady, retryToken]);
        return <p>能力已授予</p>;
      },
    });
    render(
      <WidgetHost
        instances={[demoInstance({ widgetId: 'gated', moduleId: 'test.module', config: {} })]}
        access={enabledAccess(['storage:own'])}
        registry={registry}
      />,
    );
    expect(await screen.findByText('能力已授予')).toBeDefined();
  });

  it('模块已停用 / 已卸载：安全降级且不执行组件', () => {
    for (const status of ['disabled', 'uninstalled', 'not_installed'] as const) {
      cleanup();
      render(
        <WidgetHost
          instances={[demoInstance()]}
          access={() => ({ status, grantedCapabilities: [] })}
        />,
      );
      const card = cardFor('i1');
      expect(card.getAttribute('data-phase')).toBe('blocked:module');
      expect(within(card).queryByRole('button', { name: '+1' })).toBeNull();
    }
  });

  it('降级卡片明确说明不会改变个人数据与模块状态', () => {
    render(<WidgetHost instances={[demoInstance()]} access={() => ({ status: 'disabled', grantedCapabilities: [] })} />);
    expect(screen.getByText(/个人数据与模块状态不会因为实例降级而改变/)).toBeDefined();
  });
});

describe('实例级操作', () => {
  it('隐藏与移除按钮调用回调，且只针对该实例', async () => {
    const user = userEvent.setup();
    const hidden: { instanceId: string; hidden: boolean }[] = [];
    const removed: string[] = [];
    render(
      <WidgetHost
        instances={[demoInstance({ instanceId: 'a' }), demoInstance({ instanceId: 'b' })]}
        access={enabledAccess()}
        onToggleHidden={(instanceId, isHidden) => {
          hidden.push({ instanceId, hidden: isHidden });
        }}
        onRemoveInstance={(instanceId) => {
          removed.push(instanceId);
        }}
      />,
    );

    await user.click(within(cardFor('b')).getByRole('button', { name: '隐藏' }));
    expect(hidden).toEqual([{ instanceId: 'b', hidden: true }]);

    await user.click(within(cardFor('a')).getByRole('button', { name: '移除实例' }));
    expect(removed).toEqual(['a']);
  });
});

describe('归属、解析异常与 attempt 隔离', () => {
  function ReadyWidget(props: WidgetRuntimeProps) {
    const { reportReady } = props;
    useEffect(() => {
      reportReady();
    }, [reportReady]);
    return <p>就绪内容</p>;
  }

  it('实例声明的模块与注册表归属不一致时拒绝执行（不能借启用中的模块执行别的模块组件）', () => {
    const executed = vi.fn();
    const registry = buildRegistry([
      {
        widgetId: 'owned-widget',
        Component: () => {
          executed();
          return <p>不该被渲染</p>;
        },
      },
    ]);
    render(
      <WidgetHost
        // 伪造：组件属于 test.module，但实例自称属于 other.module（其门禁是 enabled）。
        instances={[demoInstance({ widgetId: 'owned-widget', moduleId: 'other.module' })]}
        access={enabledAccess()}
        registry={registry}
      />,
    );

    const card = cardFor('i1');
    expect(card.getAttribute('data-phase')).toBe('blocked:ownership');
    expect(within(card).getByText('实例归属不一致，已拒绝执行')).toBeDefined();
    expect(within(card).getByText(/以注册表为准/)).toBeDefined();
    expect(executed).not.toHaveBeenCalled();
  });

  it('配置迁移函数抛错时降级为**本实例**配置错误，不打穿兄弟与区域', async () => {
    const registry = buildRegistry([
      {
        widgetId: 'throwing',
        configSchemaVersion: 2,
        migrations: {
          1: () => {
            throw new Error('迁移炸了');
          },
        },
        Component: ReadyWidget,
      },
      { widgetId: 'ok-widget', Component: ReadyWidget },
    ]);
    render(
      <div>
        <h1>Shell 标题</h1>
        <WidgetHost
          instances={[
            demoInstance({ instanceId: 'bad', widgetId: 'throwing', moduleId: 'test.module', config: {}, configVersion: 1 }),
            demoInstance({ instanceId: 'good', widgetId: 'ok-widget', moduleId: 'test.module', config: {}, configVersion: 1 }),
          ]}
          access={enabledAccess()}
          registry={registry}
        />
      </div>,
    );

    const bad = cardFor('bad');
    expect(bad.getAttribute('data-phase')).toBe('blocked:config');
    expect(within(bad).getByText(/配置解析或迁移过程抛出异常：迁移炸了/)).toBeDefined();
    // 兄弟实例与 Shell 都没被打穿。
    expect(await screen.findByText('就绪内容')).toBeDefined();
    expect(screen.getByText('Shell 标题')).toBeDefined();
  });

  it('重试后旧 attempt 的迟到回调不会改写新 attempt 的状态', async () => {
    const user = userEvent.setup();
    const stale: { reporter: ((error: unknown) => void) | null } = { reporter: null };

    function LateFailWidget(props: WidgetRuntimeProps) {
      const { retryToken, reportReady, reportAsyncError } = props;
      useEffect(() => {
        if (retryToken === 0) {
          // 保存「第一次 attempt」的上报函数：它代表一次没有清理干净的异步操作。
          stale.reporter = reportAsyncError;
          reportAsyncError(new Error('第一次失败'));
          return;
        }
        reportReady();
      }, [retryToken, reportReady, reportAsyncError]);
      return <p>第二次就绪</p>;
    }

    const registry = registryWith({ widgetId: 'late', Component: LateFailWidget });
    render(
      <WidgetHost
        instances={[demoInstance({ widgetId: 'late', moduleId: 'test.module', config: {} })]}
        access={enabledAccess()}
        registry={registry}
      />,
    );

    expect(await screen.findByText('组件异步加载失败')).toBeDefined();
    const retry = screen.getByRole('button', { name: '重试' });
    retry.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('第二次就绪')).toBeDefined();
    expect(cardFor('i1').getAttribute('data-phase')).toBe('ready');

    // 旧 attempt 的错误迟到：必须被忽略，不能把新 attempt 打回错误态。
    await act(() => {
      stale.reporter?.(new Error('迟到的旧错误'));
      return Promise.resolve();
    });
    expect(cardFor('i1').getAttribute('data-phase')).toBe('ready');
    expect(screen.getByText('第二次就绪')).toBeDefined();
    expect(screen.queryByText('组件异步加载失败')).toBeNull();
  });
});
