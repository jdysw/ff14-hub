/** PWA 主题与 HTML 入口必须保持同色，避免更新外观时漏改安装页面配色。 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('PWA 主题一致性', () => {
  it('HTML 主题色与实际 manifest 的背景色、主题色一致', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const manifest = JSON.parse(
      readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'),
    ) as { background_color: string; theme_color: string };
    const meta = /<meta\s+name="theme-color"\s+content="(#[0-9a-f]{6})"/i.exec(html);
    expect(meta, 'index.html 应定义标准格式的 theme-color').not.toBeNull();
    expect(manifest.theme_color).toBe(meta?.[1]);
    expect(manifest.background_color).toBe(meta?.[1]);
  });
});
