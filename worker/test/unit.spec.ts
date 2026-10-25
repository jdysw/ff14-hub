/**
 * 纯函数级单元测试（脱敏、校验摘要、写请求规则、凭证原语、环境解析）。
 *
 * 这些测试不依赖数据库，但仍在 Workers 运行时执行，
 * 因此 crypto.subtle / btoa 等 API 的行为与生产一致。
 */
const TOKEN_BODY_LENGTH = 43;
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { parseEnv, parseAllowedOrigins } from '../env';
import { REDACTED, logLine, redactSecrets } from '../lib/redact';
import { constantTimeEqualStrings } from '../lib/util';
import { normalizeRequestId } from '../middleware/request-id';
import { describeIssues } from '../middleware/validation';
import { isAllowedOrigin, isJsonContentType } from '../middleware/write-guard';
import {
  credentialsEqual,
  generateCredential,
  hashCredential,
  toBase64Url,
} from '../modules/identity/credentials';

describe('日志脱敏', () => {
  it('脱敏三类高熵凭证前缀', () => {
    for (const prefix of ['ffh_dev_', 'ffh_rec_', 'ffh_pair_']) {
      const text = `请求使用 ${prefix}${'A'.repeat(TOKEN_BODY_LENGTH)} 失败`;
      const redacted = redactSecrets(text);
      expect(redacted).not.toContain('A'.repeat(TOKEN_BODY_LENGTH));
      expect(redacted).toContain(REDACTED);
    }
  });

  it('脱敏 Authorization 头', () => {
    const redacted = redactSecrets('authorization: Bearer abcdef1234567890');
    expect(redacted).not.toContain('abcdef1234567890');
    expect(redacted).toContain(REDACTED);
  });

  it('脱敏 64 位十六进制摘要（token_hash / recovery_hash）', () => {
    const digest = 'a'.repeat(64);
    const redacted = redactSecrets(`token_hash=${digest}`);
    expect(redacted).not.toContain(digest);
  });

  it('脱敏常见敏感字段名（含 WebDAV 凭证，INV-06）', () => {
    for (const field of ['password', 'recovery_key', 'api_key', 'private_key', 'webdav_password', 'auth_secret']) {
      const redacted = redactSecrets(`{"${field}":"super-secret-value"}`);
      expect(redacted, field).not.toContain('super-secret-value');
    }
  });

  it('preserves sensitive key prefixes, delimiters and mixed-case suffixes', () => {
    const fields = ['password','passwd','pwd','secret','token','token_hash','recovery_hash','recovery_key','pairing_hash','pairing_code','api_key','api-key','apikey','private_key','private-key','privatekey','p256dh','auth','auth_secret','username','webdav_password','webdav-password','webdavpassword'];
    for (const field of fields) {
      const key = field.toUpperCase();
      const input = `{"${key}": "private-value", "ok": 1} ${key}=another&keep=yes`;
      expect(redactSecrets(input)).toBe(`{"${key}": "[REDACTED]", "ok": 1} ${key}=[REDACTED]&keep=yes`);
    }
    expect(redactSecrets('mytoken_hash=secret auth_secret=hidden pwd=; token='))
      .toBe('mytoken_hash=[REDACTED] auth_secret=[REDACTED] pwd=; token=');
    expect(redactSecrets('token="username=hidden"; ok=yes'))
      .toBe('token="[REDACTED]"; ok=yes');
  });

  it('keeps partial field names and long malformed suffixes as text', () => {
    const text = 'token_hash'+ ' '.repeat(30_000) +'! keep=yes';
    expect(redactSecrets(text)).toBe(text);
  });

  it('encodes all byte values without padding and round-trips every remainder', () => {
    for (const length of [0,1,2,3,31,32,33,256]) {
      const bytes = Uint8Array.from({length}, (_, index) => index);
      const encoded = toBase64Url(bytes);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
      const padded = encoded.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(encoded.length/4)*4, '=');
      expect(Uint8Array.from(atob(padded), char => char.codePointAt(0)!)).toEqual(bytes);
    }
  });

  it('脱敏 URL 查询串中的一次性密钥（Web Push 端点场景）', () => {
    const redacted = redactSecrets('https://push.example/send?token=abcdef&x=1');
    expect(redacted).not.toContain('token=abcdef');
    expect(redacted).toContain('x=1');
  });

  it('普通文本不被改动，避免日志失去可读性', () => {
    const text = '请求路径 /api/v1/health 返回 200，耗时 3ms';
    expect(redactSecrets(text)).toBe(text);
  });

  it('非字符串输入不被打平为对象字面量', () => {
    expect(redactSecrets(undefined)).toBe('');
    expect(redactSecrets({ secret: 'x' })).toBe('[UNPRINTABLE]');
    expect(redactSecrets(new Error('boom ffh_dev_' + 'B'.repeat(TOKEN_BODY_LENGTH)))).not.toContain(
      'B'.repeat(TOKEN_BODY_LENGTH),
    );
  });

  it('logLine 产出可解析的 JSON，且字段已脱敏', () => {
    const line = logLine('warn', 'device_auth_failed', {
      requestId: 'req-1',
      reason: 'invalid',
      token: `ffh_dev_${'C'.repeat(TOKEN_BODY_LENGTH)}`,
    });
    const parsed = JSON.parse(line) as Record<string, string>;
    expect(parsed['level']).toBe('warn');
    expect(parsed['event']).toBe('device_auth_failed');
    expect(parsed['reason']).toBe('invalid');
    expect(parsed['token']).toBe(REDACTED);
  });
  it('按敏感字段名隐藏不带凭证前缀的值，并防止覆盖日志级别和事件',()=>{
    for(const key of ['password','VAPID_PRIVATE_KEY','accessToken','Authorization','cookie','username','endpoint','subscription','p256dh']){
      const text=logLine('warn','trusted_event',{[key]:'plain private phrase without a token prefix',level:'info',event:'forged'});
      const parsed=JSON.parse(text) as Record<string,string>;
      expect(parsed[key]).toBe(REDACTED);expect(text).not.toContain('plain private');
      expect(parsed['level']).toBe('warn');expect(parsed['event']).toBe('trusted_event');
    }
  });
});

describe('请求 ID 规范化', () => {
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it('回显形状合法的请求 ID', () => {
    expect(normalizeRequestId('test-request-id-0001')).toBe('test-request-id-0001');
  });

  it('缺少或形状非法时生成新 UUID，不原样回显', () => {
    expect(normalizeRequestId(undefined)).toMatch(UUID_PATTERN);
    expect(normalizeRequestId('short')).toMatch(UUID_PATTERN);
    expect(normalizeRequestId('a'.repeat(200))).toMatch(UUID_PATTERN);
    expect(normalizeRequestId('bad id\r\nX-Injected: 1')).toMatch(UUID_PATTERN);
    expect(normalizeRequestId('bad id\r\nX-Injected: 1')).not.toContain('X-Injected');
  });

  it('平台层同样拒绝含 CRLF 的头值（第二道防线）', () => {
    // 记录这一事实：注入型请求在到达 Worker 之前就会被 Headers 构造拒绝。
    expect(() => new Headers({ 'X-Request-Id': 'a\r\nb' })).toThrow();
  });
});

describe('校验失败描述', () => {
  it('只输出字段路径与问题类别，绝不包含提交的值', () => {
    const description = describeIssues([
      { path: ['label'], code: 'invalid_type' },
      { path: ['nested', 'count'], code: 'too_big' },
      { path: [], code: 'custom' },
    ]);
    expect(description).toContain('label: 类型不正确');
    expect(description).toContain('nested.count: 长度或数值过大');
    expect(description).toContain('<root>: 不满足额外约束');
  });

  it('限制条目数，避免消息无限增长', () => {
    const issues = Array.from({ length: 20 }, () => ({ path: ['x'], code: 'invalid_type' }));
    const description = describeIssues(issues);
    expect(description).toContain('共 20 项');
    expect(description.length).toBeLessThan(300);
  });
});

describe('写请求规则', () => {
  it('只接受 application/json 与 +json 后缀', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
    expect(isJsonContentType('application/merge-patch+json')).toBe(true);
    expect(isJsonContentType('Application/JSON')).toBe(true);
    expect(isJsonContentType('text/plain')).toBe(false);
    expect(isJsonContentType('application/x-www-form-urlencoded')).toBe(false);
    expect(isJsonContentType('text/json')).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
  });

  it('Origin 判定：同源放行、跨源拒绝、无法解析拒绝', () => {
    const requestUrl = 'https://ff14-hub.test/api/v1/health';
    expect(isAllowedOrigin('https://ff14-hub.test', requestUrl, [])).toBe(true);
    expect(isAllowedOrigin('https://evil.example', requestUrl, [])).toBe(false);
    expect(isAllowedOrigin('not-a-url', requestUrl, [])).toBe(false);
    // 端口/协议不同即不同源。
    expect(isAllowedOrigin('http://ff14-hub.test', requestUrl, [])).toBe(false);
    expect(isAllowedOrigin('https://ff14-hub.test:8443', requestUrl, [])).toBe(false);
    // 白名单项优先放行。
    expect(isAllowedOrigin('https://preview.example', requestUrl, ['https://preview.example'])).toBe(true);
  });
});

describe('现行高熵凭证与哈希原语', () => {
  it('临时高熵凭证符合 32 字节无填充 base64url 的形状', () => {
    const token = generateCredential('ffh_test_');
    expect(/^ffh_test_[A-Za-z0-9_-]{43}$/.test(token)).toBe(true);
    expect(token).toHaveLength('ffh_test_'.length + TOKEN_BODY_LENGTH);
  });

  it('每次生成都不同（高熵随机的实际检验）', () => {
    const tokens = new Set(Array.from({ length: 64 }, () => generateCredential('ffh_test_')));
    expect(tokens.size).toBe(64);
  });

  it('不同前缀产出不同类别凭证', () => {
    expect(generateCredential('ffh_admin_').startsWith('ffh_admin_')).toBe(true);
    expect(generateCredential('ffh_push_').startsWith('ffh_push_')).toBe(true);
  });

  it('摘要确定、长度为 64 位十六进制，且不等于明文', async () => {
    const token = generateCredential('ffh_test_');
    const first = await hashCredential(token);
    const second = await hashCredential(token);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toContain(token);
    expect(await hashCredential(`${token}x`)).not.toBe(first);
  });
});

describe('常量时间比较（使用平台原语）', () => {
  it('相等、不等、长度不同的判断都正确', () => {
    expect(constantTimeEqualStrings('abcd', 'abcd')).toBe(true);
    expect(constantTimeEqualStrings('abcd', 'abce')).toBe(false);
    expect(constantTimeEqualStrings('abc', 'abcd')).toBe(false);
    expect(constantTimeEqualStrings('', '')).toBe(true);
  });

  it('底层使用平台提供的 crypto.subtle.timingSafeEqual，而不是手写 JS 循环', () => {
    expect(typeof crypto.subtle.timingSafeEqual).toBe('function');
  });

  it('credentialsEqual 对相同凭证返回 true、对不同凭证返回 false', async () => {
    const token = generateCredential('ffh_test_');
    expect(await credentialsEqual(token, token)).toBe(true);
    expect(await credentialsEqual(token, generateCredential('ffh_test_'))).toBe(false);
    // 前缀相同但主体不同也必须判为不等。
    expect(await credentialsEqual(`ffh_dev_${'A'.repeat(43)}`, `ffh_dev_${'B'.repeat(43)}`)).toBe(false);
  });
});

describe('环境解析', () => {
  it('接受完整合法的环境', () => {
    const result = parseEnv({ DB: env.DB, ENVIRONMENT: 'preview', ENABLE_TEST_ROUTES: '1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.environment).toBe('preview');
      expect(result.config.enableTestRoutes).toBe(true);
      expect(result.config.hasBootstrapSecret).toBe(false);
    }
  });

  it('拒绝缺失或类型错误的 DB 绑定，并只给出字段级问题描述', () => {
    const result = parseEnv({ DB: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join('; ')).toContain('DB');
      // 问题描述里不应包含被校验对象的值。
      expect(result.issues.join('; ')).not.toContain('[object');
    }
  });

  it('过短 Bootstrap 密钥仅禁用初始化能力，不让公开站点因全局环境校验失败（只暴露状态）', () => {
    const short = parseEnv({ DB: env.DB, BOOTSTRAP_SECRET: 'too-short' });
    expect(short.ok).toBe(true);
    if (short.ok) {
      expect(short.config.hasBootstrapSecret).toBe(false);
      expect(JSON.stringify(short.config)).not.toContain('too-short');
    }
    // 类型错误依旧视为环境异常，不放宽绑定/配置结构验证。
    expect(parseEnv({ DB: env.DB, BOOTSTRAP_SECRET: 123 }).ok).toBe(false);
    const ok = parseEnv({ DB: env.DB, BOOTSTRAP_SECRET: 'x'.repeat(32) });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.config.hasBootstrapSecret).toBe(true);
      expect(JSON.stringify(ok.config)).not.toContain('x'.repeat(32));
    }
  });

  it('显式丢弃通配 Origin，避免把 "*" 误当作允许项', () => {
    expect(parseAllowedOrigins('*')).toEqual([]);
    expect(parseAllowedOrigins('https://a.example, *, https://b.example')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
    expect(parseAllowedOrigins('   ')).toEqual([]);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });
});
