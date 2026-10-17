#!/usr/bin/env node
/**
 * 身份系统端到端冒烟（HUB-006），针对**已启动的本地** wrangler dev 运行。
 *
 * 用法：
 *   $env:FF14_E2E_BOOTSTRAP_SECRET = "<与 .dev.vars 中一致的值>"   # PowerShell
 *   node scripts/e2e-identity.mjs http://127.0.0.1:8787
 *
 * 设计边界：
 * - 只做**探测**，不负责启动服务（进程编排容易制造假失败）。
 * - 初始化密钥通过**环境变量**传入，不写进脚本、不写进仓库。
 * - 输出只包含判定结果；**绝不打印任何凭证**（设备 Token、恢复密钥、配对码、密钥本身）。
 * - 每一步失败都会以非零退出码结束，不隐藏失败。
 *
 * 覆盖的真实链路：
 *   1. 迁移后的本地 D1 可用（health）
 *   2. Bootstrap 成功并发放恢复密钥 + 首台设备凭证
 *   3. 重复 Bootstrap 被拒（单例）
 *   4. 首台设备可访问私有端点
 *   5. 未授权访问私有端点被拒（401）
 *   6. 配对：创建 → 领取 → 新设备可访问
 *   7. 同一配对码二次领取被拒（一次性）
 *   8. 撤销设备后其凭证立即失效（无进程内缓存）
 *   9. 恢复密钥可换发新设备
 *  10. 恢复密钥错误时被拒
 *  11. 初始化密钥错误时被拒
 *  12. 所有含凭证的响应都是 no-store
 */
const baseUrl = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const bootstrapSecret = process.env.FF14_E2E_BOOTSTRAP_SECRET;

if (bootstrapSecret === undefined || bootstrapSecret.length < 32) {
  console.error('[FAIL] 未提供 FF14_E2E_BOOTSTRAP_SECRET（至少 32 字符），无法执行身份 E2E。');
  process.exit(2);
}

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const URLS = {
  health: `${baseUrl}/api/v1/health`,
  bootstrap: `${baseUrl}/api/v1/identity/bootstrap`,
  pairing: `${baseUrl}/api/v1/identity/pairing`,
  pairingClaim: `${baseUrl}/api/v1/identity/pairing/claim`,
  recover: `${baseUrl}/api/v1/identity/recover`,
  profile: `${baseUrl}/api/v1/me/profile`,
  devices: `${baseUrl}/api/v1/me/devices`,
};

function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** 断言响应体里不出现任何我们持有的凭证——这是「不泄露秘密」的端到端检查。 */
const secretsInFlight = [];
function assertNoSecretLeak(label, text) {
  const leaked = secretsInFlight.filter((secret) => text.includes(secret));
  record(`${label}：响应不含任何凭证`, leaked.length === 0, leaked.length === 0 ? '' : '检测到疑似泄露');
}

async function main() {
  // 1. health（同时证明迁移后的 D1 可用）
  {
    const response = await fetch(URLS.health);
    const body = await response.json().catch(() => null);
    record(
      'GET /api/v1/health 且 D1 可用',
      response.status === 200 && body?.database === 'ok',
      `status=${response.status} database=${body?.database ?? 'n/a'}`,
    );
  }

  // 2. 未授权访问私有端点
  {
    const response = await fetch(URLS.profile);
    const body = await response.json().catch(() => null);
    record(
      '未授权访问 /me/profile 返回 401',
      response.status === 401 && body?.code === 'unauthorized',
      `status=${response.status}`,
    );
  }

  // 3. Bootstrap
  let owner;
  {
    const response = await postJson(URLS.bootstrap, { deviceName: 'E2E 设备一' }, { 'X-Bootstrap-Secret': bootstrapSecret });
    const body = await response.json().catch(() => null);
    const ok =
      response.status === 201 &&
      typeof body?.deviceToken === 'string' &&
      typeof body?.recoveryKey === 'string' &&
      response.headers.get('cache-control') === 'no-store';
    record('POST /identity/bootstrap 成功并发放凭证', ok, `status=${response.status}`);
    if (!ok) {
      return;
    }
    owner = { token: body.deviceToken, recoveryKey: body.recoveryKey, deviceId: body.device.id };
    secretsInFlight.push(owner.token, owner.recoveryKey);
  }

  // 4. 重复 Bootstrap（单例）
  {
    const response = await postJson(URLS.bootstrap, { deviceName: 'E2E 重复' }, { 'X-Bootstrap-Secret': bootstrapSecret });
    const body = await response.json().catch(() => null);
    record('重复 Bootstrap 返回 409（单例）', response.status === 409 && body?.code === 'conflict', `status=${response.status}`);
  }

  // 5. 初始化密钥错误
  {
    const response = await postJson(
      URLS.bootstrap,
      { deviceName: 'E2E 错误密钥' },
      { 'X-Bootstrap-Secret': 'wrong-secret-value-that-is-long-enough-0000' },
    );
    record('错误初始化密钥返回 401', response.status === 401, `status=${response.status}`);
  }

  // 6. 首台设备可用
  {
    const response = await fetch(URLS.profile, { headers: { Authorization: `Bearer ${owner.token}` } });
    const text = await response.text();
    record('首台设备可访问私有端点', response.status === 200 && response.headers.get('cache-control') === 'no-store', `status=${response.status}`);
    assertNoSecretLeak('/me/profile', text);
  }

  // 7. 配对：创建 → 领取
  let paired;
  {
    const created = await postJson(URLS.pairing, { ttlSeconds: 300 }, { Authorization: `Bearer ${owner.token}` });
    const createdBody = await created.json().catch(() => null);
    const createdOk = created.status === 201 && typeof createdBody?.pairingCode === 'string';
    record('创建配对凭证成功', createdOk, `status=${created.status}`);
    if (!createdOk) {
      return;
    }
    secretsInFlight.push(createdBody.pairingCode);

    const claim = await postJson(URLS.pairingClaim, { pairingCode: createdBody.pairingCode, deviceName: 'E2E 设备二' });
    const claimBody = await claim.json().catch(() => null);
    const claimOk = claim.status === 201 && typeof claimBody?.deviceToken === 'string';
    record('领取配对凭证成功', claimOk, `status=${claim.status}`);
    if (!claimOk) {
      return;
    }
    paired = { token: claimBody.deviceToken, deviceId: claimBody.device.id };
    secretsInFlight.push(paired.token);

    // 8. 一次性消费
    const replay = await postJson(URLS.pairingClaim, { pairingCode: createdBody.pairingCode, deviceName: 'E2E 重放' });
    record('同一配对码二次领取被拒（一次性）', replay.status === 401, `status=${replay.status}`);

    // 9. 新设备可用
    const profile = await fetch(URLS.profile, { headers: { Authorization: `Bearer ${paired.token}` } });
    record('配对所得设备可访问私有端点', profile.status === 200, `status=${profile.status}`);
  }

  // 10. 撤销立即生效
  {
    const revoke = await fetch(`${URLS.devices}/${paired.deviceId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    record('撤销设备返回 204', revoke.status === 204, `status=${revoke.status}`);

    const after = await fetch(URLS.profile, { headers: { Authorization: `Bearer ${paired.token}` } });
    record('撤销后立即 401（无进程内缓存）', after.status === 401, `status=${after.status}`);
  }

  // 11. 恢复
  let recovered;
  {
    const response = await postJson(URLS.recover, { recoveryKey: owner.recoveryKey, deviceName: 'E2E 恢复设备' });
    const body = await response.json().catch(() => null);
    const ok = response.status === 201 && typeof body?.deviceToken === 'string' && response.headers.get('cache-control') === 'no-store';
    record('用恢复密钥换发新设备凭证', ok, `status=${response.status}`);
    if (ok) {
      recovered = body.deviceToken;
      secretsInFlight.push(recovered);
      const profile = await fetch(URLS.profile, { headers: { Authorization: `Bearer ${recovered}` } });
      record('恢复所得设备可访问私有端点', profile.status === 200, `status=${profile.status}`);
    }
  }

  // 12. 错误恢复密钥
  {
    const response = await postJson(URLS.recover, { recoveryKey: `ffh_rec_${'Z'.repeat(43)}`, deviceName: 'E2E 错误' });
    record('错误恢复密钥返回 401', response.status === 401, `status=${response.status}`);
  }

  // 13. 设备列表不泄露摘要
  {
    const response = await fetch(URLS.devices, { headers: { Authorization: `Bearer ${owner.token}` } });
    const text = await response.text();
    record(
      '设备列表不含 token_hash / recovery_hash',
      response.status === 200 && !text.includes('token_hash') && !text.includes('recovery_hash'),
      `status=${response.status}`,
    );
    assertNoSecretLeak('/me/devices', text);
  }
}

try {
  await main();
} catch (error) {
  record('E2E 执行', false, error instanceof Error ? error.message : String(error));
}

const failed = results.filter((item) => !item.ok);
console.log(`\n共 ${results.length} 项，失败 ${failed.length} 项。`);
process.exit(failed.length === 0 ? 0 : 1);
