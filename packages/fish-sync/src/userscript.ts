/**
 * 受限油猴/userscript 适配器骨架（06B）——**刻意不可发布**。
 *
 * 为什么这一轮不接入真实站点：鱼糕站点的本机存储键名与读写 API **没有被审计过**。
 * 在不知道真实存储形状的前提下写「猜出来的键名」只会造成静默的数据破坏或读到错误数据，
 * 因此这里只定义**受限契约**：一旦没有「已审计的精确域名 + 已审计的存储端口」，
 * 适配器就是 disabled 的，任何读写都会抛错，而不是退回某个猜测实现。
 *
 * 硬性策略（每条都有单测）：
 * - `@match` 只允许**精确的 HTTPS 主机 + 路径**：不允许通配符、不允许 http、不允许本地回环/内网名。
 * - `@connect` 只允许**精确主机**且必须出现在已审计白名单里；`*` 一律拒绝。
 * - 一律禁止 `@require` / `@resource` 等远程脚本注入，也禁止 `eval` / `new Function` / `document.write`
 *   / `GM_xmlhttpRequest` / `fetch` / `XMLHttpRequest` 出现在适配器源码里。
 * - 元数据里出现 `Bearer`、`token=`、`password`、`secret` 之类内嵌凭证特征一律拒绝。
 * - 适配器**不通过 Hub**、也不带任何设备 Token：它只与已审计的站点存储端口打交道。
 *
 * 发布状态常量（`USCRIPT_REVIEW`）明确写着：域名白名单为空、存储端口未审计，
 * 因此当前**没有任何可发布配置**，也不存在「自动同步已上线」的说法。
 */
import { z } from 'zod';

/** 当前审计状态：域名白名单为空、站点存储 API 未审计 → 不可发布。 */
export const USCRIPT_REVIEW = {
  reviewedHosts: [] as readonly string[],
  storageAdapterAudited: false,
  note: '鱼糕站点存储 API 尚未审计，本轮不提供可发布的油猴脚本；不得用猜测的存储键名实现适配。',
} as const;

export interface UserscriptReview {
  /** 已逐条复核过的**精确** HTTPS 主机（例如 `dav.example.com`、`fish.example.com:8443`）。 */
  readonly reviewedHosts: readonly string[];
  /** 站点存储端口是否已经过源码审计（键名、读写语义、CAS 令牌）。 */
  readonly storageAdapterAudited: boolean;
}

export interface UserscriptMetadata {
  readonly name: string;
  readonly namespace: string;
  readonly version: string;
  readonly description: string;
  /** `@match`：精确 HTTPS URL 前缀，禁止通配符/HTTP/本地回环。 */
  readonly match: readonly string[];
  /** `@connect`：精确主机；必须都在 `reviewedHosts` 里。 */
  readonly connect: readonly string[];
  /** 只允许申请最少权限；`GM_xmlhttpRequest` / `unsafeWindow` 一律拒绝。 */
  readonly grant: readonly string[];
  readonly runAt: 'document-idle' | 'document-start';
}

export interface MetadataIssue {
  readonly field: string;
  readonly message: string;
}

export class UserscriptPolicyError extends Error {
  readonly issues: readonly MetadataIssue[];

  constructor(message: string,issues: readonly MetadataIssue[] = []) {
    super(message);
    this.name = 'UserscriptPolicyError';
    this.issues = issues;
  }
}

const LOOPBACK = new Set(['localhost','127.0.0.1','[::1]','0.0.0.0']);
const SECRET_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'Bearer 令牌',pattern: /Bearer\s+[A-Za-z0-9._-]{8,}/u },
  { label: 'token= 形式的凭证',pattern: /(?:^|[^\w])token\s*=/iu },
  { label: 'password/secret 字面量',pattern: /(?:password|passwd|secret|api[_-]?key)\s*[:=]/iu },
];
const FORBIDDEN_SOURCE: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'eval',pattern: /\beval\s*\(/u },
  { label: 'new Function',pattern: /new\s+Function\s*\(/u },
  { label: 'document.write',pattern: /document\s*\.\s*write\s*\(/u },
  { label: 'GM_xmlhttpRequest',pattern: /\bGM_xmlhttpRequest\b/u },
  { label: 'GM_download',pattern: /\bGM_download\b/u },
  { label: 'unsafeWindow',pattern: /\bunsafeWindow\b/u },
  { label: 'XMLHttpRequest',pattern: /\bXMLHttpRequest\b/u },
  { label: 'fetch',pattern: /(?:^|[^\w.])fetch\s*\(/u },
];

const ALLOWED_GRANTS = new Set(['none']);
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const singleLine = z.string().regex(/^[^\r\n\u2028\u2029]*$/u,'元数据必须为单行');
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$|^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

const metadataSchema = z
  .object({
    name: singleLine.trim().min(1).max(80),
    namespace: singleLine.trim().min(1).max(200),
    version: z.string().trim().regex(VERSION,'版本号必须形如 1.0.0'),
    description: singleLine.trim().min(1).max(500),
    match: z.array(singleLine.min(1).max(500)).min(1).max(10),
    connect: z.array(singleLine.min(1).max(300)).max(10),
    grant: z.array(singleLine.min(1).max(60)).max(5),
    runAt: z.enum(['document-idle','document-start']),
  })
  .strict();

function isLocalHostname(hostname: string): boolean {
  const bare = hostname.startsWith('[') ? hostname : hostname.toLowerCase();
  return LOOPBACK.has(bare) || bare.endsWith('.local') || bare.endsWith('.internal') || bare === '::1';
}

function validateMatchPattern(pattern: string,review: UserscriptReview,issues: MetadataIssue[]): void {
  if (pattern.includes('*')) {
    issues.push({ field: 'match',message: `不允许通配符匹配：${pattern}` });
    return;
  }
  let url: URL;
  try {
    url = new URL(pattern);
  } catch {
    issues.push({ field: 'match',message: `不是合法 URL：${pattern}` });
    return;
  }
  if (url.protocol !== 'https:') {
    issues.push({ field: 'match',message: `只允许 https：${pattern}` });
  }
  if(url.username || url.password || url.search || url.hash || !HOSTNAME.test(url.hostname) || !url.hostname.includes('.')) {
    issues.push({field:'match',message:'匹配地址必须为无凭证、查询或片段的公共域名HTTPS地址'});
  }
  if (isLocalHostname(url.hostname)) {
    issues.push({ field: 'match',message: `不允许本地回环/内网主机：${pattern}` });
  }
  if (!review.reviewedHosts.includes(url.host)) {
    issues.push({ field: 'match',message: `主机未在已审计白名单中：${url.host}` });
  }
}

function validateConnectHost(host: string,review: UserscriptReview,issues: MetadataIssue[]): void {
  if (host === '*' || host.includes('*')) {
    issues.push({ field: 'connect',message: '禁止 @connect 通配符' });
    return;
  }
  if (host.includes('/') || host.includes(':')) {
    // 允许 host:port，但必须与白名单条目完全一致。
    const [hostname,port] = host.split(':');
    if (port === undefined || !/^\d{1,5}$/u.test(port) || Number(port)<1 || Number(port)>65535 || host.split(':').length!==2 || hostname === undefined) {
      issues.push({ field: 'connect',message: `@connect 必须是精确主机（可选端口）：${host}` });
      return;
    }
  }
  const hostname = host.split(':')[0] ?? '';
  if (isLocalHostname(hostname)) {
    issues.push({ field: 'connect',message: `不允许本地回环/内网主机：${host}` });
  }
  if (!HOSTNAME.test(hostname)) {
    issues.push({ field: 'connect',message: `主机名不合法：${host}` });
  }
  if (!review.reviewedHosts.includes(host)) {
    issues.push({ field: 'connect',message: `主机未在已审计白名单中：${host}` });
  }
}

function scanSecretText(text: string,field: string,issues: MetadataIssue[]): void {
  for (const { label,pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      issues.push({ field,message: `疑似内嵌凭证（${label}）` });
    }
  }
}

/**
 * 校验元数据与（可选的）适配器源码。返回**全部**问题而不是第一个：
 * 审查者需要一次看到所有违规项。
 */
export function validateUserscriptMetadata(
  metadata: unknown,
  review: UserscriptReview,
  source = '',
): MetadataIssue[] {
  const issues: MetadataIssue[] = [];
  const parsed = metadataSchema.safeParse(metadata);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({ field: issue.path.join('.') || 'metadata',message: issue.message });
    }
    return issues;
  }
  const value = parsed.data;
  for (const pattern of value.match) {
    validateMatchPattern(pattern,review,issues);
  }
  for (const host of value.connect) {
    validateConnectHost(host,review,issues);
  }
  for (const grant of value.grant) {
    if (!ALLOWED_GRANTS.has(grant)) {
      issues.push({ field: 'grant',message: `只允许 grant none（当前为 ${grant}）` });
    }
  }
  if (!review.storageAdapterAudited) {
    issues.push({ field: 'storage',message: USCRIPT_REVIEW.note });
  }
  scanSecretText(`${value.name}\n${value.namespace}\n${value.description}`, 'metadata', issues);
  if (source !== '') {
    for (const { label,pattern } of FORBIDDEN_SOURCE) {
      if (pattern.test(source)) {
        issues.push({ field: 'source',message: `源码中出现被禁止的远程注入/网络 API：${label}` });
      }
    }
    scanSecretText(source,'source',issues);
  }
  return issues;
}

/** 断言可发布；不可发布时抛 `UserscriptPolicyError`（带全部问题）。 */
export function assertUserscriptReleasable(
  metadata: unknown,
  review: UserscriptReview,
  source = '',
): UserscriptMetadata {
  const issues = validateUserscriptMetadata(metadata,review,source);
  if (issues.length > 0) {
    throw new UserscriptPolicyError(
      `油猴脚本不满足发布策略（${String(issues.length)} 项）：${issues.map((issue) => `[${issue.field}] ${issue.message}`).join('；')}`,
      issues,
    );
  }
  return metadataSchema.parse(metadata);
}

/** 渲染元数据块。**必须**先通过校验；这里的输出可以直接交给审查者人工比对。 */
export function buildUserscriptHeader(metadata: unknown,review: UserscriptReview,source = ''): string {
  const value = assertUserscriptReleasable(metadata,review,source);
  const lines = [
    '// ==UserScript==',
    `// @name        ${value.name}`,
    `// @namespace   ${value.namespace}`,
    `// @version     ${value.version}`,
    `// @description ${value.description}`,
    `// @run-at      ${value.runAt}`,
    ...value.match.map((pattern) => `// @match       ${pattern}`),
    ...value.connect.map((host) => `// @connect     ${host}`),
    ...value.grant.map((grant) => `// @grant       ${grant}`),
    '// ==/UserScript==',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * 已审计的站点存储端口。**必须**由审计过真实站点源码的适配器实现，
 * 且 `write` 必须是 CAS（令牌不一致就失败），否则并发写入会互相覆盖。
 */
export interface FishcakeStoragePort {
  /** 读取站点本地存储里的原始鱼糕 JSON 文本。 */
  read(): Promise<string>;
  /** 本地存储的不透明版本令牌（CAS 前置条件）。 */
  token(): string;
  /** 仅在令牌仍匹配时写入；不匹配必须抛错而不是覆盖。 */
  write(text: string,expectedToken: string): Promise<void>;
}

export interface UserscriptAdapter {
  readonly releaseable: boolean;
  readonly disabledReason: string|null;
  readonly metadata: UserscriptMetadata|null;
  readLocal(): Promise<string>;
  localToken(): string;
  writeLocal(text: string,expectedToken: string): Promise<void>;
}

/**
 * 构造适配器。没有「已审计域名 + 已审计存储端口」时返回 **disabled** 适配器：
 * 所有方法抛 `UserscriptPolicyError`，绝不退化成猜测实现，也绝不发起网络请求。
 */
export function createUserscriptAdapter(input: {
  readonly metadata: unknown;
  readonly review: UserscriptReview;
  readonly source?: string;
  readonly storage?: FishcakeStoragePort;
}): UserscriptAdapter {
  const source = input.source ?? '';
  const issues = validateUserscriptMetadata(input.metadata,input.review,source);
  if (input.storage === undefined) {
    issues.push({ field: 'storage',message: '缺少已审计的站点存储端口（不得猜测存储键名/API）' });
  }
  const disabledReason =
    issues.length === 0 ? null : `适配器已禁用（${String(issues.length)} 项策略问题）：${issues.map((issue) => `[${issue.field}] ${issue.message}`).join('；')}`;
  if (disabledReason !== null || input.storage === undefined) {
    const disabled = (): never => {
      throw new UserscriptPolicyError(disabledReason ?? '适配器未启用',issues);
    };
    return {
      releaseable: false,
      disabledReason: disabledReason ?? '适配器未启用',
      metadata: null,
      readLocal: () => Promise.reject(new UserscriptPolicyError(disabledReason ?? '适配器未启用',issues)),
      localToken: disabled,
      writeLocal: () => Promise.reject(new UserscriptPolicyError(disabledReason ?? '适配器未启用',issues)),
    };
  }
  const metadata = metadataSchema.parse(input.metadata);
  const storage = input.storage;
  return {
    releaseable: true,
    disabledReason: null,
    metadata,
    readLocal: () => storage.read(),
    localToken: () => storage.token(),
    writeLocal: (text,expectedToken) => storage.write(text,expectedToken),
  };
}
