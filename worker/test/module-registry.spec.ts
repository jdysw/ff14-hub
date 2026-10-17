/**
 * Module Registry 测试（HUB-043 验收）。
 *
 * 立场：这里断言的是**注册表的行为**（哪个诊断码、哪条原因），不是把实现里的常量抄一遍。
 * 断言的是「拒绝/接受」这件事本身，因此删掉任何一条校验规则都会让用例失败。
 */
import {
  BUILTIN_MODULE_MANIFESTS,
  BUILTIN_WIDGET_CONFIG_CONTRACTS,
  DEMO_BASICS_MODULE_ID,
  DEMO_FAULT_MODES,
  DEMO_SOLO_MODULE_ID,
  DEMO_WIDGET_IDS,
  findWidgetConfigContract,
} from '@ff14-hub/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BUILTIN_HANDLER_NAMES, builtinModuleRegistry } from '../modules/registry/builtin-modules';
import {
  buildModuleRegistry,
  buildModuleRegistryOrThrow,
  type ModuleRegistrationInput,
  type ModuleRegistry,
  type RegistryDiagnostic,
} from '../modules/registry/module-registry';

const TEST_MODULE_ID = 'test.module';

function widget(id: string, moduleId: string = TEST_MODULE_ID): Record<string, unknown> {
  return {
    id,
    moduleId,
    displayName: '测试组件',
    allowMultiple: true,
    defaultSize: { w: 2, h: 2 },
    minSize: { w: 1, h: 1 },
    configSchemaVersion: 1,
  };
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TEST_MODULE_ID,
    version: '1.0.0',
    displayName: '测试模块',
    capabilities: [],
    widgets: [widget('test-widget')],
    routes: [{ path: '/test', viewId: 'test-view' }],
    settingsSchemaVersion: 1,
    lifecycle: { onEnable: 'test.enable' },
    ...overrides,
  };
}

function registration(overrides: Partial<ModuleRegistrationInput> = {}): ModuleRegistrationInput {
  return {
    manifest: manifest(),
    handlerTable: { 'test.enable': (): void => undefined },
    settingsSchema: z.object({}).strict(),
    settingsSchemaVersion: 1,
    grantedCapabilities: [],
    ...overrides,
  };
}

function expectRejected(input: ModuleRegistrationInput): readonly RegistryDiagnostic[] {
  const build = buildModuleRegistry([input]);
  if (build.ok) {
    throw new Error('该注册本应被拒绝，但注册表接受了它');
  }
  return build.diagnostics;
}

function expectAccepted(inputs: readonly ModuleRegistrationInput[]): ModuleRegistry {
  const build = buildModuleRegistry(inputs);
  if (!build.ok) {
    throw new Error(`该注册本应成功，但被拒绝：${build.diagnostics.map((d) => d.code).join(', ')}`);
  }
  return build.registry;
}

function codesOf(diagnostics: readonly RegistryDiagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

describe('基础注册与发现', () => {
  it('接受一个合法注册，并可通过 ID 与 Widget 类型 ID 查到', () => {
    const registry = expectAccepted([registration()]);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get(TEST_MODULE_ID)?.manifest.version).toBe('1.0.0');
    expect(registry.findWidget('test-widget')?.module.manifest.id).toBe(TEST_MODULE_ID);
  });

  it('查询未注册的模块返回 undefined，而不是伪造一个空对象', () => {
    const registry = expectAccepted([registration()]);
    expect(registry.get('no.such.module')).toBeUndefined();
    expect(registry.findWidget('no-such-widget')).toBeUndefined();
  });

  it('能力默认拒绝：未授予的能力不会被 hasCapability 认可', () => {
    const registry = expectAccepted([registration()]);
    expect(registry.hasCapability(TEST_MODULE_ID, 'storage:own')).toBe(false);
  });
});

describe('内置演示模块', () => {
  it('内置注册表可构建，且两个演示模块都在目录里', () => {
    const ids = builtinModuleRegistry.list().map((module) => module.manifest.id);
    expect(ids).toContain(DEMO_BASICS_MODULE_ID);
    expect(ids).toContain(DEMO_SOLO_MODULE_ID);
  });

  it('公开描述（descriptor）只含非敏感元数据，不含任何 handler 名', () => {
    for (const module of builtinModuleRegistry.list()) {
      const serialized = JSON.stringify(module.descriptor);
      for (const handlerName of BUILTIN_HANDLER_NAMES) {
        expect(serialized).not.toContain(handlerName);
      }
      expect(serialized).not.toContain('lifecycle');
      expect(module.descriptor.settingsSchemaVersion).toBe(module.manifest.settingsSchemaVersion);
    }
  });

  it('Manifest 引用的 handler 名确实存在于静态 handler 表（引用与实现一致）', () => {
    const basics = builtinModuleRegistry.get(DEMO_BASICS_MODULE_ID);
    expect(basics).toBeDefined();
    const referenced = [
      basics?.manifest.lifecycle.onEnable,
      basics?.manifest.lifecycle.onDisable,
      basics?.manifest.lifecycle.onUninstall,
    ].filter((name): name is string => name !== undefined);
    expect(referenced.length).toBeGreaterThan(0);
    for (const name of referenced) {
      expect(BUILTIN_HANDLER_NAMES).toContain(name);
      expect(typeof basics?.handlers[name]).toBe('function');
    }
  });

  it('演示模块不申请任何能力（不为演示放宽权限面）', () => {
    for (const module of BUILTIN_MODULE_MANIFESTS) {
      expect(module.capabilities).toEqual([]);
    }
  });

  it('演示 Widget 的配置契约与 Manifest 的 configSchemaVersion 一一对应', () => {
    const manifestWidgets = BUILTIN_MODULE_MANIFESTS.flatMap((module) => module.widgets);
    for (const widgetDefinition of manifestWidgets) {
      const contract = findWidgetConfigContract(widgetDefinition.id);
      expect(contract, `缺少配置契约：${widgetDefinition.id}`).not.toBeNull();
      expect(contract?.configSchemaVersion).toBe(widgetDefinition.configSchemaVersion);
      // 默认配置必须能通过自己的 Schema，否则新建实例会立刻变成配置错误。
      expect(contract?.schema.safeParse(contract.defaultConfig).success).toBe(true);
    }
    // 反向：不允许存在没有对应 Manifest 的孤儿契约。
    for (const contract of BUILTIN_WIDGET_CONFIG_CONTRACTS) {
      expect(manifestWidgets.some((widgetDefinition) => widgetDefinition.id === contract.widgetId)).toBe(true);
    }
  });

  it('显式迁移表：demo-counter 有 0→1 迁移且结果合法，demo-solo 明确没有迁移', () => {
    const counter = findWidgetConfigContract(DEMO_WIDGET_IDS.counter);
    expect(counter).not.toBeNull();
    const migrate = counter?.migrations[0];
    expect(typeof migrate).toBe('function');
    const migrated = migrate?.({ increment: 7, label: '旧标签' });
    expect(counter?.schema.safeParse(migrated).success).toBe(true);
    // 无迁移函数的版本：Host 必须拒绝执行，而不是猜一个形状出来。
    expect(findWidgetConfigContract(DEMO_WIDGET_IDS.solo)?.migrations[0]).toBeUndefined();
  });

  it('演示失效模式枚举完整（Host 的错误/空态测试依赖它）', () => {
    expect([...DEMO_FAULT_MODES]).toEqual(['none', 'empty', 'render-error', 'async-error']);
  });
});

describe('拒绝非法注册', () => {
  it('拒绝未列入白名单的能力（Manifest 层默认拒绝）', () => {
    const diagnostics = expectRejected(
      registration({ manifest: manifest({ capabilities: ['root:everything'] }) }),
    );
    expect(codesOf(diagnostics)).toContain('manifest_invalid');
  });

  it('拒绝非法版本号', () => {
    const diagnostics = expectRejected(registration({ manifest: manifest({ version: 'v1' }) }));
    expect(codesOf(diagnostics)).toContain('manifest_invalid');
  });

  it('拒绝重复的模块 ID', () => {
    const build = buildModuleRegistry([registration(), registration()]);
    expect(build.ok).toBe(false);
    if (!build.ok) {
      expect(codesOf(build.diagnostics)).toContain('duplicate_module_id');
    }
  });

  it('拒绝跨模块重复的 Widget 类型 ID', () => {
    const second = registration({
      manifest: manifest({ id: 'test.other', widgets: [widget('test-widget', 'test.other')] }),
    });
    // 单独看是合法的（证明失败只可能来自跨模块重复，而不是别的问题）。
    expectAccepted([second]);

    const build = buildModuleRegistry([registration({ manifest: manifest({ routes: [] }) }), second]);
    expect(build.ok).toBe(false);
    if (!build.ok) {
      expect(codesOf(build.diagnostics)).toContain('duplicate_widget_id');
    }
  });

  it('拒绝重复的路由 path 与 viewId（跨模块）', () => {
    const other = registration({ manifest: manifest({ id: 'test.other', widgets: [widget('other-widget', 'test.other')] }) });
    const build = buildModuleRegistry([registration(), other]);
    expect(build.ok).toBe(false);
    if (!build.ok) {
      const codes = codesOf(build.diagnostics);
      expect(codes).toContain('duplicate_route_path');
      expect(codes).toContain('duplicate_route_view');
    }
  });

  it('拒绝**同一 Manifest 内**重复的路由 path（跨模块表在循环后才填，单靠它发现不了）', () => {
    const diagnostics = expectRejected(
      registration({
        manifest: manifest({
          routes: [
            { path: '/dup', viewId: 'view-a' },
            { path: '/dup', viewId: 'view-b' },
          ],
        }),
      }),
    );
    expect(codesOf(diagnostics)).toContain('duplicate_route_path');
    expect(codesOf(diagnostics)).not.toContain('duplicate_route_view');
  });

  it('拒绝**同一 Manifest 内**重复的路由 viewId', () => {
    const diagnostics = expectRejected(
      registration({
        manifest: manifest({
          routes: [
            { path: '/a', viewId: 'same-view' },
            { path: '/b', viewId: 'same-view' },
          ],
        }),
      }),
    );
    expect(codesOf(diagnostics)).toContain('duplicate_route_view');
    expect(codesOf(diagnostics)).not.toContain('duplicate_route_path');
  });

  it('拒绝引用不存在 handler 的 Manifest（缺失 handler 必须失败，不得静默）', () => {
    const diagnostics = expectRejected(
      registration({ manifest: manifest({ lifecycle: { onEnable: 'test.not_registered' } }) }),
    );
    expect(codesOf(diagnostics)).toContain('missing_lifecycle_handler');
  });

  it('不会把 Object.prototype 上的成员当成已注册的 handler（例如 constructor）', () => {
    // `handlerTable['constructor']` 在原型链上是 Object 构造函数（typeof === 'function'），
    // 因此必须用 Object.hasOwn 判定，否则任何人都能引用 "constructor" 当 handler。
    const diagnostics = expectRejected(
      registration({ manifest: manifest({ lifecycle: { onEnable: 'constructor' } }) }),
    );
    expect(codesOf(diagnostics)).toContain('missing_lifecycle_handler');
  });

  it('拒绝 handler 表里放了非函数的值', () => {
    const diagnostics = expectRejected(
      registration({ handlerTable: { 'test.enable': 'not-a-function' as unknown as () => void } }),
    );
    expect(codesOf(diagnostics)).toContain('missing_lifecycle_handler');
  });

  it('拒绝 Settings Schema 版本与 Manifest 不一致（防止两处漂移）', () => {
    const diagnostics = expectRejected(registration({ settingsSchemaVersion: 2 }));
    expect(codesOf(diagnostics)).toContain('settings_schema_version_mismatch');
  });

  it('拒绝非法（非整数）的 Settings Schema 版本', () => {
    // Manifest 版本的整数约束由 Manifest Schema 自己把关；这里测的是注册表侧的独立检查。
    const diagnostics = expectRejected(registration({ settingsSchemaVersion: 1.5 }));
    expect(codesOf(diagnostics)).toContain('settings_schema_version_invalid');
  });

  it('拒绝无法接受空对象的 Settings Schema（否则模块无法在不给设置时启用）', () => {
    const diagnostics = expectRejected(
      registration({ settingsSchema: z.object({ required: z.string() }).strict() }),
    );
    expect(codesOf(diagnostics)).toContain('settings_schema_rejects_empty');
  });

  it('拒绝 Manifest 声明了未被授予的能力（声明 ≠ 授权）', () => {
    const diagnostics = expectRejected(registration({ manifest: manifest({ capabilities: ['storage:own'] }) }));
    expect(codesOf(diagnostics)).toContain('capability_not_granted');
  });

  it('拒绝授予不在白名单内的能力', () => {
    const diagnostics = expectRejected(
      registration({
        grantedCapabilities: ['root:everything'] as unknown as ModuleRegistrationInput['grantedCapabilities'],
      }),
    );
    expect(codesOf(diagnostics)).toContain('capability_not_whitelisted');
  });

  it('授予白名单内能力且 Manifest 同步声明时接受', () => {
    const registry = expectAccepted([
      registration({ manifest: manifest({ capabilities: ['storage:own'] }), grantedCapabilities: ['storage:own'] }),
    ]);
    expect(registry.hasCapability(TEST_MODULE_ID, 'storage:own')).toBe(true);
  });

  it('一次报全部问题，而不是修一个报一个', () => {
    const build = buildModuleRegistry([
      registration({ manifest: manifest({ version: 'v1' }) }),
      registration({ manifest: manifest({ lifecycle: { onEnable: 'nope' } }) }),
    ]);
    expect(build.ok).toBe(false);
    if (!build.ok) {
      expect(build.diagnostics.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('buildModuleRegistryOrThrow 在失败时抛出带诊断码的异常（启动期必须失败）', () => {
    expect(() => buildModuleRegistryOrThrow([registration({ manifest: manifest({ version: 'v1' }) })])).toThrow(
      /manifest_invalid/,
    );
  });
});

describe('设置校验（服务端权威）', () => {
  it('合法设置通过，并补齐 Schema 默认值', () => {
    const result = builtinModuleRegistry.validateSettings(DEMO_BASICS_MODULE_ID, { greeting: '早上好' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settings['greeting']).toBe('早上好');
      expect(result.settings['announce']).toBe(false);
    }
  });

  it('拒绝类型错误的设置，且**不回显提交的值**（避免把敏感值写进响应/日志）', () => {
    const result = builtinModuleRegistry.validateSettings(DEMO_BASICS_MODULE_ID, { greeting: 12345 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join('；')).toContain('greeting');
      expect(result.issues.join('；')).not.toContain('12345');
    }
  });

  it('拒绝超出范围的设置值', () => {
    const result = builtinModuleRegistry.validateSettings(DEMO_BASICS_MODULE_ID, { greeting: 'x'.repeat(200) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join('；')).not.toContain('xxxx');
    }
  });

  it('不接受任何设置的模块会拒绝未知字段', () => {
    const result = builtinModuleRegistry.validateSettings(DEMO_SOLO_MODULE_ID, { anything: true });
    expect(result.ok).toBe(false);
  });

  it('未注册模块的设置校验直接失败', () => {
    expect(builtinModuleRegistry.validateSettings('no.such.module', {}).ok).toBe(false);
  });
});
