/**
 * 身份 API 请求/响应契约（HUB-006 实现依据，**本轮不实现处理器**）。
 *
 * 为什么现在就要定义：下一轮 HUB-006 的 Bootstrap / 配对 / 恢复必须与前端和测试共用同一套
 * 形状，先把契约固定下来可以避免实现时顺手发明不一致的字段。
 *
 * 安全前提（与规划 6.3 一一对应）：
 * - `bootstrap` 的请求体刻意**不**包含任何密钥字段：初始化密钥只能通过部署环境 Secret
 *   或请求头传递，绝不能进 JSON body（body 更容易被日志与错误上报捕获）。
 * - 响应中出现的 `recoveryKey` / `deviceToken` 是**唯一一次**明文返回；
 *   服务端只保存摘要，客户端必须离线备份恢复密钥。
 * - 这些 Schema 只描述形状，不构成授权：真正的「一次性」「单工作空间」「速率限制」必须由
 *   数据库唯一约束与条件更新保证，不能只靠应用层判断。
 */
import { z } from 'zod';
import { deviceSummarySchema } from './api-contract';
import {
  DEVICE_TOKEN_PATTERN,
  PAIRING_CODE_PATTERN,
  RECOVERY_KEY_PATTERN,
  REGIONS,
} from './identity';

/** 设备名：只用于人机识别，不参与任何权限判断。 */
const deviceNameSchema = z.string().min(1).max(80);

/** POST /api/v1/identity/bootstrap —— 仅允许成功一次。 */
export const bootstrapRequestSchema = z
  .object({
    region: z.enum(REGIONS).default('cn'),
    timezone: z.string().min(1).max(64).default('Asia/Shanghai'),
    locale: z.string().min(1).max(16).default('zh-CN'),
    deviceName: deviceNameSchema,
  })
  .strict();

export const bootstrapResponseSchema = z.object({
  workspaceId: z.string().min(1),
  /** 明文恢复密钥，仅此一次返回；服务端只保留摘要。 */
  recoveryKey: z.string().regex(RECOVERY_KEY_PATTERN),
  /** 首台设备的明文 Token，仅此一次返回。 */
  deviceToken: z.string().regex(DEVICE_TOKEN_PATTERN),
  device: deviceSummarySchema,
});

/** POST /api/v1/identity/pairing —— 由已认证设备发起。 */
export const pairingCreateRequestSchema = z
  .object({
    /** 建议的过期秒数；上限一小时，避免长期有效的一次性凭证。 */
    ttlSeconds: z.number().int().min(60).max(3600).default(600),
  })
  .strict();

export const pairingCreateResponseSchema = z.object({
  pairingCode: z.string().regex(PAIRING_CODE_PATTERN),
  expiresAt: z.number().int().nonnegative(),
});

/** POST /api/v1/identity/pairing/claim —— 凭配对码领取新设备凭证，一次性消费。 */
export const pairingClaimRequestSchema = z
  .object({
    pairingCode: z.string().regex(PAIRING_CODE_PATTERN),
    deviceName: deviceNameSchema,
  })
  .strict();

export const pairingClaimResponseSchema = z.object({
  deviceToken: z.string().regex(DEVICE_TOKEN_PATTERN),
  device: deviceSummarySchema,
});

/** POST /api/v1/identity/recover —— 用恢复密钥换取新的设备凭证。 */
export const recoverRequestSchema = z
  .object({
    recoveryKey: z.string().regex(RECOVERY_KEY_PATTERN),
    deviceName: deviceNameSchema,
  })
  .strict();

export const recoverResponseSchema = z.object({
  deviceToken: z.string().regex(DEVICE_TOKEN_PATTERN),
  device: deviceSummarySchema,
});

export type BootstrapRequest = z.infer<typeof bootstrapRequestSchema>;
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;
export type PairingCreateRequest = z.infer<typeof pairingCreateRequestSchema>;
export type PairingCreateResponse = z.infer<typeof pairingCreateResponseSchema>;
export type PairingClaimRequest = z.infer<typeof pairingClaimRequestSchema>;
export type PairingClaimResponse = z.infer<typeof pairingClaimResponseSchema>;
export type RecoverRequest = z.infer<typeof recoverRequestSchema>;
export type RecoverResponse = z.infer<typeof recoverResponseSchema>;

/** 身份端点路径常量（HUB-006 路由装配时使用，避免硬编码字符串漂移）。 */
export const IDENTITY_ROUTES = {
  bootstrap: '/identity/bootstrap',
  pairing: '/identity/pairing',
  pairingClaim: '/identity/pairing/claim',
  recover: '/identity/recover',
} as const;

/**
 * 配对凭证的过期上限（秒）。与 pairingCreateRequestSchema 的 max 保持一致，
 * 供服务端在执行时二次夹紧（不能只依赖请求校验）。
 */
export const MAX_PAIRING_TTL_SECONDS = 3600;
