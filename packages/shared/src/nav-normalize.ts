/** 自由导航统一文本规范化口径，供契约、投影及目录升级判定共用。 */
/** 规范化文本：NFKC + 小写 + 折叠空白。搜索匹配的唯一口径。 */
export function normalizeNavText(raw: unknown): string {
  if (typeof raw !== 'string') {
    return '';
  }
  return raw.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

