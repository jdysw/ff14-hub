/**
 * 私有 /me/* 认证边界测试（HUB-004 验收 + HUB-006 实现后行为）。
 *
 * HUB-006 已实现 me/* 处理器：已认证路径返回真实数据（200），
 * 未认证路径仍统一 401。下面同时断言这两件事，以证明认证中间件既放行合法凭证、也挡住非法凭证。
 */
import { parseBearerToken, RECOVERY_KEY_PREFIX, TOKEN_BODY_LENGTH } from '@ff14-hub/shared';
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { readLastSeenAt, readTokenHash, seedDevice, seedWorkspace, seedWorkspaceWithDevice, TEST_BASE_URL } from './helpers';

const PROFILE_URL = `${TEST_BASE_URL}/api/v1/me/profile`;
const DEVICES_URL = `${TEST_BASE_URL}/api/v1/me/devices`;

async function readErrorBody(response: Response): Promise<{ code: string; message: string; requestId: string }> {
  return await response.json<{ code: string; message: string; requestId: string }>();
}

describe('私有 API 未授权一律 401', () => {
  it('缺少 Authorization 头 → 401 + WWW-Authenticate', async () => {
    const response = await SELF.fetch(PROFILE_URL);
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('Bearer');
    const body = await readErrorBody(response);
    expect(body.code).toBe('unauthorized');
    expect(Object.keys(body).sort()).toEqual(['code', 'message', 'requestId']);
  });

  it('方案或形状非法 → 401', async () => {
    const cases = [
      'Basic YWJjOmRlZg==',
      'Bearer',
      'Bearer short',
      `Bearer ffh_dev_${'!'.repeat(TOKEN_BODY_LENGTH)}`,
      // 恢复密钥形状不能当设备 Token 使用。
      `Bearer ${RECOVERY_KEY_PREFIX}${'A'.repeat(TOKEN_BODY_LENGTH)}`,
    ];
    for (const authorization of cases) {
      const response = await SELF.fetch(PROFILE_URL, { headers: { Authorization: authorization } });
      expect(response.status, `期望 401：${authorization}`).toBe(401);
    }
  });

  it('形状合法但未知的 Token → 401', async () => {
    const unknown = `${'ffh_dev_'}${'Z'.repeat(TOKEN_BODY_LENGTH)}`;
    expect(parseBearerToken(`Bearer ${unknown}`).ok).toBe(true);
    const response = await SELF.fetch(PROFILE_URL, { headers: { Authorization: `Bearer ${unknown}` } });
    expect(response.status).toBe(401);
  });

  it('已撤销设备的 Token → 立即 401', async () => {
    const { device } = await seedWorkspaceWithDevice({ revoked: true });
    const response = await SELF.fetch(PROFILE_URL, { headers: { Authorization: device.authorization } });
    expect(response.status).toBe(401);
  });

  it('未知 Token 与已撤销 Token 的响应完全一致，不提供枚举信号', async () => {
    const { device: revoked } = await seedWorkspaceWithDevice({ revoked: true });
    const unknown = `ffh_dev_${'Q'.repeat(TOKEN_BODY_LENGTH)}`;

    const unknownResponse = await SELF.fetch(PROFILE_URL, { headers: { Authorization: `Bearer ${unknown}` } });
    const revokedResponse = await SELF.fetch(PROFILE_URL, { headers: { Authorization: revoked.authorization } });

    expect(unknownResponse.status).toBe(revokedResponse.status);
    const a = await readErrorBody(unknownResponse);
    const b = await readErrorBody(revokedResponse);
    expect(a.code).toBe(b.code);
    expect(a.message).toBe(b.message);
  });

  it('设备列表与撤销端点同样受保护', async () => {
    expect((await SELF.fetch(DEVICES_URL)).status).toBe(401);
    expect((await SELF.fetch(`${DEVICES_URL}/some-id`, { method: 'DELETE' })).status).toBe(401);
  });

  it('越权探测不因路径参数或查询串而放行', async () => {
    const probes = [
      `${PROFILE_URL}?workspaceId=1`,
      `${PROFILE_URL}?workspace_id=1`,
      `${TEST_BASE_URL}/api/v1/me/devices/anything`,
    ];
    for (const url of probes) {
      const response = await SELF.fetch(url);
      expect(response.status, `期望 401：${url}`).toBe(401);
    }
  });
});

describe('已认证路径（HUB-006 已实现）', () => {
  it('有效设备 Token 通过认证并返回所属工作空间的非敏感配置', async () => {
    const { workspace, device } = await seedWorkspaceWithDevice();
    const response = await SELF.fetch(PROFILE_URL, { headers: { Authorization: device.authorization } });
    expect(response.status).toBe(200);
    const body = await response.json<{ id: string; region: string }>();
    // 作用域来自认证结果：返回的必须是本设备所属的工作空间。
    expect(body.id).toBe(workspace.workspaceId);
    expect(body.region).toBe('cn');
  });

  it('响应体既不包含明文 Token，也不包含其摘要', async () => {
    const { device } = await seedWorkspaceWithDevice();
    const response = await SELF.fetch(PROFILE_URL, { headers: { Authorization: device.authorization } });
    const text = await response.text();
    expect(text).not.toContain(device.token);
    expect(text).not.toContain(device.tokenHash);
    expect(text).not.toContain('token_hash');
    expect(text).not.toContain('recovery_hash');
  });

  it('认证成功会（节流地）更新 last_seen_at', async () => {
    const { device } = await seedWorkspaceWithDevice();
    expect(await readLastSeenAt(device.deviceId)).toBeNull();

    await SELF.fetch(PROFILE_URL, { headers: { Authorization: device.authorization } });
    const afterFirst = await readLastSeenAt(device.deviceId);
    expect(afterFirst).not.toBeNull();

    // 第二次请求落在节流窗口内，时间戳不应变化。
    await SELF.fetch(PROFILE_URL, { headers: { Authorization: device.authorization } });
    expect(await readLastSeenAt(device.deviceId)).toBe(afterFirst);
  });

  it('多设备各自独立：一台被撤销不影响另一台', async () => {
    const workspace = await seedWorkspace();
    const revoked = await seedDevice(workspace.workspaceId, { name: '设备一', revoked: true });
    const active = await seedDevice(workspace.workspaceId, { name: '设备二' });
    // 两台设备凭证完全独立。
    expect(revoked.token).not.toBe(active.token);
    expect(revoked.tokenHash).not.toBe(active.tokenHash);

    // 被撤销的设备被拒绝。
    expect((await SELF.fetch(PROFILE_URL, { headers: { Authorization: revoked.authorization } })).status).toBe(401);
    // 同一工作空间的另一台设备仍然通过认证。
    const response = await SELF.fetch(PROFILE_URL, { headers: { Authorization: active.authorization } });
    expect(response.status).toBe(200);
  });

  it('数据库只保存摘要：库中不存在明文 Token', async () => {
    const { device } = await seedWorkspaceWithDevice();
    const stored = await readTokenHash(device.deviceId);
    expect(stored).not.toBeNull();
    expect(stored).not.toBe(device.token);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
  });
});
