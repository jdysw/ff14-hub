/**
 * 模块状态的单一来源（HUB-050 前端侧）。
 *
 * 设计要点：
 * - 目录（`GET /modules/catalog`）是**公开**数据，匿名即可加载；个人状态
 *   （`GET /me/modules`）必须带设备凭证。两者刻意分开加载，这样「匿名只能看目录」
 *   这件事在界面上是可见的事实，而不是靠说明文字。
 * - 变更成功后就地应用服务端返回的状态，不本地推测；失败则原样返回服务端文案。
 * - 目录里 `capabilities` 就是服务端注册表授予的能力（注册表保证声明 ⊆ 授予），
 *   因此 Host 用它可以做出与门禁一致的降级判断。
 */
import {
  type ModuleCapability,
  type ModuleDescriptor,
  type ModuleEffectiveStatus,
  type ModuleMutationRequest,
  type ModuleMutationResponse,
  type WorkspaceModuleStatus,
} from '@ff14-hub/shared';
import { useCallback, useEffect, useState } from 'react';
import type { ModuleAccess } from '../widgets/types';
import type { ModulesApi } from './modules-api';

export type ModuleMutationOutcome =
  | { readonly ok: true; readonly response: ModuleMutationResponse }
  | { readonly ok: false; readonly message: string; readonly conflict: boolean };

export interface ModuleState {
  readonly catalog: readonly ModuleDescriptor[];
  readonly statuses: Readonly<Record<string, WorkspaceModuleStatus>>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => void;
  readonly mutate: (moduleId: string, request: ModuleMutationRequest) => Promise<ModuleMutationOutcome>;
}

/** 未安装的派生状态（行缺失），用于界面与 Host 降级判断。 */
export function effectiveStatusOf(
  statuses: Readonly<Record<string, WorkspaceModuleStatus>>,
  moduleId: string,
): ModuleEffectiveStatus {
  // 服务端返回的 status 本身就是**有效状态**（含 not_installed），这里只处理「行缺失」。
  return statuses[moduleId]?.status ?? 'not_installed';
}

export function catalogEntryOf(
  catalog: readonly ModuleDescriptor[],
  moduleId: string,
): ModuleDescriptor | undefined {
  return catalog.find((module) => module.id === moduleId);
}

/**
 * 构造 Host 需要的访问判定函数。
 * `grantedCapabilities` 取自公开目录里该模块声明的能力（= 服务端授予的能力）。
 */
export function moduleAccessFrom(
  catalog: readonly ModuleDescriptor[],
  statuses: Readonly<Record<string, WorkspaceModuleStatus>>,
  deniedModules: readonly string[] = [],
): (moduleId: string) => ModuleAccess {
  return (moduleId) => {
    const granted: readonly ModuleCapability[] = deniedModules.includes(moduleId)
      ? []
      : (catalogEntryOf(catalog, moduleId)?.capabilities ?? []);
    return { status: effectiveStatusOf(statuses, moduleId), grantedCapabilities: granted };
  };
}

interface LoadedModuleState {
  /** 本次结果对应的请求键；与当前请求键不同即表示正在加载。 */
  readonly requestKey: string;
  readonly catalog: readonly ModuleDescriptor[];
  readonly statuses: Readonly<Record<string, WorkspaceModuleStatus>>;
  readonly error: string | null;
}

export function useModuleState(api: ModulesApi, token: string | null): ModuleState {
  const [reloadToken, setReloadToken] = useState(0);
  const [loaded, setLoaded] = useState<LoadedModuleState | null>(null);

  /**
   * 请求键 = 凭证 + 刷新计数。
   * 「是否在加载」由它派生（`loaded.requestKey !== requestKey`），
   * 而不是在 effect 体内同步 setState —— 后者会造成级联渲染，
   * 也会让「正在重新加载但旧数据仍可显示」这件事变得难以表达。
   */
  const requestKey = `${token ?? '<anonymous>'}#${String(reloadToken)}`;

  const reload = useCallback(() => {
    setReloadToken((current) => current + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const catalogResult = await api.catalog();
      if (cancelled) {
        return;
      }
      if (!catalogResult.ok) {
        setLoaded({
          requestKey,
          catalog: [],
          statuses: {},
          error: `加载模块目录失败：${catalogResult.error.message}`,
        });
        return;
      }

      if (token === null) {
        // 匿名：目录可读，个人状态为空（界面会提示需要设备凭证）。
        setLoaded({ requestKey, catalog: catalogResult.data.modules, statuses: {}, error: null });
        return;
      }

      const mineResult = await api.listMine();
      if (cancelled) {
        return;
      }
      const statuses: Record<string, WorkspaceModuleStatus> = {};
      if (mineResult.ok) {
        for (const status of mineResult.data.modules) {
          statuses[status.moduleId] = status;
        }
      }
      setLoaded({
        requestKey,
        catalog: catalogResult.data.modules,
        statuses,
        error: mineResult.ok ? null : `加载模块状态失败：${mineResult.error.message}`,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [api, token, requestKey]);

  const mutate = useCallback(
    async (moduleId: string, request: ModuleMutationRequest): Promise<ModuleMutationOutcome> => {
      const result = await api.mutate(moduleId, request);
      if (!result.ok) {
        return {
          ok: false,
          message: `${result.error.message}（${result.error.code}）`,
          conflict: result.error.code === 'conflict',
        };
      }
      // 就地应用服务端返回的状态，不做本地推测。
      setLoaded((current) =>
        current === null
          ? current
          : { ...current, statuses: { ...current.statuses, [moduleId]: result.data.module } },
      );
      return { ok: true, response: result.data };
    },
    [api],
  );

  return {
    catalog: loaded?.catalog ?? [],
    statuses: loaded?.statuses ?? {},
    // 首次加载（还没有任何结果）或结果对应的请求键已过期，都算「正在加载」。
    loading: loaded === null || loaded.requestKey !== requestKey,
    error: loaded?.error ?? null,
    reload,
    mutate,
  };
}
