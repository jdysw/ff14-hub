/**
 * Worker 环境的**运行时视图**与结构化校验（HUB-002 / HUB-006）。
 *
 * 类型来源（避免配置漂移）：
 * - 绑定的**存在性与形状**由 `wrangler types` 生成的 `worker-configuration.d.ts` 提供
 *   （由根 `wrangler.jsonc` 推导）。新增绑定后必须重新运行 `pnpm run types:worker`，
 *   CI 会用 `--check` 校验生成结果与配置一致。
 * - `RuntimeEnv` 只补上生成类型无法表达的**尚未配置的 secret**：`BOOTSTRAP_SECRET`
 *   由 .dev.vars / 部署 Secrets 提供，未配置时管理员登录和通知登记按需拒绝，
 *   因此它在类型上是可选的。
 *
 * 运行时校验（HUB-002）：
 * - 必需绑定及变量形状在使用前经过 `parseEnv`；失败返回脱敏 500。弱初始化密钥仅禁用受保护的管理/通知功能，不会关闭公开站点。
 * - 本文件只做形状校验，不读取、不记录任何凭证的值。`hasBootstrapSecret` 只记录**是否存在**。
 * - `ASSETS` 是静态资源绑定，仅在 wrangler 运行时存在，因此允许缺失并由调用方降级处理。
 */
import { z } from 'zod';

/** 运行时绑定视图：生成类型 + 尚未配置的 secrets。 */
export interface RuntimeEnv extends Cloudflare.Env {
  /** HUB-006 的一次性初始化密钥；由部署环境提供，未配置时为 undefined。 */
  readonly BOOTSTRAP_SECRET?: string;
  readonly VAPID_PUBLIC_KEY?: string;
  readonly VAPID_PRIVATE_KEY?: string;
  readonly VAPID_SUBJECT?: string;
}

/**
 * Worker 代码沿用 `Env` 这个名字。
 * 这是**模块作用域**的导出，与 `worker-configuration.d.ts` 声明的全局 `Env` 互不冲突。
 */
export type Env = RuntimeEnv;

export const ENVIRONMENTS = ['development', 'preview', 'production', 'test'] as const;
export type EnvironmentName = (typeof ENVIRONMENTS)[number];

/**
 * Bootstrap 初始化密钥的最小长度（字符）。
 * 要求至少 32 个字符的高熵随机值；配置了更短的值会被视为部署配置错误。
 * 该常量由环境校验与管理/通知入口共用，避免两处出现不一致的下限。
 */
export const MIN_BOOTSTRAP_SECRET_LENGTH = 32;

const d1DatabaseSchema = z.custom<D1Database>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { prepare?: unknown }).prepare === 'function' &&
    typeof (value as { exec?: unknown }).exec === 'function',
  { message: 'DB 绑定缺失或不是 D1 数据库' },
);

const envSchema = z.object({
  DB: d1DatabaseSchema,
  ENVIRONMENT: z.enum(ENVIRONMENTS).optional(),
  ENABLE_TEST_ROUTES: z.enum(['0', '1']).optional(),
  ALLOWED_ORIGINS: z.string().optional(),
  // 密钥本身由初始化/管理员认证路由按最小长度检查并拒绝弱密钥。
  // 不在全局 envSchema 强制长度：短密钥不得导致公开首页、健康检查、静态文件全部 500。
  BOOTSTRAP_SECRET: z.string().optional(),
});

/** 经过校验的运行时配置（不含任何凭证值）。 */
export interface AppConfig {
  readonly environment: EnvironmentName;
  /** 除同源之外额外允许的 Origin；已剔除空项与通配符。 */
  readonly allowedOrigins: readonly string[];
  readonly enableTestRoutes: boolean;
  /** 是否已配置符合最小长度要求的 Bootstrap 密钥——只暴露布尔，不暴露值。 */
  readonly hasBootstrapSecret: boolean;
  /** 静态资源绑定是否存在。 */
  readonly hasAssetsBinding: boolean;
}

export type EnvParseResult =
  | { readonly ok: true; readonly config: AppConfig }
  | { readonly ok: false; readonly issues: readonly string[] };

/** 解析逗号分隔的 Origin 列表；显式丢弃 "*"，避免把通配来源误当作允许项。 */
export function parseAllowedOrigins(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item !== '*');
}

/** 仅解析环境名，用于安全响应头等不依赖完整校验的场景。 */
export function resolveEnvironmentName(raw: unknown): EnvironmentName {
  const value = raw !== null && typeof raw === 'object' ? (raw as RuntimeEnv).ENVIRONMENT : undefined;
  return (ENVIRONMENTS as readonly string[]).includes(value ?? '') ? (value as EnvironmentName) : 'development';
}

/**
 * 校验 Worker 环境。
 * 失败时只返回字段级问题描述（供服务端日志），响应体只暴露通用的 internal_error。
 */
export function parseEnv(raw: unknown): EnvParseResult {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      // 只保留字段路径与 zod 的错误类别，不携带用户输入值。
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.code}`),
    };
  }
  const data = parsed.data;
  return {
    ok: true,
    config: {
      environment: data.ENVIRONMENT ?? 'development',
      allowedOrigins: parseAllowedOrigins(data.ALLOWED_ORIGINS),
      enableTestRoutes: data.ENABLE_TEST_ROUTES === '1',
      hasBootstrapSecret: data.BOOTSTRAP_SECRET !== undefined && data.BOOTSTRAP_SECRET.length >= MIN_BOOTSTRAP_SECRET_LENGTH,
      hasAssetsBinding: raw !== null && typeof raw === 'object' && 'ASSETS' in raw && (raw as RuntimeEnv).ASSETS !== undefined,
    },
  };
}
