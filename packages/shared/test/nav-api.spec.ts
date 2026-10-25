import {describe,expect,it} from 'vitest';
import {validateNavUrl,navUrlSchema} from '../src/nav-api';
type NavUrlFailReason='scheme'|'credentials'|'host'|'length';

describe('validateNavUrl / navUrlSchema：只放行 https', () => {
  it('合法 https 通过，并回传已 trim 的地址', () => {
    expect(validateNavUrl('https://example.com/x')).toEqual({ ok: true, url: 'https://example.com/x' });
    expect(validateNavUrl('  https://example.com/x  ')).toEqual({ ok: true, url: 'https://example.com/x' });
  });

  const rejected: readonly {
    readonly label: string;
    readonly raw: unknown;
    readonly reason: NavUrlFailReason;
  }[] = [
    { label: 'http 明确拒绝（本阶段不授予任何 http 例外）', raw: 'http://example.com', reason: 'scheme' },
    { label: 'javascript: 伪协议', raw: 'javascript:alert(1)', reason: 'scheme' },
    { label: 'data: 伪协议', raw: 'data:text/html,x', reason: 'scheme' },
    { label: 'file: 本地文件', raw: 'file:///c:/x', reason: 'scheme' },
    { label: 'blob: 协议', raw: 'blob:https://x/y', reason: 'scheme' },
    { label: '缺授权机构', raw: 'https://', reason: 'host' },
    { label: '主机没有点号', raw: 'https://nohost', reason: 'host' },
    { label: '内嵌凭证', raw: 'https://user:pass@example.com/', reason: 'credentials' },
    { label: '超过长度上限', raw: `https://example.com/${'a'.repeat(2048)}`, reason: 'length' },
    { label: '含空格', raw: 'https://exa mple.com', reason: 'length' },
    { label: '含控制字符（CRLF 注入形态）', raw: 'https://example.com/\nHost: evil', reason: 'length' },
    { label: '非字符串（数字）', raw: 42, reason: 'length' },
    { label: '非字符串（null）', raw: null, reason: 'length' },
    { label: '非字符串（undefined）', raw: undefined, reason: 'length' },
    { label: '非字符串（对象）', raw: { href: 'https://example.com/' }, reason: 'length' },
  ];

  for (const testCase of rejected) {
    it(`拒绝：${testCase.label} → ${testCase.reason}`, () => {
      expect(validateNavUrl(testCase.raw)).toEqual({ ok: false, reason: testCase.reason });
      if (typeof testCase.raw === 'string') {
        expect(navUrlSchema.safeParse(testCase.raw).success).toBe(false);
      }
    });
  }

  it('Schema 与函数是同一判定：http 拒绝、https 通过', () => {
    expect(navUrlSchema.safeParse('http://x.com').success).toBe(false);
    expect(navUrlSchema.safeParse('https://x.com').success).toBe(true);
  });
});
