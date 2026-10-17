/**
 * 模块状态的单一来源（HUB-050 前端侧）。
 *
 * 设计要点：
 * - 目录（`GET /modules/catalog`）是**公开**数据，匿名即可加载；个人状态
 *   （`GET /me/modules`）必须带设备凭证。两者刻意分开加载，这样「匿名只能看目录」
 *   这件事在界面上是可见的事实，而不是靠说明文字。
 * - **不接收明文凭证**：只接收 `authenticated` 布尔值。凭证由 API 客户端内部在发请求时读取，
 *   因此它不会出现在 React 的 props / state / 依赖数组里（那会泄漏到 DevTools）。
 * - **会话隔离**：本 Hook 的实例只属于一个会话代际（调用方用 `key={generation}` 重挂）。
 *   卸载后任何在途响应都会被 `mountedRef` 判定为过期并丢弃，**也不会触发任何 Host 副作用**。
 * - 变更成功后就地应用服务端返回的状态，不本地推测；失败则原样返回服务端文案。
 * - 目录里 `capabilities` 就是服务端注册表授予的能力（注册表保证声明 ⊆ 授予），
 *   因此 Host 用它可以做出与门禁一致的降级判断。
 */
import {
  moduleGateStatus,
  type ModuleCapability,
  type ModuleDescriptor,
  type ModuleGateStatus,
  type ModuleMutationRequest,
  type ModuleMutationResponse,
  type WorkspaceModuleStatus,
} from '@ff14-hub/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModuleAccess } from '../widgets/types';
import type { ModulesApi } from './modules-api';

export type ModuleMutationOutcome =
  | { readonly ok: true; readonly response: ModuleMutationResponse }
  | {
      readonly ok: false;
      /** true 表示会话已切换：结果被丢弃，调用方**不得**据此产生任何界面或 Host 副作用。 */
      readonly stale: boolean;
      readonly message: string;
      readonly conflict: boolean;
    };

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
): ModuleGateStatus {
  const status = statuses[moduleId];
  // 服务端返回的 status 本身就是**有效状态**（含 not_installed），这里只处理「行缺失」。
  return moduleGateStatus(status?.status ?? 'not_installed', status?.pendingOperation ?? null);
}

export function catalogEntryOf(
  catalog: readonly ModuleDescriptor[],
  moduleId: string,
): ModuleDescriptor | undefined {
  return catalog.find((module) => module.id === moduleId);
}

/**
 * 构造 Host 需要的访问判定函数。
 * - `status` 是**门禁状态**：存在待完成操作时为 `transitioning`，因此不会被当成可运行。
 * - `grantedCapabilities` 取自公开目录里该模块声明的能力（= 服务端授予的能力）。
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
  /** 私有状态（个人模块状态）是否已经拿到。匿名时为 true（本来就没有私有状态）。 */
  readonly statusesReady: boolean;
}

export function useModuleState(api: ModulesApi, authenticated: boolean): ModuleState {
  const [reloadToken, setReloadToken] = useState(0);
  const [loaded, setLoaded] = useState<LoadedModuleState | null>(null);
  const mountedRef = useRef(true);

  /**
   * 请求键 = 是否已认证 + 刷新计数（**不含凭证内容**）。
   * 「是否在加载」由它派生（`loaded.requestKey !== requestKey`），
   * 而不是在 effect 体内同步 setState —— 后者会造成级联渲染，
   * 也会让「正在重新加载但旧数据仍可显示」这件事变得难以表达。
   */
  const requestKey = `${authenticated ? 'auth' : 'anon'}#${String(reloadToken)}`;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      // 会话切换/退出会让本 Hook 卸载：此后所有在途响应都必须被丢弃。
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback(() => {
    setReloadToken((current) => current + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const catalogResult = await api.catalog();
      if (cancelled || !mountedRef.current) {
        return;
      }
      if (!catalogResult.ok) {
        setLoaded({
          requestKey,
          catalog: [],
          statuses: {},
          error: `加载模块目录失败：${catalogResult.error.message}`,
          statusesReady: true,
        });
        return;
      }

      // 公开目录**先到先渲染**：不要因为私有状态还没回来就让界面空白。
      setLoaded({
        requestKey,
        catalog: catalogResult.data.modules,
        statuses: {},
        error: null,
        statusesReady: !authenticated,
      });

      if (!authenticated) {
        return;
      }

      const mineResult = await api.listMine();
      if (cancelled || !mountedRef.current) {
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
        statusesReady: true,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [api, authenticated, requestKey]);

  const mutate = useCallback(
    async (moduleId: string, request: ModuleMutationRequest): Promise<ModuleMutationOutcome> => {
      const result = await api.mutate(moduleId, request);
      if (!mountedRef.current) {
        // 会话已切换：**先于任何状态写入**退出。
        // 调用方据此跳过 Host 联动（例如不要用旧会话的卸载响应去清理新会话的实例）。
        return {
          ok: false,
          stale: true,
          message: '会话已切换，该请求的结果已丢弃。',
          conflict: false,
        };
      }
      if (!result.ok) {
        return {
          ok: false,
          stale: false,
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
    // 首次加载、请求键已过期、或私有状态尚未拿到，都算「仍在加载」。
    loading: loaded === null || loaded.requestKey !== requestKey || !loaded.statusesReady,
    error: loaded?.error ?? null,
    reload,
    mutate,
  };
}
