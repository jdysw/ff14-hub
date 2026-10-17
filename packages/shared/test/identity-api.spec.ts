import { describe, expect, it } from 'vitest';
import { DEVICE_TOKEN_PATTERN, PAIRING_CODE_PATTERN, RECOVERY_KEY_PATTERN, TOKEN_BODY_LENGTH } from '../src/identity';
import {
  MAX_PAIRING_TTL_SECONDS,
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  pairingClaimRequestSchema,
  pairingClaimResponseSchema,
  pairingCreateRequestSchema,
  recoverRequestSchema,
  recoverResponseSchema,
} from '../src/identity-api';

const FAKE_DEVICE_TOKEN = `ffh_dev_${'A'.repeat(TOKEN_BODY_LENGTH)}`;
const FAKE_RECOVERY_KEY = `ffh_rec_${'B'.repeat(TOKEN_BODY_LENGTH)}`;
const FAKE_PAIRING_CODE = `ffh_pair_${'C'.repeat(TOKEN_BODY_LENGTH)}`;

const deviceSummary = {
  id: 'device-1',
  name: '测试设备',
  createdAt: 1,
  lastSeenAt: null,
  revokedAt: null,
  current: true,
};

describe('身份 API 契约（HUB-006 实现依据）', () => {
  it('bootstrap 请求不包含任何密钥字段，且填充安全默认值', () => {
    const parsed = bootstrapRequestSchema.safeParse({ deviceName: '我的设备' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.region).toBe('cn');
      expect(parsed.data.timezone).toBe('Asia/Shanghai');
      expect(parsed.data.locale).toBe('zh-CN');
      // 请求体里绝不允许出现初始化密钥或凭证字段。
      expect(Object.keys(parsed.data)).toEqual(['region', 'timezone', 'locale', 'deviceName']);
    }
  });

  it('bootstrap 请求拒绝夹带密钥类字段（strict）', () => {
    for (const injected of ['bootstrapSecret', 'secret', 'token', 'recoveryKey']) {
      const parsed = bootstrapRequestSchema.safeParse({ deviceName: 'x', [injected]: 'value' });
      expect(parsed.success, injected).toBe(false);
    }
  });

  it('bootstrap 响应中的凭证必须满足对应形状', () => {
    const ok = bootstrapResponseSchema.safeParse({
      workspaceId: 'ws-1',
      recoveryKey: FAKE_RECOVERY_KEY,
      deviceToken: FAKE_DEVICE_TOKEN,
      device: deviceSummary,
    });
    expect(ok.success).toBe(true);

    // 形状不符（例如长度不足的低熵值）必须被拒绝。
    expect(
      bootstrapResponseSchema.safeParse({
        workspaceId: 'ws-1',
        recoveryKey: 'ffh_rec_short',
        deviceToken: FAKE_DEVICE_TOKEN,
        device: deviceSummary,
      }).success,
    ).toBe(false);
  });

  it('配对凭证 TTL 有上限，避免长期有效的一次性凭证', () => {
    expect(pairingCreateRequestSchema.safeParse({}).success).toBe(true);
    const defaulted = pairingCreateRequestSchema.safeParse({});
    if (defaulted.success) {
      expect(defaulted.data.ttlSeconds).toBe(600);
    }
    expect(pairingCreateRequestSchema.safeParse({ ttlSeconds: MAX_PAIRING_TTL_SECONDS }).success).toBe(true);
    expect(pairingCreateRequestSchema.safeParse({ ttlSeconds: MAX_PAIRING_TTL_SECONDS + 1 }).success).toBe(false);
    expect(pairingCreateRequestSchema.safeParse({ ttlSeconds: 10 }).success).toBe(false);
  });

  it('配对码与恢复密钥分别只能用在自己的端点上', () => {
    expect(pairingClaimRequestSchema.safeParse({ pairingCode: FAKE_PAIRING_CODE, deviceName: 'x' }).success).toBe(true);
    // 把恢复密钥当配对码提交必须被拒绝。
    expect(pairingClaimRequestSchema.safeParse({ pairingCode: FAKE_RECOVERY_KEY, deviceName: 'x' }).success).toBe(false);
    expect(recoverRequestSchema.safeParse({ recoveryKey: FAKE_RECOVERY_KEY, deviceName: 'x' }).success).toBe(true);
    // 把配对码当恢复密钥提交必须被拒绝。
    expect(recoverRequestSchema.safeParse({ recoveryKey: FAKE_PAIRING_CODE, deviceName: 'x' }).success).toBe(false);
  });

  it('领取与恢复的响应只返回摘要之外的明文一次，且设备摘要不含 token', () => {
    const claim = pairingClaimResponseSchema.safeParse({ deviceToken: FAKE_DEVICE_TOKEN, device: deviceSummary });
    expect(claim.success).toBe(true);
    const recover = recoverResponseSchema.safeParse({ deviceToken: FAKE_DEVICE_TOKEN, device: deviceSummary });
    expect(recover.success).toBe(true);
    // 设备摘要契约本身不得包含 token / token_hash 字段。
    expect(Object.keys(deviceSummary)).not.toContain('token');
    expect(Object.keys(deviceSummary)).not.toContain('tokenHash');
  });

  it('三类凭证的形状互不相同，不能互相替代', () => {
    expect(DEVICE_TOKEN_PATTERN.test(FAKE_DEVICE_TOKEN)).toBe(true);
    expect(DEVICE_TOKEN_PATTERN.test(FAKE_RECOVERY_KEY)).toBe(false);
    expect(RECOVERY_KEY_PATTERN.test(FAKE_RECOVERY_KEY)).toBe(true);
    expect(RECOVERY_KEY_PATTERN.test(FAKE_PAIRING_CODE)).toBe(false);
    expect(PAIRING_CODE_PATTERN.test(FAKE_PAIRING_CODE)).toBe(true);
    expect(PAIRING_CODE_PATTERN.test(FAKE_DEVICE_TOKEN)).toBe(false);
  });
});
