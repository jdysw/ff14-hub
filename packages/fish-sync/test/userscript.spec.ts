import { describe,it,expect,vi } from 'vitest';
import {
  USCRIPT_REVIEW,
  UserscriptPolicyError,
  buildUserscriptHeader,
  createUserscriptAdapter,
  validateUserscriptMetadata,
  type FishcakeStoragePort,
  type UserscriptMetadata,
  type UserscriptReview,
} from '../src/userscript';

const reviewed: UserscriptReview = { reviewedHosts: ['fish.example.com'],storageAdapterAudited: true };

function metadata(overrides: Partial<UserscriptMetadata> = {}): UserscriptMetadata {
  return {
    name: 'FF14 Hub 鱼糕本地适配器',
    namespace: 'https://hub.test/userscript',
    version: '0.2.0',
    description: '只在本机读取/写入鱼糕进度，供 FF14 Hub 显式同步使用。',
    match: ['https://fish.example.com/tool'],
    connect: [],
    grant: ['none'],
    runAt: 'document-idle',
    ...overrides,
  };
}

const messages = (issues: readonly { field: string; message: string }[]): string => issues.map((issue) => `${issue.field}:${issue.message}`).join('\n');

describe('restricted userscript adapter', () => {
  it('rejects metadata line injection and credential-bearing match URLs', () => {
    expect(()=>buildUserscriptHeader(metadata({name:'safe\n// @require https://evil.test/a.js'}),reviewed)).toThrow();
    for(const url of ['https://user:pass@fish.example.com/tool','https://fish.example.com/tool?token=x','https://fish.example.com/tool#secret']){
      expect(validateUserscriptMetadata(metadata({match:[url]}),reviewed).length).toBeGreaterThan(0);
    }
  });
  it('rejects wildcard, HTTP, loopback and unreviewed hosts in @match', () => {
    const fields = (patterns: readonly string[]): string[] =>
      validateUserscriptMetadata(metadata({ match: [...patterns] }),reviewed).map((issue) => issue.field);
    expect(fields(['https://*/*'])).toContain('match');
    expect(fields(['http://fish.example.com/tool'])).toContain('match');
    expect(fields(['https://localhost/tool'])).toContain('match');
    expect(fields(['https://127.0.0.1/tool'])).toContain('match');
    expect(fields(['https://evil.example.net/tool'])).toContain('match');
    expect(fields(['https://fish.example.com/tool'])).toEqual([]);
  });

  it('rejects @connect wildcards, loopback hosts and hosts outside the reviewed allowlist', () => {
    const issues = (connect: readonly string[]): string => messages(validateUserscriptMetadata(metadata({ connect: [...connect] }),reviewed));
    expect(issues(['*'])).toContain('禁止 @connect 通配符');
    expect(issues(['localhost'])).toContain('本地回环');
    expect(issues(['example.com'])).toContain('未在已审计白名单中');
    expect(issues(['fish.example.com'])).toBe('');
  });

  it('refuses privileged grants, remote @require-style injection and in-source network APIs', () => {
    expect(messages(validateUserscriptMetadata(metadata({ grant: ['GM_xmlhttpRequest'] }),reviewed))).toContain('只允许 grant none');
    const withSource = validateUserscriptMetadata(metadata(),reviewed,'const value = eval("1");');
    expect(messages(withSource)).toContain('eval');
    expect(messages(validateUserscriptMetadata(metadata(),reviewed,'GM_xmlhttpRequest({url:"https://x"})'))).toContain('GM_xmlhttpRequest');
    expect(messages(validateUserscriptMetadata(metadata(),reviewed,'document.write("<script src=\'https://x\'></script>")'))).toContain('document.write');
    expect(messages(validateUserscriptMetadata(metadata(),reviewed,'await fetch("https://fish.example.com/api")'))).toContain('fetch');
  });

  it('rejects embedded credentials in metadata or source', () => {
    expect(messages(validateUserscriptMetadata(metadata({ description: '使用 Bearer abcdefgh12345678 访问' }),reviewed))).toContain('Bearer');
    expect(messages(validateUserscriptMetadata(metadata({ description: 'token=abc123' }),reviewed))).toContain('token=');
    expect(messages(validateUserscriptMetadata(metadata(),reviewed,'const password = "dav-pass";'))).toContain('password');
  });

  it('is not releasable with the current repository review status', async () => {
    expect(USCRIPT_REVIEW.reviewedHosts).toHaveLength(0);
    expect(USCRIPT_REVIEW.storageAdapterAudited).toBe(false);
    expect(() => buildUserscriptHeader(metadata(),USCRIPT_REVIEW)).toThrow(UserscriptPolicyError);
    const adapter = createUserscriptAdapter({ metadata: metadata(),review: USCRIPT_REVIEW });
    expect(adapter.releaseable).toBe(false);
    expect(adapter.disabledReason).toContain('禁用');
    expect(adapter.metadata).toBeNull();
    expect(() => adapter.localToken()).toThrow(UserscriptPolicyError);
    await expect(adapter.readLocal()).rejects.toBeInstanceOf(UserscriptPolicyError);
    await expect(adapter.writeLocal('{}','token')).rejects.toBeInstanceOf(UserscriptPolicyError);
  });

  it('builds an exact, reviewed metadata header only when the review allows it', () => {
    const header = buildUserscriptHeader(metadata({ connect: ['fish.example.com'] }),reviewed,'const adapter = {};');
    expect(header).toContain('// ==UserScript==');
    expect(header).toContain('// @match       https://fish.example.com/tool');
    expect(header).toContain('// @connect     fish.example.com');
    expect(header).toContain('// @grant       none');
    expect(header).not.toContain('*');
    expect(header).not.toContain('http://');
    expect(header).not.toContain('localhost');
  });

  it('delegates to the audited storage port with CAS and never touches the network', async () => {
    const files = new Map<string,string>([['fish.json','{"completed":[]}']]);
    let revision = 1;
    const port: FishcakeStoragePort = {
      read: () => Promise.resolve(files.get('fish.json') ?? ''),
      token: () => `rev-${String(revision)}`,
      write: (text,expectedToken) => {
        if (expectedToken !== `rev-${String(revision)}`) {
          return Promise.reject(new Error('站点存储已被其他写入改变（CAS 失败）'));
        }
        files.set('fish.json',text);
        revision += 1;
        return Promise.resolve();
      },
    };
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch',fetchSpy);
    try {
      const adapter = createUserscriptAdapter({ metadata: metadata(),review: reviewed,source: 'const adapter = {};',storage: port });
      expect(adapter.releaseable).toBe(true);
      expect(adapter.disabledReason).toBeNull();
      expect(await adapter.readLocal()).toBe('{"completed":[]}');
      const token = adapter.localToken();
      await adapter.writeLocal('{"completed":[1]}',token);
      expect(files.get('fish.json')).toBe('{"completed":[1]}');
      await expect(adapter.writeLocal('{"completed":[]}',token)).rejects.toThrow('CAS 失败');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects a bad metadata shape instead of rendering a partial header', () => {
    expect(() => buildUserscriptHeader({ name: '' },reviewed)).toThrow(UserscriptPolicyError);
    expect(() => buildUserscriptHeader(metadata({ version: 'v1' }),reviewed)).toThrow(UserscriptPolicyError);
  });
});
