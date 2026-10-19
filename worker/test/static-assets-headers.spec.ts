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

  it('/sw.js 内容确实是脚本，且 install 阶段不自动 skipWaiting', async () => {
    const response = await SELF.fetch(`${TEST_BASE_URL}/sw.js`);
    const source = await response.text();
    expect(source).toContain("self.addEventListener('install'");
    expect(source).toContain("self.addEventListener('fetch'");
    // 私有路径必须在拒绝清单里（明文出现，说明规则被内联进来了）。
    expect(source).toContain('/api/v1/me/');

    // 自动激活（无提示重载）会让用户丢掉正在编辑的草稿：
    // install 处理器里**不得**出现 skipWaiting 调用（注释里说明「不做」不算调用，
    // 因此先把注释剥掉再断言）。
    const installStart = source.indexOf("self.addEventListener('install'");
    const activateStart = source.indexOf("self.addEventListener('activate'");
    expect(installStart).toBeGreaterThan(-1);
    expect(activateStart).toBeGreaterThan(installStart);
    const installCode = source
      .slice(installStart, activateStart)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(installCode).not.toContain('skipWaiting');

    const messageStart = source.indexOf("self.addEventListener('message'");
    expect(messageStart).toBeGreaterThan(-1);
    expect(source.slice(messageStart)).toContain('skipWaiting');
  });
});

describe('PWA：manifest 响应头与内容', () => {
  it('/manifest.webmanifest 返回 manifest MIME 且可被 JSON.parse', async () => {
    const response = await SELF.fetch(`${TEST_BASE_URL}/manifest.webmanifest`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/manifest+json; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    const manifest = JSON.parse(await response.text()) as Record<string, unknown>;
    expect(manifest['name']).toBe('FF14 Hub — 个人导航与模块化工作台');
    expect(manifest['short_name']).toBe('FF14 Hub');
    expect(manifest['start_url']).toBe('/');
    expect(manifest['display']).toBe('standalone');
    // 主题色由当前 UI 设计决定，不应把旧深色方案硬编码进 PWA 接口测试。
    // 验证颜色格式、背景/主题一致，并核对实际首页 HTML 的浏览器主题色配置。
    expect(manifest['background_color']).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest['theme_color']).toBe(manifest['background_color']);
    const htmlResponse = await SELF.fetch(`${TEST_BASE_URL}/`);
    expect(htmlResponse.status).toBe(200);
    const html = await htmlResponse.text();
    expect(html).toContain(`name="theme-color" content="${String(manifest['theme_color'])}"`);
    expect(manifest['lang']).toBe('zh-CN');
    expect(typeof manifest['description']).toBe('string');
    expect(String(manifest['description'])).not.toBe('');
  });

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

describe('PWA：图标响应头', () => {
  it.each(['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png'])(
    '%s 是 image/png 且可长缓存',
    async (path) => {
      const response = await SELF.fetch(`${TEST_BASE_URL}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('image/png');
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
      expect(await pngMagicBytes(path)).toEqual(PNG_MAGIC);
    },
  );
});

describe('PWA：不误伤其它静态资源', () => {
  it('favicon.svg 保留自己的 MIME，且不带 PWA 专用头', async () => {
    const response = await SELF.fetch(`${TEST_BASE_URL}/favicon.svg`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('image/svg+xml');
    expect(response.headers.get('Service-Worker-Allowed')).toBeNull();
    expect(response.headers.get('Content-Security-Policy')).not.toBeNull();
  });

  it('不存在的资源不会被伪装成脚本或图片（SPA 回退语义不变）', async () => {
    const missingScript = await SELF.fetch(`${TEST_BASE_URL}/sw-missing.js`);
    expect(missingScript.headers.get('Service-Worker-Allowed')).toBeNull();
    expect(missingScript.headers.get('Content-Type') ?? '').not.toContain('javascript');

    const missingIcon = await SELF.fetch(`${TEST_BASE_URL}/icons/missing.png`);
    expect(missingIcon.headers.get('Content-Type') ?? '').not.toBe('image/png');
    expect(missingIcon.headers.get('Cache-Control') ?? '').not.toContain('immutable');
  });
});
