/**
 * 身份系统安全测试（HUB-006）：越权、作用域、恶意输入、秘密不泄露、写请求边界、
 * 以及本项目所依赖的 D1 事务语义。
 */
import { apiErrorBodySchema, TOKEN_BODY_LENGTH } from '@ff14-hub/shared';
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  TEST_BOOTSTRAP_SECRET,
  URLS,
  bootstrapHeaders,
  bootstrapViaApi,
  countRows,
  createPairingViaApi,
  jsonPost,
  resetIdentityState,
  seedDevice,
  seedWorkspace,
} from './helpers';

beforeEach(async () => {
  await resetIdentityState();
});

/** 断言错误响应是严格的 `{ code, message, requestId }` 结构。 */
async function expectErrorShape(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  const body = await response.json<Record<string, unknown>>();
  expect(apiErrorBodySchema.safeParse(body).success).toBe(true);
  expect(Object.keys(body).sort()).toEqual(['code', 'message', 'requestId']);
  expect(body['code']).toBe(code);
}

describe('工作空间作用域与越权', () => {
  /**
   * 构造越权场景：直接向数据库插入第二个工作空间及其设备。
   * 应用层没有创建第二个工作空间的路径（Bootstrap 受 guard 表限制），
   * 因此这里是「数据被篡改 / 历史遗留」的模拟，用来验证作用域过滤真的生效。
   */
  async function seedForeignWorkspace() {
    const foreign = await seedWorkspace('global');
    const foreignDevice = await seedDevice(foreign.workspaceId, { name: '外部设备' });
    return { foreign, foreignDevice };
  }

  it('用本工作空间凭证撤销他工作空间设备：返回 404 且目标设备不受影响', async () => {
    const mine = await bootstrapViaApi();
    const { foreignDevice } = await seedForeignWorkspace();

    const response = await SELF.fetch(`${URLS.devices}/${foreignDevice.deviceId}`, {
      method: 'DELETE',
      headers: { Authorization: mine.authorization },
    });
    // 404 而不是 403：不透露该设备存在于另一个工作空间。
    await expectErrorShape(response, 404, 'not_found');

    // 他工作空间设备仍然可以正常认证。
    const stillWorks = await SELF.fetch(URLS.profile, {
      headers: { Authorization: foreignDevice.authorization },
    });
    expect(stillWorks.status).toBe(200);
  });

  it('设备列表只包含本工作空间的设备', async () => {
    const mine = await bootstrapViaApi();
    const { foreignDevice } = await seedForeignWorkspace();

    const body = await (
      await SELF.fetch(URLS.devices, { headers: { Authorization: mine.authorization } })
    ).json<{ devices: { id: string }[] }>();
    const ids = body.devices.map((device) => device.id);
    expect(ids).toContain(mine.deviceId);
    expect(ids).not.toContain(foreignDevice.deviceId);
  });

  it('profile 返回的作用域恒等于认证设备所属工作空间，不接受客户端输入', async () => {
    const mine = await bootstrapViaApi();
    const { foreign } = await seedForeignWorkspace();

    const probes = [
      URLS.profile,
      `${URLS.profile}?workspaceId=${foreign.workspaceId}`,
      `${URLS.profile}?workspace_id=${foreign.workspaceId}`,
    ];
    for (const url of probes) {
      const response = await SELF.fetch(url, { headers: { Authorization: mine.authorization } });
      expect(response.status).toBe(200);
      const body = await response.json<{ id: string }>();
      expect(body.id, url).toBe(mine.workspaceId);
    }
  });

  it('他工作空间的设备无法读取本工作空间设备列表', async () => {
    await bootstrapViaApi();
    const { foreignDevice } = await seedForeignWorkspace();

    const body = await (
      await SELF.fetch(URLS.devices, { headers: { Authorization: foreignDevice.authorization } })
    ).json<{ devices: { id: string }[] }>();
    expect(body.devices.map((device) => device.id)).toEqual([foreignDevice.deviceId]);
  });
});

describe('恶意输入', () => {
  it('超长 deviceName 被拒为 422', async () => {
    const response = await SELF.fetch(
      URLS.bootstrap,
      jsonPost({ deviceName: 'x'.repeat(200) }, bootstrapHeaders()),
    );
    await expectErrorShape(response, 422, 'validation_failed');
  });

  it('额外字段被严格拒绝（不允许悄悄扩展契约）', async () => {
    const response = await SELF.fetch(
      URLS.bootstrap,
      jsonPost({ deviceName: 'ok', isAdmin: true }, bootstrapHeaders()),
    );
    await expectErrorShape(response, 422, 'validation_failed');
  });

  it('非法 region 被拒为 422', async () => {
    const response = await SELF.fetch(
      URLS.bootstrap,
      jsonPost({ deviceName: 'ok', region: 'eu' }, bootstrapHeaders()),
    );
    await expectErrorShape(response, 422, 'validation_failed');
  });

  it('形状非法的配对码被拒为 422（在触碰数据库之前）', async () => {
    for (const code of ['', 'short', 'javascript:alert(1)', `${'ffh_dev_'}${'A'.repeat(TOKEN_BODY_LENGTH)}`]) {
      const response = await SELF.fetch(URLS.pairingClaim, jsonPost({ pairingCode: code, deviceName: 'x' }));
      expect(response.status, code).toBe(422);
    }
  });

  it('非 JSON、超大请求体与非 JSON Content-Type 在身份端点上同样被拦截', async () => {
    const plain = await SELF.fetch(URLS.bootstrap, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', ...bootstrapHeaders() },
      body: JSON.stringify({ deviceName: 'x' }),
    });
    await expectErrorShape(plain, 415, 'unsupported_media_type');

    const crossOrigin = await SELF.fetch(URLS.bootstrap, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', ...bootstrapHeaders() },
      body: JSON.stringify({ deviceName: 'x' }),
    });
    await expectErrorShape(crossOrigin, 403, 'forbidden');

    const oversized = await SELF.fetch(URLS.bootstrap, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bootstrapHeaders() },
      body: JSON.stringify({ deviceName: 'x', padding: 'x'.repeat(70_000) }),
    });
    // 体积在解析前就被拒绝，因此这里可能是 413（体积）——关键是不能被当作合法请求处理。
    expect([413, 422]).toContain(oversized.status);
    expect(await countRows('workspaces')).toBe(0);
  });

  it('畸形 JSON 被拒为 400', async () => {
    const response = await SELF.fetch(URLS.bootstrap, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bootstrapHeaders() },
      body: '{ "deviceName": ',
    });
    await expectErrorShape(response, 400, 'bad_request');
  });

  it('畸形设备 id 路径参数不会导致 500', async () => {
    const mine = await bootstrapViaApi();
    const weirdIds = ['../../etc/passwd', '%00', 'a'.repeat(500), "'; DROP TABLE devices; --"];
    for (const id of weirdIds) {
      const response = await SELF.fetch(`${URLS.devices}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Authorization: mine.authorization },
      });
      expect(response.status, id).toBe(404);
    }
    // 表还在，数据没被破坏。
    expect(await countRows('devices')).toBeGreaterThan(0);
  });
});

describe('秘密不泄露', () => {
  it('所有身份响应（含失败）都不包含初始化密钥、明文凭证或摘要', async () => {
    const mine = await bootstrapViaApi();
    const pairing = await createPairingViaApi(mine.authorization);

    const responses: Response[] = [
      await SELF.fetch(URLS.bootstrap, jsonPost({ deviceName: 'x' }, bootstrapHeaders())),
      await SELF.fetch(URLS.pairing, jsonPost({}, { Authorization: mine.authorization })),
      await SELF.fetch(URLS.pairingClaim, jsonPost({ pairingCode: pairing.pairingCode, deviceName: '第二台' })),
      await SELF.fetch(URLS.recover, jsonPost({ recoveryKey: mine.recoveryKey, deviceName: '第三台' })),
      await SELF.fetch(URLS.devices, { headers: { Authorization: mine.authorization } }),
      await SELF.fetch(URLS.profile, { headers: { Authorization: mine.authorization } }),
      await SELF.fetch(URLS.recover, jsonPost({ recoveryKey: `ffh_rec_${'Y'.repeat(43)}`, deviceName: 'x' })),
    ];

    for (const response of responses) {
      const text = await response.text();
      expect(text).not.toContain(TEST_BOOTSTRAP_SECRET);
      expect(text).not.toContain(mine.recoveryKey);
      expect(text).not.toContain(mine.deviceToken);
      expect(text).not.toContain(pairing.pairingCode);
      expect(text).not.toContain('token_hash');
      expect(text).not.toContain('recovery_hash');
      expect(text).not.toContain('pairing_hash');
    }
  });

  it('所有身份与私有端点响应都禁止缓存', async () => {
    const mine = await bootstrapViaApi();
    const pairing = await createPairingViaApi(mine.authorization);

    const responses: Response[] = [
      await SELF.fetch(URLS.bootstrap, jsonPost({ deviceName: 'x' }, bootstrapHeaders())),
      await SELF.fetch(URLS.pairing, jsonPost({}, { Authorization: mine.authorization })),
      await SELF.fetch(URLS.pairingClaim, jsonPost({ pairingCode: pairing.pairingCode, deviceName: '第二台' })),
      await SELF.fetch(URLS.recover, jsonPost({ recoveryKey: mine.recoveryKey, deviceName: '第三台' })),
      await SELF.fetch(URLS.profile, { headers: { Authorization: mine.authorization } }),
      await SELF.fetch(URLS.devices, { headers: { Authorization: mine.authorization } }),
      // 失败路径同样不能缓存。
      await SELF.fetch(URLS.recover, jsonPost({ recoveryKey: `ffh_rec_${'Z'.repeat(43)}`, deviceName: 'x' })),
      await SELF.fetch(URLS.profile),
    ];
    for (const response of responses) {
      expect(response.headers.get('Cache-Control'), `status=${response.status}`).toBe('no-store');
    }
  });

  it('bootstrap 冲突（409）不透露已有工作空间的任何信息', async () => {
    const mine = await bootstrapViaApi();
    const response = await SELF.fetch(URLS.bootstrap, jsonPost({ deviceName: 'x' }, bootstrapHeaders()));
    const text = await response.text();
    expect(text).not.toContain(mine.workspaceId);
    expect(text).not.toContain(mine.deviceToken);
    expect(text).not.toContain(mine.recoveryKey);
  });
});

describe('D1 事务语义（本项目一致性保证的基础）', () => {
  it('batch 是 SQL 事务：中途失败会整体回滚，不留半写入状态', async () => {
    const workspaceId = 'ws-atomic-check';
    const good = env.DB.prepare(
      'INSERT INTO workspaces (id, region, timezone, locale, recovery_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(workspaceId, 'cn', 'Asia/Shanghai', 'zh-CN', 'atomic-hash', Date.now(), Date.now());
    // 故意引用不存在的工作空间 → 外键失败 → 整批回滚。
    const bad = env.DB.prepare(
      'INSERT INTO devices (id, workspace_id, token_hash, name, revoked_at, last_seen_at, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)',
    ).bind('dev-atomic-check', 'no-such-workspace', 'atomic-token', 'x', Date.now());

    await expect(env.DB.batch([good, bad])).rejects.toThrow();

    const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM workspaces WHERE id = ?')
      .bind(workspaceId)
      .first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it('唯一约束冲突可被识别为预期内的竞争，而不是被当成故障', async () => {
    await bootstrapViaApi();
    // 再插一条 guard 行必然冲突。
    await expect(
      env.DB.prepare('INSERT INTO workspace_bootstrap_guard (singleton_key, workspace_id, claimed_at) VALUES (?, ?, ?)')
        .bind('primary', 'another', Date.now())
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/i);
  });
});
