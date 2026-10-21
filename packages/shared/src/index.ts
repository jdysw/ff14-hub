/**
 * @ff14-hub/shared — 前后端共用的纯契约层。
 *
 * 定位（INV-10 / ADR-002）：
 * - 只放**纯类型与纯函数**：Zod Schema、错误契约、身份 Token 形状、Module/Widget 清单契约。
 * - 不引入任何运行时环境依赖（无 DOM、无 Workers API、无数据库访问），因此前后端与测试可共用。
 * - 业务规则实现（鱼类计算、同步冲突等）属于 packages/fish-engine、packages/sync-core（后续阶段）。
 */
// 说明：本包只作为源码被 Vite / esbuild 打包消费（不产出 dist、不直接被 Node 原生 ESM 加载），
// 因此相对导入省略扩展名，与 tsconfig 的 moduleResolution: "bundler" 保持一致。
export * from './api-contract';
export * from './builtin-modules';
export * from './errors';
export * from './events-api';
export * from './fish-api';
export * from './fish-sync-api';
export * from './reminder-api';
export * from './identity';
export * from './identity-api';
export * from './module-api';
export * from './module-manifest';
export * from './operations-api';
export * from './nav-api';
export * from './nav-directory';
export * from './sync-api';
export * from './workbench-api';
export * from './local-notifications';

export * from './pvp-rotation';
export * from './mobile-widgets-v1';
