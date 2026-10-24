/** 安全扫描 Netscape 书签：纯字符解析，不调用 DOMParser 或执行 HTML。 */
import {normalizeNavText} from './nav-normalize';
import type {NavImportItem,NavImportSkipReason,NavImportSkipped,NavParseResult,NavRegion,NavUrlValidation} from './nav-api';

export interface BookmarkParseDependencies {
  readonly MAX_NAV_GROUP_NAME_LENGTH:number;
  readonly MAX_NAV_TITLE_LENGTH:number;
  readonly MAX_NAV_URL_LENGTH:number;
  readonly MAX_NAV_IMPORT_ITEMS:number;
  readonly validateNavUrl:(raw:unknown)=>NavUrlValidation;
}

// ---------------------------------------------------------------------------
// 书签 HTML / JSON 导入（严格解析为数据，绝不执行外来 HTML）
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** 一次成功的实体扫描：`text` 是解码结果，`end` 指向结束分号之后。 */
interface DecodedEntity {
  readonly text: string;
  readonly end: number;
}

/** `\s` 的精确字符集（ECMA-262 的 WhiteSpace + LineTerminator）：手写扫描必须逐码元对齐它。 */
function isSpaceCode(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** ASCII 大小写不敏感比较：等价于原正则的 `i` 标志（此处只涉及 ASCII 字母）。 */
function matchesAsciiIgnoreCase(value: string, start: number, expected: string): boolean {
  for (let offset = 0; offset < expected.length; offset += 1) {
    const code = value.charCodeAt(start + offset);
    const folded = code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
    if (folded !== expected.charCodeAt(offset)) {
      return false;
    }
  }
  return true;
}

function isAsciiLetterCode(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isDigitCodeFor(code: number, radix: 10 | 16): boolean {
  if (code >= 0x30 && code <= 0x39) {
    return true;
  }
  return radix === 16 && ((code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66));
}

/**
 * 取 `#x<hex>` / `#<decimal>` 形态的码点。
 *
 * 原实现用 `Number.parseInt` + `Number.isFinite(code) && code > 0` 把关，这里逐条保留：
 * `&#0;` 与位数多到 parseInt 溢出成 `Infinity` 的写法都原样保留（返回 `null` ⇒ 调用方原样输出）。
 * 数字位数**不设上限**：`&#x0000000041;` 这类前导零写法在原实现里同样解码成 `A`，
 * 人为截断会造成行为差异；而扫描只向前推进、每个字符最多被读一次，天然是 O(n)。
 */
function decodeNumericEntityAt(value: string, digitStart: number, radix: 10 | 16): DecodedEntity | null {
  let end = digitStart;
  while (end < value.length && isDigitCodeFor(value.charCodeAt(end), radix)) {
    end += 1;
  }
  if (end === digitStart || value.charCodeAt(end) !== 0x3b /* ; */) {
    return null;
  }
  const code = Number.parseInt(value.slice(digitStart, end), radix);
  if (!Number.isFinite(code) || code <= 0) {
    return null;
  }
  return { text: String.fromCodePoint(Math.min(code, 0x10ffff)), end: end + 1 };
}

/** 取 `<alpha>` 形态的命名实体；查不到就返回 `null`（原样保留 `&…;`）。 */
function decodeNamedEntityAt(value: string, amp: number): DecodedEntity | null {
  let end = amp + 1;
  while (end < value.length && isAsciiLetterCode(value.charCodeAt(end))) {
    end += 1;
  }
  if (end === amp + 1 || value.charCodeAt(end) !== 0x3b /* ; */) {
    return null;
  }
  // 与原实现逐字相同的查表（名称大小写不敏感）。
  const text = NAMED_ENTITIES[value.slice(amp + 1, end).toLowerCase()];
  return text === undefined ? null : { text, end: end + 1 };
}

/**
 * 尝试解码 `value` 中位置 `amp`（必须是 `&`）处的一个实体；`null` 表示此处不构成实体。
 *
 * 等价性依据：原正则的每个分支都以 `;` 收尾，因此"能否匹配"只由**局部字符形态**决定；
 * 返回 `null` 时调用方只复制这个 `&` 并前进一个字符——正是原正则匹配失败时不吞字符的行为。
 *
 * 分支对应关系（原式 `/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g`）：
 * - `#x<hex>`：注意原正则**没有** `i` 标志，`&#X27;` 不落在这个分支
 *   （旧回调里 `body.startsWith('#X')` 那一段因此不可达），这里刻意保持同一判定；
 * - `#<decimal>`；
 * - `<alpha>`：不要求单词边界、不做长度截断（超长名字必然查表失败，结果与原样保留相同）。
 */
function decodeEntityAt(value: string, amp: number): DecodedEntity | null {
  if (value.charCodeAt(amp + 1) === 0x23 /* # */) {
    if (value.charCodeAt(amp + 2) === 0x78 /* x */) {
      return decodeNumericEntityAt(value, amp + 3, 16);
    }
    return decodeNumericEntityAt(value, amp + 2, 10);
  }
  return decodeNamedEntityAt(value, amp);
}

/**
 * 解码书签文件里的实体。
 *
 * 注意方向：这里把 `.html` 文件里的 `&amp;lt;` 还原成**数据**里的 `&lt;` 文本，
 * 绝不会把它塞回 DOM。解码结果只用于标题与分组名（纯文本）。
 *
 * ── 为什么用线性扫描而不是正则（SonarCloud S5852）─────────────────────────────
 * 原实现是 `/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g`：**多个分支各自带量词**，
 * 且分支前缀互相重叠（`#x…` / `#…` / 字母名）。这种"分支 + 量词"结构在匹配失败时
 * 会让引擎在每个 `&` 位置把全部分支重试一遍，是 S5852 判定的 ReDoS 形态
 * （对 `&aaaa…`、`&#xxxx…` 这类长串输入代价随长度增长）。
 * 下面的扫描只向前推进：失败时前进一个字符，成功时直接跳过整个 `&…;`，
 * 每个字符最多被读常数次，因此对任意输入都是 O(n)，行为与上面逐分支注释一一对应。
 */
function decodeHtmlEntities(value: string): string {
  let result = '';
  let cursor = 0;
  while (cursor < value.length) {
    const amp = value.indexOf('&', cursor);
    if (amp < 0) {
      return result + value.slice(cursor);
    }
    result += value.slice(cursor, amp);
    const entity = decodeEntityAt(value, amp);
    if (entity === null) {
      // 不构成实体：原样保留这个 `&`，只前进一个字符（不吞掉后面的文本）。
      result += '&';
      cursor = amp + 1;
      continue;
    }
    // 跳过整个 `&…;`，解码结果不会被二次解码（`&amp;lt;` → `&lt;`，与原实现一致）。
    result += entity.text;
    cursor = entity.end;
  }
  return result;
}

/**
 * 去掉所有标签，只留下文本（用于标题/分组名）。
 *
 * 这里的两个正则**刻意保留**：`<[^>]*>` 的字符类排除了 `>`（不可能与自身重叠）、
 * 没有分支嵌套，匹配与扫描都是线性的；`\s+` 只是单个量词、无嵌套量词、无分支。
 * 二者都不是 S5852 的形态，换成手写扫描只会引入无谓的等价性风险。
 */
function textOfFragment(fragment: string): string {
  return decodeHtmlEntities(fragment.replace(/<[^>]*>/g, ' ')).replace(/\s+/gu, ' ').trim();
}

/** 移除 script/style 内容：它们不是数据，也绝不参与解析（更不允许被执行）。 */
function stripNonDataBlocks(html: string): string {
  let result = html;
  for (const tag of ['script', 'style']) {
    let cursor = 0;
    for (;;) {
      const lower = result.toLowerCase();
      const open = lower.indexOf(`<${tag}`, cursor);
      if (open < 0) {
        break;
      }
      const close = lower.indexOf(`</${tag}>`, open);
      if (close < 0) {
        result = result.slice(0, open);
        break;
      }
      const end = close + tag.length + 3;
      result = `${result.slice(0, open)} ${result.slice(end)}`;
      cursor = open;
    }
  }
  return result;
}

/**
 * 按引号形态取一个属性值；`null` 表示"该起点不匹配"（调用方继续找下一个 `href`）。
 *
 * 对应原正则取值部分的三个分支：`"([^"]*)"` / `'([^']*)'` / `([^\s"'>]+)`。
 * 两个引号分支都要求**配对**：不配对时原正则的三个分支（字符类都排除引号）全不匹配，
 * 因此这里同样返回 `null` 而不是把剩余文本当成值。裸值分支要求至少一个字符（原 `+`）。
 */
function readHrefOperand(rawAttributes: string, start: number): string | null {
  const opener = rawAttributes.charCodeAt(start);
  if (opener === 0x22 /* " */ || opener === 0x27 /* ' */) {
    const closer = rawAttributes.indexOf(opener === 0x22 ? '"' : "'", start + 1);
    return closer < 0 ? null : rawAttributes.slice(start + 1, closer);
  }
  let end = start;
  while (end < rawAttributes.length) {
    const code = rawAttributes.charCodeAt(end);
    if (isSpaceCode(code) || code === 0x22 /* " */ || code === 0x27 /* ' */ || code === 0x3e /* > */) {
      break;
    }
    end += 1;
  }
  return end === start ? null : rawAttributes.slice(start, end);
}

/**
 * 在属性串里找 `href` 并取出它的原始值（尚未做实体解码）。
 *
 * ── 为什么用线性扫描而不是正则（SonarCloud S5852）─────────────────────────────
 * 原实现是 `/href\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/iu`：取值部分是**三个分支**，
 * 其中两个分支内部还带 `*` 量词——"分支内含量词"正是 S5852 的判定形态。
 * 这里把"找 `href` → 跳空白 → 必须 `=` → 跳空白 → 按形态取值"写成一次向前推进的扫描：
 * 每个起点只判定一次，失败就右移一个字符，因此是 O(n)。
 *
 * 与原正则逐条对齐的判定细节：
 * - 大小写不敏感（原 `i` 标志；只涉及 ASCII 字母，用 `matchesAsciiIgnoreCase` 对齐）；
 * - 空白集用 `isSpaceCode` 逐码元对齐 `\s`（含 NBSP、全角空格等）；
 * - `href` **不要求单词边界**：`data-href=`、`hhref=` 里的 `href` 同样命中（原正则如此）；
 * - 失败后起点**右移一个字符**而不是跳过 4 个：`hrefhref="x"` 仍能命中第二个（原正则的回溯顺序）。
 */
function readHrefValue(rawAttributes: string): string | null {
  const name = 'href';
  for (let start = 0; start < rawAttributes.length; start += 1) {
    if (!matchesAsciiIgnoreCase(rawAttributes, start, name)) {
      continue;
    }
    let cursor = start + name.length;
    while (cursor < rawAttributes.length && isSpaceCode(rawAttributes.charCodeAt(cursor))) {
      cursor += 1;
    }
    if (rawAttributes.charCodeAt(cursor) !== 0x3d /* = */) {
      continue;
    }
    cursor += 1;
    while (cursor < rawAttributes.length && isSpaceCode(rawAttributes.charCodeAt(cursor))) {
      cursor += 1;
    }
    const value = readHrefOperand(rawAttributes, cursor);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

/** 从 `<a ...>` 的原始属性串里取 href（支持双引号/单引号/裸值），并解码实体。 */
function extractHref(rawAttributes: string): string | null {
  const value = readHrefValue(rawAttributes);
  if (value === null) {
    return null;
  }
  // 真实书签里查询串普遍写成 `?a=1&amp;b=2`；不解码就会把字面 `&amp;` 写进个人链接。
  const decoded = decodeHtmlEntities(value).trim();
  return decoded.length === 0 ? null : decoded;
}

export function skipOf(
  reason: NavImportSkipReason,
  detail: string,
  title: string | null,
  url: string | null,
): NavImportSkipped {
  return { reason, detail, title, url };
}

/**
 * 解析浏览器导出的 Netscape 书签 HTML。
 *
 * 设计选择（复核要求：严格解析为数据、逐项说明跳过、不执行或直接插入外来 HTML）：
 * - **手写扫描器**，不用 `DOMParser`（Shared 层没有 DOM，Worker 里更没有）。
 * - 只把 `<a href>` 与 `<h3>`/`<dt>` 当数据读，其余标签一律忽略；script/style 整体丢弃。
 * - 每一项要么进 `items`，要么进 `skipped` 并带原因——不存在"静默丢弃"。
 */
export function parseBookmarkHtmlWithDependencies(
  html: unknown,
  options: { readonly defaultRegion?: NavRegion } | undefined,
  dependencies: BookmarkParseDependencies,
): NavParseResult {
  const {MAX_NAV_GROUP_NAME_LENGTH,MAX_NAV_TITLE_LENGTH,MAX_NAV_URL_LENGTH,MAX_NAV_IMPORT_ITEMS,validateNavUrl}=dependencies;
  const region = options?.defaultRegion ?? 'cn';
  const source = stripNonDataBlocks(typeof html === 'string' ? html.slice(0, 4 * 1024 * 1024) : '');
  const lower = source.toLowerCase();
  const items: NavImportItem[] = [];
  const skipped: NavImportSkipped[] = [];
  const seen = new Set<string>();

  let cursor = 0;
  let currentGroup: string | null = null;
  while (cursor < source.length) {
    const open = source.indexOf('<', cursor);
    if (open < 0) {
      break;
    }
    const close = source.indexOf('>', open);
    if (close < 0) {
      break;
    }
    const rawTag = source.slice(open + 1, close);
    cursor = close + 1;
    const tagName = (rawTag.trim().split(/[\s/]/, 1)[0] ?? '').toLowerCase();

    // 只有 `<h3>` 是「文件夹名」的载体：它在真实导出里成对出现。
    // `<dt>` 必须**单独当作无内容标签跳过**——真实浏览器导出的 `<DT>` 既不闭合、
    // 又包裹着 `<A>`，把它当成"分组名直到 </DT>"会把整份文件吃掉（复核发现的真实缺陷：
    // 之前对真实书签文件解析结果恒为空且静默丢弃）。
    if (tagName === 'h3') {
      const closeTag = '</h3>';
      const end = lower.indexOf(closeTag, cursor);
      const fragment = end < 0 ? '' : source.slice(cursor, end);
      cursor = end < 0 ? source.length : end + closeTag.length;
      const name = textOfFragment(fragment);
      if (name.length > 0) {
        currentGroup = name.slice(0, MAX_NAV_GROUP_NAME_LENGTH);
      }
      continue;
    }

    if (tagName !== 'a') {
      continue;
    }

    const end = lower.indexOf('</a>', cursor);
    const fragment = end < 0 ? '' : source.slice(cursor, end);
    cursor = end < 0 ? source.length : end + 4;

    const href = extractHref(rawTag);
    const title = textOfFragment(fragment).slice(0, MAX_NAV_TITLE_LENGTH);
    if (href === null) {
      skipped.push(skipOf('invalid_url', '链接没有可用的 href', title.length > 0 ? title : null, null));
      continue;
    }
    const validation = validateNavUrl(href);
    if (!validation.ok) {
      skipped.push(
        skipOf(
          validation.reason === 'scheme' ? 'unsupported_scheme' : 'invalid_url',
          validation.reason === 'scheme'
            ? '只允许 https:// 链接，已跳过非 https 地址'
            : 'URL 形态不可用（缺少主机、含凭证或超长）',
          title.length > 0 ? title : null,
          href.slice(0, MAX_NAV_URL_LENGTH),
        ),
      );
      continue;
    }
    if (title.length === 0) {
      skipped.push(skipOf('missing_title', '链接没有标题，无法作为导航条目', null, validation.url));
      continue;
    }
    const key = normalizeNavText(validation.url);
    if (seen.has(key)) {
      skipped.push(skipOf('duplicate', '同一 URL 已在本次导入中出现过', title, validation.url));
      continue;
    }
    if (items.length >= MAX_NAV_IMPORT_ITEMS) {
      skipped.push(skipOf('too_many_items', `单次导入上限为 ${String(MAX_NAV_IMPORT_ITEMS)} 条`, title, validation.url));
      continue;
    }
    seen.add(key);
    items.push({
      title,
      url: validation.url,
      region,
      ...(currentGroup === null ? {} : { groupName: currentGroup }),
    });
  }

  return { items, skipped };
}

