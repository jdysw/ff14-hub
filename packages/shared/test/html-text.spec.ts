import {describe, expect, it} from 'vitest';
import {stripHtmlTags} from '../src/html-text';
import {parseBookmarkHtml} from '../src/nav-api';

describe('plain HTML fragment text', () => {
  it('preserves incomplete tags and the original first-closing-bracket behavior', () => {
    const fragments = ['', 'plain', '<>', 'before<b>bold</b>after', '<a<b>c>', '<unclosed', 'a>b<c', '😀<b>鱼</b>'];
    for (const first of fragments) {
      for (const second of fragments) {
        const input = first + second;
        expect(stripHtmlTags(input)).toBe(input.replace(/<[^>]*>/g, ' '));
      }
    }
  });

  it('handles long unmatched tag prefixes without losing their text', () => {
    const input = '<'.repeat(120_000);
    expect(stripHtmlTags(input)).toBe(input);
    expect(stripHtmlTags(input + '>tail')).toBe(' tail');
  });

  it('keeps bookmark folder and title text semantics, including decoded markup', () => {
    const result = parseBookmarkHtml('<H3>攻略<b>分类</b></H3><A HREF="https://example.com/">鱼<b>王</b> &lt;保留&gt;</A>');
    expect(result.items[0]?.title).toBe('鱼 王 <保留>');
    expect(result.items[0]?.groupName).toBe('攻略 分类');
  });
});
