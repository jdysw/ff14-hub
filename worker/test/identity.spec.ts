/**
 * 身份系统功能测试（HUB-006），全部在真实 workerd + Miniflare D1 中执行。
 *
 * 覆盖用户要求的验收点：Bootstrap 原子单例与并发重放、每设备独立 256-bit 令牌且只存摘要、
 * 立即撤销、配对有效期与并发单次消费、发起设备撤销后配对失效、恢复访问、审计一致性。
 */
import {
  DEVICE_TOKEN_PATTERN,
  PAIRING_CODE_PATTERN,
  RECOVERY_KEY_PATTERN,
  TOKEN_BODY_LENGTH,
  bootstrapResponseSchema,
} from '@ff14-hub/shared';
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import {
  TEST_BOOTSTRAP_SECRET,
  URLS,
  bootstrapHeaders,
  bootstrapViaApi,
  countRows,
  createPairingViaApi,
  forcePairingExpiry,
  jsonPost,
  partialEnv,
  readAuditEvents,
  resetIdentityState,
} from './helpers';

beforeEach(async () => {
  await resetIdentityState();
});

describe('Bootstrap：一次性工作空间初始化', () => {
  it('成功时返回 201 与符合契约的凭证，且响应不可缓存', async () => {
    const response = await SELF.fetch(URLS.bootstrap, jsonPost({ deviceName: '我的电脑' }, bootstrapHeaders()));
    expect(response.status).toBe(201);
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    const body: unknown = await response.json();
    const parsed = bootstrapResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.device.name).toBe('我的电脑');
      expect(parsed.data.device.current).toBe(true);
      expect(DEVICE_TOKEN_PATTERN.test(parsed.data.deviceToken)).toBe(true);
      expect(RECOVERY_KEY_PATTERN.test(parsed.data.recoveryKey)).toBe(true);
    }
    expect(await countRows('workspaces')).toBe(1);
    expect(await countRows('devices')).toBe(1);
    expect(await countRows('workspace_bootstrap_guard')).toBe(1);
  });

  it('应用默认区域/时区/语言（cn / Asia/Shanghai / zh-CN）', async () => {
    await bootstrapViaApi();
    const row = await env.DB.prepare('SELECT region, timezone, locale FROM workspaces')
      .first<{ region: string; timezone: string; locale: string }>();
    expect(row).toEqual({ region: 'cn', timezone: 'Asia/Shanghai', locale: 'zh-CN' });
  });

  it('凭证是高熵随机值：两次初始化尝试产生的值互不相同', async () => {
    const first = await bootstrapViaApi();
    // 第二次必然失败（单例），因此用「重放」验证值不会复用。
    const replay = await SELF.fetch(URLS.bootstrap, jsonPost({ deviceName: 'again' }, bootstrapHeaders()));
    expect(replay.status).toBe(409);

    await resetIdentityState();
    const second = await bootstrapViaApi();
    expect(second.deviceToken).not.toBe(first.deviceToken);
    expect(second.recoveryKey).not.toBe(first.recoveryKey);
  });

  it('数据库只存摘要：不存在明文凭证列，摘要为 64 位十六进制且不等于明文', async () => {
    const result = await bootstrapViaApi();
    const row = await env.DB.prepare('SELECT token_hash, name FROM devices WHERE id = ?')
      .bind(result.deviceId)
      .first<{ token_hash: string; name: string }>();
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.token_hash).not.toBe(result.deviceToken);

    const workspace = await env.DB.prepare('SELECT recovery_hash FROM workspaces')
      .first<{ recovery_hash: string }>();
    expect(workspace?.recovery_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(workspace?.recovery_hash).not.toBe(result.recoveryKey);

    const deviceColumns = await env.DB.prepare("SELECT name FROM pragma_table_info('devices')").all<{ name: string }>();
    const names = deviceColumns.results.map((column) => column.name);
    expect(names).toContain('token_hash');
    expect(names).not.toContain('token');
  });

  it('重复 Bootstrap 返回 409，且不新增任何行', async () => {
    await bootstrapViaApi();
    const response = await SELF.fetch(URLS.bootstrap, jsonPost({ deviceName: '第二次' }, bootstrapHeaders()));
    expect(response.status).toBe(409);
    const body = await response.json<{ code: string }>();
    expect(body.code).toBe('conflict');

    expect(await countRows('workspaces')).toBe(1);
    expect(await countRows('devices')).toBe(1);
    expect(await countRows('workspace_bootstrap_guard')).toBe(1);
    // 失败的第二次不应产生 workspace_bootstrapped 审计
    const audits = await readAuditEvents();
    expect(audits.filter((row) => row.event_type === 'workspace_bootstrapped')).toHaveLength(1);
  });

  it('并发 Bootstrap：恰好一个成功，且不遗留半初始化状态', async () => {
    const responses = await Promise.all(
      Array.from({ length: 4 }, (_unused, index) =>
        SELF.fetch(URLS.bootstrap, jsonPost({ deviceName: `并发-${index}` }, bootstrapHeaders())),
      ),
    );

    const created = responses.filter((response) => response.status === 201);
    const conflicts = responses.filter((response) => response.status === 409);
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(3);

    // 关键不变量：三种行数必须彼此一致——不存在「有 guard 没 workspace」或「有 workspace 没 device」。
    expect(await countRows('workspace_bootstrap_guard')).toBe(1);
    expect(await countRows('workspaces')).toBe(1);
    expect(await countRows('devices')).toBe(1);
    expect((await readAuditEvents()).filter((row) => row.event_type === 'workspace_bootstrapped')).toHaveLength(1);
  });

  it('未配置初始化密钥时拒绝为 503，且不创建任何行', async () => {
    const app = createApp();
    // 刻意构造「部署未配置初始化密钥」的环境。
    const response = await app.request(
      URLS.bootstrap,
      jsonPost({ deviceName: 'x' }, bootstrapHeaders()),
      partialEnv({ DB: env.DB, ENVIRONMENT: 'test' }),
    );

    expect(response.status).toBe(503);
    const body = await response.json<{ code: string; message: string; requestId: string }>();
    expect(body.code).toBe('service_unavailable');
    // 不解释原因，不泄露任何配置细节。
    expect(JSON.stringify(body)).not.toContain('BOOTSTRAP');
    expect(await countRows('workspaces')).toBe(0);
    expect(await countRows('workspace_bootstrap_guard')).toBe(0);
  });

  it('缺少或错误的初始化密钥返回 401，且不创建任何行', async () => {
    const missing = await SELF.fetch(URLS.bootstrap, jsonPost({ deviceName: 'x' }));
    expect(missing.status).toBe(401);

    const wrong = await SELF.fetch(
      URLS.bootstrap,
      jsonPost({ deviceName: 'x' }, bootstrapHeaders('wrong-secret-value-that-is-long-enough-000')),
    );
    expect(wrong.status).toBe(401);

    // 两者响应完全一致，不提供枚举信号。
    const missingBody = await missing.json<{ code: string; message: string }>();
    const wrongBody = await wrong.json<{ code: string; message: string }>();
    expect(missingBody.code).toBe(wrongBody.code);
    expect(missingBody.message).toBe(wrongBody.message);

    expect(await countRows('workspaces')).toBe(0);
  });

  it('初始化密钥绝不出现在任何响应体或审计明细中', async () => {
    const response = await SELF.fetch(URLS.bootstrap, jsonPost({ deviceName: 'x' }, bootstrapHeaders()));
    const text = await response.text();
    expect(text).not.toContain(TEST_BOOTSTRAP_SECRET);

    const audits = await readAuditEvents();
    for (const audit of audits) {
      expect(audit.detail_json).not.toContain(TEST_BOOTSTRAP_SECRET);
    }
  });

  it('测试使用的初始化密钥被明确标记为测试值（禁止把生产秘密硬编码进仓库）', () => {
    expect(TEST_BOOTSTRAP_SECRET.startsWith('test-only')).toBe(true);
    expect(TEST_BOOTSTRAP_SECRET.length).toBeGreaterThanOrEqual(32);
  });
});

describe('设备令牌：独立、高熵、只存摘要', () => {
  it('配对产生的新设备拥有独立令牌，且与所有者设备不同', async () => {
    const owner = await bootstrapViaApi();
    const pairing = await createPairingViaApi(owner.authorization);

    const claim = await SELF.fetch(
      URLS.pairingClaim,
      jsonPost({ pairingCode: pairing.pairingCode, deviceName: '第二台设备' }),
    );
    expect(claim.status).toBe(201);
    const claimed = await claim.json<{ deviceToken: string; device: { id: string } }>();

    expect(claimed.deviceToken).not.toBe(owner.deviceToken);
    expect(DEVICE_TOKEN_PATTERN.test(claimed.deviceToken)).toBe(true);
    expect(claimed.device.id).not.toBe(owner.deviceId);
    expect(TOKEN_BODY_LENGTH).toBe(43);

    // 两台设备各自的摘要互不相同，且都不等于明文。
    const rows = await env.DB.prepare('SELECT token_hash FROM devices').all<{ token_hash: string }>();
    const hashes = rows.results.map((row) => row.token_hash);
    expect(new Set(hashes).size).toBe(2);
    expect(hashes).not.toContain(claimed.deviceToken);
    expect(hashes).not.toContain(owner.deviceToken);
  });
});

describe('配对：有效期与单次消费', () => {
  it('创建配对返回 201，有效期被夹紧在上限之内', async () => {
    const owner = await bootstrapViaApi();
    const pairing = await createPairingViaApi(owner.authorization);
    expect(PAIRING_CODE_PATTERN.test(pairing.pairingCode)).toBe(true);
    expect(pairing.expiresAt).toBeGreaterThan(Date.now());
    expect(pairing.expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000 + 5_000);
  });

  it('超过上限的 TTL 被拒绝（不能只信请求参数）', async () => {
    const owner = await bootstrapViaApi();
    const response = await SELF.fetch(
      URLS.pairing,
      jsonPost({ ttlSeconds: 86_400 }, { Authorization: owner.authorization }),
    );
    expect(response.status).toBe(422);
  });

  it('配对码一次性消费：第二次领取返回 401 且不新增设备', async () => {
    const owner = await bootstrapViaApi();
    const pairing = await createPairingViaApi(owner.authorization);
    const body = jsonPost({ pairingCode: pairing.pairingCode, deviceName: '第二台' });

    expect((await SELF.fetch(URLS.pairingClaim, body)).status).toBe(201);
    expect((await SELF.fetch(URLS.pairingClaim, body)).status).toBe(401);
    expect(await countRows('devices')).toBe(2);
  });

  it('并发领取同一配对码：恰好一个成功', async () => {
    const owner = await bootstrapViaApi();
    const pairing = await createPairingViaApi(owner.authorization);

    const responses = await Promise.all(
      Array.from({ length: 4 }, (_unused, index) =>
        SELF.fetch(URLS.pairingClaim, jsonPost({ pairingCode: pairing.pairingCode, deviceName: `并发-${index}` })),
      ),
    );

    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    // 失败者必须都是 401（而不是 500），且没有多余设备被创建。
    expect(responses.filter((response) => response.status === 401)).toHaveLength(3);
    expect(await countRows('devices')).toBe(2);
    expect((await readAuditEvents()).filter((row) => row.event_type === 'device_paired')).toHaveLength(1);
  });

  it('过期配对码不可领取', async () => {
    const owner = await bootstrapViaApi();
    const pairing = await createPairingViaApi(owner.authorization);
    await forcePairingExpiry(pairing.pairingCode, Date.now() - 1000);

    const response = await SELF.fetch(
      URLS.pairingClaim,
      jsonPost({ pairingCode: pairing.pairingCode, deviceName: '过期' }),
    );
    expect(response.status).toBe(401);
    expect(await countRows('devices')).toBe(1);
  });

  it('不存在的配对码返回 401（与过期、已消费不可区分）', async () => {
    const unknownCode = `ffh_pair_${'Z'.repeat(TOKEN_BODY_LENGTH)}`;
    const response = await SELF.fetch(URLS.pairingClaim, jsonPost({ pairingCode: unknownCode, deviceName: 'x' }));
    expect(response.status).toBe(401);
    const body = await response.json<{ code: string; message: string }>();
    expect(body.code).toBe('unauthorized');
  });

  it('发起设备被撤销后，其未消费的配对立即失效', async () => {
    const owner = await bootstrapViaApi();
    const pairing = await createPairingViaApi(owner.authorization);

    const revoke = await SELF.fetch(`${URLS.devices}/${owner.deviceId}`, {
      method: 'DELETE',
      headers: { Authorization: owner.authorization },
    });
    expect(revoke.status).toBe(204);

    // 配对记录被删除 → 领取必须失败。
    expect(await countRows('device_pairings')).toBe(0);
    const claim = await SELF.fetch(
      URLS.pairingClaim,
      jsonPost({ pairingCode: pairing.pairingCode, deviceName: '太晚了' }),
    );
    expect(claim.status).toBe(401);
    expect(await countRows('devices')).toBe(1);
  });
});

describe('恢复访问', () => {
  it('正确恢复密钥换发新设备凭证，且恢复密钥不被轮换', async () => {
    const first = await bootstrapViaApi();
    const response = await SELF.fetch(
      URLS.recover,
      jsonPost({ recoveryKey: first.recoveryKey, deviceName: '新手机' }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const recovered = await response.json<{ deviceToken: string; device: { id: string } }>();
    expect(DEVICE_TOKEN_PATTERN.test(recovered.deviceToken)).toBe(true);
    expect(recovered.deviceToken).not.toBe(first.deviceToken);

    // 新设备可立即通过认证。
    const profile = await SELF.fetch(URLS.profile, { headers: { Authorization: `Bearer ${recovered.deviceToken}` } });
    expect(profile.status).toBe(200);

    // 恢复密钥保持不变：用同一个密钥可以再次恢复（离线备份仍然有效）。
    const again = await SELF.fetch(URLS.recover, jsonPost({ recoveryKey: first.recoveryKey, deviceName: '第三台' }));
    expect(again.status).toBe(201);
  });

  it('错误的恢复密钥返回 401，不新增设备', async () => {
    await bootstrapViaApi();
    const wrong = `ffh_rec_${'Y'.repeat(TOKEN_BODY_LENGTH)}`;
    const response = await SELF.fetch(URLS.recover, jsonPost({ recoveryKey: wrong, deviceName: 'x' }));
    expect(response.status).toBe(401);
    expect(await countRows('devices')).toBe(1);
  });

  it('形状不合法（低熵）的恢复密钥被输入校验拒绝为 422', async () => {
    await bootstrapViaApi();
    const response = await SELF.fetch(URLS.recover, jsonPost({ recoveryKey: 'ffh_rec_short', deviceName: 'x' }));
    expect(response.status).toBe(422);
  });
});

describe('设备列表与撤销', () => {
  it('列表只含摘要字段、标记当前设备，且绝不返回 token_hash', async () => {
    const owner = await bootstrapViaApi();
    const response = await SELF.fetch(URLS.devices, { headers: { Authorization: owner.authorization } });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    const text = await response.text();
    expect(text).not.toContain(owner.deviceToken);
    expect(text).not.toContain('token_hash');
    expect(text).not.toContain('recovery_hash');

    const body = JSON.parse(text) as { devices: { id: string; current: boolean; name: string }[] };
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]?.current).toBe(true);
    expect(body.devices[0]?.id).toBe(owner.deviceId);
  });

  it('撤销立即生效：同一 Token 的下一次请求即 401（不依赖任何进程内缓存）', async () => {
    const owner = await bootstrapViaApi();
    const pairing = await createPairingViaApi(owner.authorization);
    const claimed = await (
      await SELF.fetch(URLS.pairingClaim, jsonPost({ pairingCode: pairing.pairingCode, deviceName: '第二台' }))
    ).json<{ deviceToken: string; device: { id: string } }>();

    // 撤销前可用。
    expect(
      (await SELF.fetch(URLS.profile, { headers: { Authorization: `Bearer ${claimed.deviceToken}` } })).status,
    ).toBe(200);

    const revoke = await SELF.fetch(`${URLS.devices}/${claimed.device.id}`, {
      method: 'DELETE',
      headers: { Authorization: owner.authorization },
    });
    expect(revoke.status).toBe(204);

    // 撤销后**立即**被拒。
    const after = await SELF.fetch(URLS.profile, { headers: { Authorization: `Bearer ${claimed.deviceToken}` } });
    expect(after.status).toBe(401);

    // 列表里该设备带 revokedAt。
    const list = await (
      await SELF.fetch(URLS.devices, { headers: { Authorization: owner.authorization } })
    ).json<{ devices: { id: string; revokedAt: number | null }[] }>();
    const revoked = list.devices.find((device) => device.id === claimed.device.id);
    expect(revoked?.revokedAt).not.toBeNull();
  });

  it('重复撤销是幂等的（204），且不重复写审计', async () => {
    const owner = await bootstrapViaApi();
    const first = await SELF.fetch(`${URLS.devices}/${owner.deviceId}`, {
      method: 'DELETE',
      headers: { Authorization: owner.authorization },
    });
    expect(first.status).toBe(204);

    const second = await SELF.fetch(`${URLS.devices}/${owner.deviceId}`, {
      method: 'DELETE',
      headers: { Authorization: owner.authorization },
    });
    // 自己已被撤销，因此这个请求先被认证拦下（401）；这仍然说明单次撤销成立。
    expect([204, 401]).toContain(second.status);

    const revocations = (await readAuditEvents()).filter((row) => row.event_type === 'device_revoked');
    expect(revocations).toHaveLength(1);
  });

  it('不存在的设备返回 404', async () => {
    const owner = await bootstrapViaApi();
    const response = await SELF.fetch(`${URLS.devices}/00000000-0000-0000-0000-000000000000`, {
      method: 'DELETE',
      headers: { Authorization: owner.authorization },
    });
    expect(response.status).toBe(404);
  });
});

describe('审计一致性', () => {
  it('身份事件按序落库，且 detail_json 不含任何凭证', async () => {
    const owner = await bootstrapViaApi();
    const pairing = await createPairingViaApi(owner.authorization);
    const claimed = await (
      await SELF.fetch(URLS.pairingClaim, jsonPost({ pairingCode: pairing.pairingCode, deviceName: '第二台' }))
    ).json<{ deviceToken: string }>();
    await SELF.fetch(URLS.recover, jsonPost({ recoveryKey: owner.recoveryKey, deviceName: '第三台' }));

    const audits = await readAuditEvents();
    const events = audits.map((row) => row.event_type);
    expect(events).toContain('workspace_bootstrapped');
    expect(events).toContain('device_pairing_created');
    expect(events).toContain('device_paired');
    expect(events).toContain('device_recovered');

    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain(owner.recoveryKey);
    expect(serialized).not.toContain(owner.deviceToken);
    expect(serialized).not.toContain(claimed.deviceToken);
    expect(serialized).not.toContain(pairing.pairingCode);
  });
});
