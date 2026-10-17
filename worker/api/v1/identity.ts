/**
 * 身份端点（HUB-006 / 规划 6.1）。
 *
 * | Method | Path                            | 认证                        |
 * |--------|---------------------------------|-----------------------------|
 * | POST   | /api/v1/identity/bootstrap      | 部署初始化密钥（仅成功一次） |
 * | POST   | /api/v1/identity/pairing        | 已认证设备                   |
 * | POST   | /api/v1/identity/pairing/claim  | 配对凭证                     |
 * | POST   | /api/v1/identity/recover        | 恢复密钥                     |
 *
 * 安全前提：
 * - 初始化密钥通过**请求头**传递（`X-Bootstrap-Secret`），不放请求体：
 *   body 更容易被日志、错误上报与代理捕获。比较前先各自哈希再固定时序对比，
 *   因此「没带」「带错」在时间上不可区分。
 * - 未配置初始化密钥时返回 503，并且**不解释原因**。
 * - 三个无认证端点都有速率限制（客户端 + 全局两层），在触碰任何凭证判断之前施加。
 * - 所有含凭证的响应显式 `Cache-Control: no-store`。
 * - 失败原因（过期/已消费/发起设备已撤销/密钥不存在）对外**统一为 401/409**，
 *   只写脱敏日志，不给枚举信号。
 */
import {
  ApiError,
  DEFAULT_ERROR_MESSAGE,
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  pairingClaimRequestSchema,
  pairingClaimResponseSchema,
  pairingCreateRequestSchema,
  pairingCreateResponseSchema,
  recoverRequestSchema,
  recoverResponseSchema,
  type DeviceSummary,
} from '@ff14-hub/shared';
import { Hono } from 'hono';
import { MIN_BOOTSTRAP_SECRET_LENGTH } from '../../env';
import { logLine } from '../../lib/redact';
import { RATE_LIMITS, enforceRateLimits } from '../../lib/rate-limit';
import { noStoreJson, rateLimited } from '../../lib/response';
import { errorResponse, methodNotAllowed, requestIdOf } from '../../middleware/error-handler';
import { parsedJsonBody, validateJsonBody } from '../../middleware/validation';
import { deviceAuth } from '../../middleware/auth';
import type { AppBindings, AppContext } from '../../types';
import { bootstrapWorkspace } from '../../modules/identity/bootstrap';
import { credentialsEqual, hashCredential } from '../../modules/identity/credentials';
import { claimPairing, createPairing } from '../../modules/identity/pairing';
import { recoverDeviceAccess } from '../../modules/identity/recovery';

/** 初始化密钥的请求头名称。 */
export const BOOTSTRAP_SECRET_HEADER = 'X-Bootstrap-Secret';

export const identityRoutes = new Hono<AppBindings>();

/**
 * 计算速率限制作用域键。
 * 只保存客户端标识的**摘要**，因此限流表里既没有明文 IP，也无法被反查。
 */
async function identityScopeKeys(c: AppContext, route: string): Promise<{ client: string; global: string }> {
  const forwarded = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For')?.split(',')[0] ?? '';
  const identifier = forwarded.trim().length > 0 ? forwarded.trim() : 'unknown';
  const digest = (await hashCredential(identifier)).slice(0, 32);
  return { client: `${route}:c:${digest}`, global: `${route}:g` };
}

/**
 * 比较初始化密钥。
 * 走 `credentialsEqual()`：两侧各自 SHA-256 后用**平台提供的**
 * `crypto.subtle.timingSafeEqual` 比较，不使用手写循环。
 * 「没带」与「带错」在时间与响应上都不可区分。
 */
async function credentialMatches(provided: string | undefined, expected: string): Promise<boolean> {
  if (provided === undefined || provided.length === 0) {
    return false;
  }
  return await credentialsEqual(provided, expected);
}

function deviceSummary(input: {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
}): DeviceSummary {
  return {
    id: input.id,
    name: input.name,
    createdAt: input.createdAt,
    lastSeenAt: null,
    revokedAt: null,
    current: true,
  };
}

/** 记录身份失败，只写脱敏结构化日志（不含任何凭证、摘要或原始输入）。 */
function logIdentityFailure(c: AppContext, route: string, reason: string): void {
  console.warn(logLine('warn', 'identity_failure', { requestId: requestIdOf(c), route, reason }));
}

/**
 * POST /identity/bootstrap
 * 一次性初始化唯一工作空间，并发放恢复密钥与首台设备凭证。
 */
identityRoutes.post('/bootstrap', validateJsonBody(bootstrapRequestSchema), async (c) => {
  const configuredSecret = c.env.BOOTSTRAP_SECRET;
  if (configuredSecret === undefined || configuredSecret.length < MIN_BOOTSTRAP_SECRET_LENGTH) {
    // fail-closed：部署未配置（或配置了过短）初始化密钥时，直接拒绝且不解释原因。
    logIdentityFailure(c, 'bootstrap', 'bootstrap_secret_not_configured');
    return errorResponse('service_unavailable', DEFAULT_ERROR_MESSAGE.service_unavailable, requestIdOf(c));
  }

  const scope = await identityScopeKeys(c, 'bootstrap');
  const decision = await enforceRateLimits(c.env.DB, [
    [scope.client, RATE_LIMITS.bootstrapPerClient],
    [scope.global, RATE_LIMITS.bootstrapGlobal],
  ]);
  if (!decision.allowed) {
    return rateLimited(c, decision);
  }

  if (!(await credentialMatches(c.req.header(BOOTSTRAP_SECRET_HEADER), configuredSecret))) {
    logIdentityFailure(c, 'bootstrap', 'bootstrap_secret_mismatch');
    throw new ApiError('unauthorized', DEFAULT_ERROR_MESSAGE.unauthorized);
  }

  const body = parsedJsonBody(c, bootstrapRequestSchema);
  const outcome = await bootstrapWorkspace(c.env.DB, {
    region: body.region,
    timezone: body.timezone,
    locale: body.locale,
    deviceName: body.deviceName,
  });

  if (!outcome.ok) {
    // 409：初始化通道已消费。并发失败的请求也会落到这里，且数据库中没有留下半初始化状态。
    throw new ApiError('conflict', '该部署已完成初始化，初始化通道已关闭。', 'bootstrap_already_initialized');
  }

  return noStoreJson(
    c,
    bootstrapResponseSchema.parse({
      workspaceId: outcome.workspaceId,
      recoveryKey: outcome.recoveryKey,
      deviceToken: outcome.deviceToken,
      device: deviceSummary({ id: outcome.deviceId, name: body.deviceName, createdAt: outcome.createdAt }),
    }),
    201,
  );
});

/**
 * POST /identity/pairing
 * 由已认证设备生成一次性、有限期的配对凭证。
 */
identityRoutes.post('/pairing', deviceAuth(), validateJsonBody(pairingCreateRequestSchema), async (c) => {
  const decision = await enforceRateLimits(c.env.DB, [
    [`pairing-create:${c.get('deviceId')}`, RATE_LIMITS.pairingCreatePerDevice],
  ]);
  if (!decision.allowed) {
    return rateLimited(c, decision);
  }

  const body = parsedJsonBody(c, pairingCreateRequestSchema);
  const created = await createPairing(c.env.DB, {
    workspaceId: c.get('workspaceId'),
    createdByDevice: c.get('deviceId'),
    ...(body.ttlSeconds === undefined ? {} : { ttlSeconds: body.ttlSeconds }),
  });

  return noStoreJson(c, pairingCreateResponseSchema.parse(created), 201);
});

/**
 * POST /identity/pairing/claim
 * 凭配对凭证领取新设备凭证；一次性消费，且发起设备被撤销后立即失效。
 */
identityRoutes.post('/pairing/claim', validateJsonBody(pairingClaimRequestSchema), async (c) => {
  const scope = await identityScopeKeys(c, 'pairing-claim');
  const decision = await enforceRateLimits(c.env.DB, [
    [scope.client, RATE_LIMITS.pairingClaimPerClient],
    [scope.global, RATE_LIMITS.pairingClaimGlobal],
  ]);
  if (!decision.allowed) {
    return rateLimited(c, decision);
  }

  const body = parsedJsonBody(c, pairingClaimRequestSchema);
  const outcome = await claimPairing(c.env.DB, { pairingCode: body.pairingCode, deviceName: body.deviceName });

  if (!outcome.ok) {
    // 过期 / 已消费 / 发起设备已撤销 / 不存在：对外统一 401，只有日志记录真实原因。
    logIdentityFailure(c, 'pairing_claim', outcome.reason);
    throw new ApiError('unauthorized', DEFAULT_ERROR_MESSAGE.unauthorized);
  }

  return noStoreJson(
    c,
    pairingClaimResponseSchema.parse({
      deviceToken: outcome.deviceToken,
      device: deviceSummary({ id: outcome.deviceId, name: body.deviceName, createdAt: outcome.createdAt }),
    }),
    201,
  );
});

/**
 * POST /identity/recover
 * 用离线备份的恢复密钥换发一台新设备的凭证。
 */
identityRoutes.post('/recover', validateJsonBody(recoverRequestSchema), async (c) => {
  const scope = await identityScopeKeys(c, 'recover');
  const decision = await enforceRateLimits(c.env.DB, [
    [scope.client, RATE_LIMITS.recoverPerClient],
    [scope.global, RATE_LIMITS.recoverGlobal],
  ]);
  if (!decision.allowed) {
    return rateLimited(c, decision);
  }

  const body = parsedJsonBody(c, recoverRequestSchema);
  const outcome = await recoverDeviceAccess(c.env.DB, {
    recoveryKey: body.recoveryKey,
    deviceName: body.deviceName,
  });

  if (!outcome.ok) {
    logIdentityFailure(c, 'recover', outcome.reason);
    throw new ApiError('unauthorized', DEFAULT_ERROR_MESSAGE.unauthorized);
  }

  return noStoreJson(
    c,
    recoverResponseSchema.parse({
      deviceToken: outcome.deviceToken,
      device: deviceSummary({ id: outcome.deviceId, name: body.deviceName, createdAt: outcome.createdAt }),
    }),
    201,
  );
});

// 其余方法：结构化 405。
identityRoutes.all('*', methodNotAllowed(['POST']));

