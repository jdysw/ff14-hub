import { describe, expect, it } from 'vitest';
import {
  DEVICE_TOKEN_PATTERN,
  PAIRING_CODE_PATTERN,
  RECOVERY_KEY_PATTERN,
  TOKEN_BODY_LENGTH,
  TOKEN_RANDOM_BYTES,
  parseBearerToken,
  timingSafeEqualHex,
} from '../src/identity';

/** 构造一个形状合法的假 Token（不是真实凭证，仅为形状测试）。 */
const FAKE_DEVICE_TOKEN = `ffh_dev_${'A'.repeat(TOKEN_BODY_LENGTH)}`;

describe('身份 Token 契约', () => {
  it('要求至少 256-bit 随机量：32 字节经 base64url 后为 43 个字符', () => {
    expect(TOKEN_RANDOM_BYTES).toBe(32);
    expect(TOKEN_BODY_LENGTH).toBe(43);
    expect(DEVICE_TOKEN_PATTERN.test(FAKE_DEVICE_TOKEN)).toBe(true);
  });

  it('设备、恢复、配对三类凭证形状互相不可混用', () => {
    expect(RECOVERY_KEY_PATTERN.test(FAKE_DEVICE_TOKEN)).toBe(false);
    expect(PAIRING_CODE_PATTERN.test(FAKE_DEVICE_TOKEN)).toBe(false);
    expect(DEVICE_TOKEN_PATTERN.test(`ffh_rec_${'A'.repeat(TOKEN_BODY_LENGTH)}`)).toBe(false);
  });

  it('拒绝长度不足的低熵凭证形态', () => {
    expect(DEVICE_TOKEN_PATTERN.test('ffh_dev_short')).toBe(false);
    expect(DEVICE_TOKEN_PATTERN.test(`ffh_dev_${'A'.repeat(TOKEN_BODY_LENGTH + 1)}`)).toBe(false);
  });

  describe('parseBearerToken', () => {
    it('缺少 Header 视为 missing', () => {
      expect(parseBearerToken(undefined)).toEqual({ ok: false, reason: 'missing' });
      expect(parseBearerToken(null)).toEqual({ ok: false, reason: 'missing' });
      expect(parseBearerToken('   ')).toEqual({ ok: false, reason: 'missing' });
    });

    it('接受 Bearer 方案（大小写不敏感）并返回原始 token', () => {
      expect(parseBearerToken(`Bearer ${FAKE_DEVICE_TOKEN}`)).toEqual({ ok: true, token: FAKE_DEVICE_TOKEN });
      expect(parseBearerToken(`bearer ${FAKE_DEVICE_TOKEN}`)).toEqual({ ok: true, token: FAKE_DEVICE_TOKEN });
    });

    it('拒绝非 Bearer 方案与形状非法的 token', () => {
      expect(parseBearerToken(`Basic ${FAKE_DEVICE_TOKEN}`)).toEqual({ ok: false, reason: 'malformed' });
      expect(parseBearerToken('Bearer')).toEqual({ ok: false, reason: 'malformed' });
      expect(parseBearerToken('Bearer not-a-real-token')).toEqual({ ok: false, reason: 'malformed' });
      // 恢复密钥不能当作设备 Token 使用。
      expect(parseBearerToken(`Bearer ffh_rec_${'A'.repeat(TOKEN_BODY_LENGTH)}`)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    });
  });

  describe('timingSafeEqualHex', () => {
    it('相等返回 true，不等返回 false', () => {
      expect(timingSafeEqualHex('abc123', 'abc123')).toBe(true);
      expect(timingSafeEqualHex('abc123', 'abc124')).toBe(false);
    });

    it('长度不同直接返回 false（摘要长度固定，长度本身不敏感）', () => {
      expect(timingSafeEqualHex('abc', 'abcd')).toBe(false);
    });
  });
});
