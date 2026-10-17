import { describe, expect, it } from 'vitest';
import {
  MODULE_CAPABILITIES,
  MODULE_OPERATION_SEMANTICS,
  validateModuleManifest,
} from '../src/module-manifest';

/** 一个形状合法的 Module Manifest 基线（不是真实业务模块，仅用于契约测试）。 */
function baselineManifest(): Record<string, unknown> {
  return {
    id: 'ff14.example',
    version: '1.2.0',
    displayName: '示例模块',
    capabilities: ['storage:own'],
    widgets: [
      {
        id: 'example-widget',
        moduleId: 'ff14.example',
        displayName: '示例组件',
        allowMultiple: true,
        defaultSize: { w: 4, h: 3 },
        minSize: { w: 2, h: 2 },
        configSchemaVersion: 1,
      },
    ],
    settingsSchemaVersion: 1,
    lifecycle: { onEnable: 'example.enable' },
  };
}

describe('Module / Widget 契约', () => {
  it('接受合法 Manifest', () => {
    const result = validateModuleManifest(baselineManifest());
    expect(result.ok).toBe(true);
  });

  it('拒绝未列入白名单的能力（默认拒绝而非静默忽略）', () => {
    const manifest = baselineManifest();
    manifest['capabilities'] = ['storage:own', 'root:everything'];
    const result = validateModuleManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join('\n')).toContain('capabilities');
    }
  });

  it('拒绝 moduleId 与所属模块不一致的 Widget', () => {
    const manifest = baselineManifest();
    manifest['widgets'] = [
      {
        id: 'example-widget',
        moduleId: 'ff14.other',
        displayName: '示例组件',
        allowMultiple: false,
        defaultSize: { w: 4, h: 3 },
        minSize: { w: 2, h: 2 },
        configSchemaVersion: 1,
      },
    ];
    const result = validateModuleManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join('\n')).toContain('moduleId');
    }
  });

  it('拒绝重复的 Widget id（组件实例可重复，但类型 id 必须唯一）', () => {
    const manifest = baselineManifest();
    const widget = (manifest['widgets'] as Record<string, unknown>[])[0] as Record<string, unknown>;
    manifest['widgets'] = [widget, { ...widget }];
    const result = validateModuleManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join('\n')).toContain('重复');
    }
  });

  it('拒绝 minSize 大于 defaultSize 的尺寸声明', () => {
    const manifest = baselineManifest();
    manifest['widgets'] = [
      {
        id: 'example-widget',
        moduleId: 'ff14.example',
        displayName: '示例组件',
        allowMultiple: false,
        defaultSize: { w: 2, h: 2 },
        minSize: { w: 6, h: 2 },
        configSchemaVersion: 1,
      },
    ];
    const result = validateModuleManifest(manifest);
    expect(result.ok).toBe(false);
  });

  it('拒绝非语义化版本号', () => {
    const manifest = baselineManifest();
    manifest['version'] = 'v1';
    expect(validateModuleManifest(manifest).ok).toBe(false);
  });

  it('能力白名单非空且不包含通配能力', () => {
    expect(MODULE_CAPABILITIES.length).toBeGreaterThan(0);
    expect(MODULE_CAPABILITIES.some((capability) => capability.includes('*'))).toBe(false);
  });

  it('五种生命周期操作的语义互不重叠：隐藏/移除不删数据，停用不等于清数据', () => {
    expect(MODULE_OPERATION_SEMANTICS.hideWidget.affectsUserData).toBe(false);
    expect(MODULE_OPERATION_SEMANTICS.removeWidget.affectsUserData).toBe(false);
    expect(MODULE_OPERATION_SEMANTICS.disableModule.affectsUserData).toBe(false);
    expect(MODULE_OPERATION_SEMANTICS.disableModule.affectsBackground).toBe(true);
    expect(MODULE_OPERATION_SEMANTICS.uninstallModule.affectsUserData).toBe(false);
    expect(MODULE_OPERATION_SEMANTICS.purgeModuleData.affectsUserData).toBe(true);
  });
});
