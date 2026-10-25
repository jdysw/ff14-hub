import {describe, expect, it} from 'vitest';
import {stripHtmlTags} from '../src/html-text';

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

});
