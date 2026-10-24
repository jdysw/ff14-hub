/**
 * Replace complete <...> fragments with spaces without retrying unmatched '<'
 * prefixes. This produces plain text only; it is not an HTML sanitizer.
 */
export function stripHtmlTags(value: string): string {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf('<', cursor);
    if (open < 0) {
      break;
    }
    const close = value.indexOf('>', open + 1);
    if (close < 0) {
      break;
    }
    parts.push(value.slice(cursor, open), ' ');
    cursor = close + 1;
  }
  parts.push(value.slice(cursor));
  return parts.join('');
}
