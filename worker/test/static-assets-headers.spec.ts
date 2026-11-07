/**
 * PWA 静态资源响应头（HUB-012 / ADR-0004 D10）。
 *
 * 这些断言跑在真实 workerd 里，`ASSETS` 绑定指向已提交的 `apps/web/public`，
 * 因此断言的是**真实产物**：manifest 能被 JSON.parse、图标文件真的存在且是 PNG、
 * `/sw.js` 的 MIME 与缓存头真的符合要求。
 *
 * 关键边界（第 7 条验收）：
 * - `/sw.js` → `application/javascript; charset=utf-8` + `Cache-Control: no-store` + `Service-Worker-Allowed: /`
 * - `/manifest.webmanifest` → `application/manifest+json; charset=utf-8`
 * - `/icons/*` → `image/png` + 可长缓存
 * - 其它静态资源（例如 favicon.svg）**不被**误加 PWA 专用头。
 */
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { TEST_BASE_URL } from './helpers';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function pngMagicBytes(path: string): Promise<number[]> {
  const response = await SELF.fetch(`${TEST_BASE_URL}${path}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return Array.from(bytes.slice(0, PNG_MAGIC.length));
}

describe('PWA：Service Worker 响应头', () => {
  it('/sw.js 返回 JS MIME、no-store 与根作用域许可', async () => {
    const response = await SELF.fetch(`${TEST_BASE_URL}/sw.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/javascript; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Service-Worker-Allowed')).toBe('/');
    // 静态资源同样经过 Worker 的安全头（同域部署的关键约束）。
    expect(response.headers.get('Content-Security-Policy')).toContain("worker-src 'self'");
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

});

describe('PWA：manifest 响应头与内容', () => {

  it('manifest 声明的每个图标都真实存在、是 PNG，且含 192 / 512 / maskable', async () => {
    const response = await SELF.fetch(`${TEST_BASE_URL}/manifest.webmanifest`);
    const manifest = JSON.parse(await response.text()) as {
      icons: { src: string; sizes: string; type: string; purpose?: string }[];
    };
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
    expect(manifest.icons.some((icon) => icon.sizes === '192x192')).toBe(true);
    expect(manifest.icons.some((icon) => icon.sizes === '512x512')).toBe(true);
    expect(manifest.icons.some((icon) => icon.purpose === 'maskable' && icon.sizes === '512x512')).toBe(true);

    for (const icon of manifest.icons) {
      expect(icon.src.startsWith('/icons/'), icon.src).toBe(true);
      const iconResponse = await SELF.fetch(`${TEST_BASE_URL}${icon.src}`);
      expect(iconResponse.status, icon.src).toBe(200);
      expect(iconResponse.headers.get('Content-Type'), icon.src).toBe('image/png');
      expect(await pngMagicBytes(icon.src), icon.src).toEqual(PNG_MAGIC);
    }
  });
});
