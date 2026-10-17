#!/usr/bin/env node
/**
 * 本地同域冒烟脚本。
 *
 * 用法：先启动 `pnpm run dev:api`（wrangler dev，默认 http://127.0.0.1:8787），
 * 然后执行 `pnpm run smoke:local` 或 `node scripts/smoke-local.mjs <baseUrl>`。
 *
 * 为什么不让脚本自己拉起 wrangler：进程编排容易在不同环境下产生假失败，
 * 也容易把「没起来」误判成「接口有问题」。这里只做**探测**，服务由调用方负责启动。
 *
 * 校验内容（对应本轮验收的「本地同域静态页与 /api/v1/health 冒烟」）：
 *   1. GET /                 同域静态页可访问，且带 CSP
 *   2. GET /api/v1/health    200 且 database=ok
 *   3. GET /api/v1/me/profile 未授权必须是 401
 *   4. GET /api/v1/nope      未知 API 路径必须是 JSON 404（不能是 HTML）
 * 任一项失败即以退出码 1 结束，不隐藏失败。
 */
const baseUrl = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
  const text = await response.text();
  return { response, text };
}

async function checkStaticPage() {
  const { response, text } = await get('/');
  const isHtml = (response.headers.get('content-type') ?? '').includes('text/html');
  const hasCsp = response.headers.get('content-security-policy') !== null;
  record(
    'GET / 静态页',
    response.status === 200 && isHtml && hasCsp && text.includes('<div id="root">'),
    `status=${response.status} html=${isHtml} csp=${hasCsp}`,
  );
}

async function checkHealth() {
  const { response, text } = await get('/api/v1/health');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  record(
    'GET /api/v1/health',
    response.status === 200 && body !== null && body.database === 'ok' && body.status === 'ok',
    `status=${response.status} database=${body?.database ?? 'n/a'}`,
  );
}

async function checkUnauthorized() {
  const { response, text } = await get('/api/v1/me/profile');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  record(
    'GET /api/v1/me/profile 未授权',
    response.status === 401 && body !== null && body.code === 'unauthorized' && typeof body.requestId === 'string',
    `status=${response.status} code=${body?.code ?? 'n/a'}`,
  );
}

async function checkNotFound() {
  const { response, text } = await get('/api/v1/definitely-not-a-route');
  const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  record(
    'GET /api/v1/<未知> 结构化 404',
    response.status === 404 && isJson && body !== null && body.code === 'not_found',
    `status=${response.status} json=${isJson}`,
  );
}

console.log(`冒烟目标：${baseUrl}`);

try {
  await checkStaticPage();
  await checkHealth();
  await checkUnauthorized();
  await checkNotFound();
} catch (error) {
  record('冒烟执行', false, error instanceof Error ? error.message : String(error));
}

const failed = results.filter((item) => !item.ok);
console.log(`\n共 ${results.length} 项，失败 ${failed.length} 项。`);
process.exit(failed.length === 0 ? 0 : 1);
