/**
 * Worker 环境（绑定 + 变量）的**结构化校验与边界**（HUB-002）。
 *
 * 设计边界：
 * - 所有绑定与变量在使用前都必须经过这里的解析；失败返回**脱敏**的 500，不把 zod 明细发给调用方。
 * - 本文件只做「形状」校验，不读取、不记录任何凭证的值。`hasBootstrapSecret` 只记录**是否存在**。
 * - 阶段 01 只使用 DB（D1）；ASSETS 是静态资源绑定，仅在 wrangler 运行时存在，
 *   因此在 Workers 测试与单测中允许缺失，由调用方降级处理。
 */
import { z } from 'zod';

/** Worker 绑定与变量。字段名与 wrangler.jsonc 保持一致。 */
export interface Env {
  /** D1 数据库绑定（阶段 01 必需）。 */
  readonly DB: D1Database;
  /** 静态资源绑定；仅在 wrangler dev/deploy 运行时由 assets 配置注入。 */
  readonly ASSETS?: Fetcher;
  /** 运行环境标识，用于健康检查展示与行为分流。 */
  readonly ENVIRONMENT?: string;
  /** 额外允许的写请求 Origin（逗号分隔）。默认只允许同源。绝不允许 "*"。 */
  readonly ALLOWED_ORIGINS?: string;
  /** 仅本地/CI 用于暴露自检路由；生产必须缺省或为 "0"。 */
  readonly ENABLE_TEST_ROUTES?: string;
  /** HUB-006 使用的一次性 Bootstrap 密钥；本轮只校验其存在性与长度，绝不记录其值。 */
  readonly BOOTSTRAP_SECRET?: string;
}

export const ENVIRONMENTS = ['development', 'preview', 'production', 'test'] as const;
export type EnvironmentName = (typeof ENVIRONMENTS)[number];

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
  ALLOWED_ORIGINS: z.string().optional(),
  ENABLE_TEST_ROUTES: z.enum(['0', '1']).optional(),
  // 高熵初始化密钥：至少 32 个字符。这里只校验长度，值永不落日志。
  BOOTSTRAP_SECRET: z.string().min(32).optional(),
});

/** 经过校验的运行时配置（不含任何凭证值）。 */
export interface AppConfig {
  readonly environment: EnvironmentName;
  /** 除同源之外额外允许的 Origin；已剔除空项与通配符。 */
  readonly allowedOrigins: readonly string[];
  readonly enableTestRoutes: boolean;
  /** 是否已配置 Bootstrap 密钥——只暴露布尔，不暴露值。 */
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
  const value = raw !== null && typeof raw === 'object' ? (raw as Env).ENVIRONMENT : undefined;
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
      hasBootstrapSecret: data.BOOTSTRAP_SECRET !== undefined,
      hasAssetsBinding: raw !== null && typeof raw === 'object' && 'ASSETS' in raw && (raw as Env).ASSETS !== undefined,
    },
  };
}
