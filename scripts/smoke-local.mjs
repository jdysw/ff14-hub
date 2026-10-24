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
 *   3. GET /api/v1/me/profile 旧工作空间接口必须是 404
 *   4. GET /api/v1/nope      未知 API 路径必须是 JSON 404（不能是 HTML）
 * 任一项失败即以退出码 1 结束，不隐藏失败。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
/** 该脚本只能探测开发者明确启动的本地 Worker，禁止作为任意 URL 的请求代理。 */
export function smokeBaseUrl(value = 'http://127.0.0.1:8787') {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !/^\d{1,5}$/.test(url.port || '8787') || Number(url.port || 8787) > 65535) {
    throw new Error('冒烟测试仅允许本机 HTTP 地址，不接受路径、凭证或远程主机');
  }
  return url.origin;
}
let baseUrl = 'http://127.0.0.1:8787';

const results = [];
/** 日志只记录短、单行诊断值，避免上游响应注入额外日志行。 */
export const safeLogText = (value) => JSON.stringify(String(value)).slice(1, -1).slice(0, 180);

function record(name, ok, detail) {
  results.push({ name: safeLogText(name), ok, detail: safeLogText(detail ?? '') });
  // 仅输出固定标记与本地生成的编号：未经信任的响应、异常信息绝不流入终端日志。
  console.log(ok ? '[PASS] Local check' : '[FAIL] Local check', results.length);
}

async function get(path) {
  const response = await fetch(new URL(path, baseUrl), { redirect: 'manual', credentials: 'omit' });
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
    'GET /api/v1/me/profile 旧接口下线',
    response.status === 404 && body !== null && body.code === 'not_found' && typeof body.requestId === 'string',
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    baseUrl = smokeBaseUrl(process.argv[2]);
    console.log(`冒烟目标：${baseUrl}`);
    await checkStaticPage();
    await checkHealth();
    await checkUnauthorized();
    await checkNotFound();
  } catch (error) {
    record('冒烟执行', false, error instanceof Error ? error.message : String(error));
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\n共 ${results.length} 项，失败 ${failed.length} 项。`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}
