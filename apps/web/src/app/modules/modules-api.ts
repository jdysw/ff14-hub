/**
 * 模块 API 客户端（HUB-050 的前端入口）。
 *
 * 安全前提：
 * - 复用 `apps/web/src/lib/api-client.ts`，因此设备 Token **只**走 Authorization 头，
 *   绝不进 URL、不进日志、不进 localStorage。
 * - 模块 ID 必须编码后再拼进路径，避免用户可控字符串改变路径结构（路径穿越/注入）。
 * - 这里只做请求与形状校验，不做业务判断；模块状态与合法性一律以服务端为准。
 */
import {
  API_ROUTES,
  type ModuleCatalogResponse,
  type ModuleMutationRequest,
  type ModuleMutationResponse,
  type MyModulesResponse,
  type WorkspaceModuleStatusResponse,
} from '@ff14-hub/shared';
import type { ApiResult } from '../../lib/api-client';

/** 只依赖「能发请求」这一件事，便于测试注入替身。 */
export interface ApiRequester {
  request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>>;
}

export interface ModulesApi {
  /** 公开目录（匿名可读）。 */
  catalog(): Promise<ApiResult<ModuleCatalogResponse>>;
  /** 本工作空间的模块状态（设备鉴权）。 */
  listMine(): Promise<ApiResult<MyModulesResponse>>;
  readModule(moduleId: string): Promise<ApiResult<WorkspaceModuleStatusResponse>>;
  mutate(moduleId: string, request: ModuleMutationRequest): Promise<ApiResult<ModuleMutationResponse>>;
  /** 清数据入口：本阶段服务端恒返回 501，前端只是把它暴露出来以便**看见**拒绝。 */
  purge(moduleId: string): Promise<ApiResult<unknown>>;
}

function encodeModuleId(moduleId: string): string {
  return encodeURIComponent(moduleId);
}

export function createModulesApi(client: ApiRequester): ModulesApi {
  const modulePath = (moduleId: string): string =>
    API_ROUTES.meModuleById.replace(':id', encodeModuleId(moduleId));

  return {
    catalog: () => client.request<ModuleCatalogResponse>(API_ROUTES.moduleCatalog),
    listMine: () => client.request<MyModulesResponse>(API_ROUTES.meModules),
    readModule: (moduleId) => client.request<WorkspaceModuleStatusResponse>(modulePath(moduleId)),
    mutate: (moduleId, request) =>
      client.request<ModuleMutationResponse>(modulePath(moduleId), {
        method: 'PATCH',
        body: JSON.stringify(request),
      }),
    purge: (moduleId) =>
      client.request<unknown>(API_ROUTES.meModulePurge.replace(':id', encodeModuleId(moduleId)), {
        method: 'POST',
      }),
  };
}
