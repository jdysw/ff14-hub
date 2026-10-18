import { describe,it,expect } from 'vitest';
import { createClientVault,normalizeProfile,vaultRecordSchema,type VaultProfile,type VaultStorage } from '../src/vault';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const otherWorkspaceId = '22222222-2222-4222-8222-222222222222';

function profile(overrides: Partial<VaultProfile> = {}): VaultProfile {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    workspaceId,
    hubOrigin: 'https://hub.test',
    davBaseUrl: 'https://dav.test/private/',
    region: 'cn',
    name: '主账号',
    ...overrides,
  };
}

type Failure = 'get'|'put'|'list'|'remove';

function fakeStorage() {
  const keys = new Map<string,CryptoKey>();
  const records = new Map<string,unknown>();
  let keyWrites = 0;
  let failure: Failure|null = null;
  let forcedKey: CryptoKey|null = null;
  const delay = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve,0);
    });
  };
  const storage: VaultStorage & {
    readonly records: Map<string,unknown>;
    readonly keys: Map<string,CryptoKey>;
    readonly keyWrites: number;
    failNext(operation: Failure): void;
    forceKey(key: CryptoKey|null): void;
  } = {
    records,
    keys,
    get keyWrites() {
      return keyWrites;
    },
    failNext(operation) {
      failure = operation;
    },
    forceKey(key) {
      forcedKey = key;
    },
    async ensureKey(candidate) {
      // 模拟 IndexedDB 的 readwrite 事务串行化：读-写之间不 await，因此并发下只有一个候选被写入。
      await delay();
      if (forcedKey !== null) {
        return forcedKey;
      }
      const existing = keys.get('master');
      if (existing !== undefined) {
        return existing;
      }
      keys.set('master',candidate);
      keyWrites += 1;
      return candidate;
    },
    async get(id) {
      await delay();
      if (failure === 'get') {
        failure = null;
        throw new Error('本机存储操作失败');
      }
      return records.get(id);
    },
    async put(id,record) {
      await delay();
      if (failure === 'put') {
        failure = null;
        throw new Error('本机存储操作失败');
      }
      records.set(id,record);
    },
    async remove(id) {
      await delay();
      if (failure === 'remove') {
        failure = null;
        throw new Error('本机存储操作失败');
      }
      records.delete(id);
    },
    async list() {
      await delay();
      if (failure === 'list') {
        failure = null;
        throw new Error('本机存储操作失败');
      }
      return [...records.values()];
    },
  };
  return storage;
}

describe('client vault', () => {
  it('stores DAV credentials encrypted under a non-extractable AES-GCM key', async () => {
    const storage = fakeStorage();
    const vault = createClientVault(storage);
    await vault.saveCredentials(profile(),{ username: 'dav-user',password: 'super-secret-password' });

    const stored = vaultRecordSchema.parse([...storage.records.values()][0]);
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain('super-secret-password');
    expect(serialized).not.toContain('dav-user');
    expect(stored.iv).toHaveLength(16);
    expect(stored.purpose).toBe('credentials');

    const key = storage.keys.get('master');
    expect(key).toBeDefined();
    expect(key?.extractable).toBe(false);
    expect(key?.algorithm.name).toBe('AES-GCM');
    expect([...(key?.usages ?? [])].sort()).toEqual(['decrypt','encrypt']);

    expect(await vault.readCredentials(profile())).toEqual({ username: 'dav-user',password: 'super-secret-password' });
    // 另一个档案（不同记录键）不存在 → null；不要与「同键不同作用域」混淆（那必须抛错）。
    expect(await vault.readCredentials(profile({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }))).toBeNull();
  });

  it('uses a fresh IV per write and never returns ciphertext as plaintext metadata', async () => {
    const storage = fakeStorage();
    const vault = createClientVault(storage);
    await vault.saveCredentials(profile(),{ username: 'u',password: 'p' });
    const first = vaultRecordSchema.parse(storage.records.get(`${profile().id}:credentials`));
    await new Promise<void>((resolve) => {
      setTimeout(resolve,5);
    });
    await vault.saveCredentials(profile(),{ username: 'u',password: 'p' });
    const second = vaultRecordSchema.parse(storage.records.get(`${profile().id}:credentials`));
    expect(second.iv).not.toBe(first.iv);
    expect(second.ciphertext).not.toBe(first.ciphertext);
  });

  it('rejects a record whose AAD scope was rewritten (region / DAV URL / workspace / purpose / header)', async () => {
    const storage = fakeStorage();
    const vault = createClientVault(storage);
    await vault.saveCredentials(profile(),{ username: 'u',password: 'p' });
    const key = `${profile().id}:credentials`;
    const original = vaultRecordSchema.parse(storage.records.get(key));

    // 同一档案 id、不同作用域：记录键相同，但 AAD 不匹配 → 必须拒绝。
    await expect(vault.readCredentials(profile({ region: 'global' }))).rejects.toThrow('无法解密');
    await expect(vault.readCredentials(profile({ davBaseUrl: 'https://other.test/dav/' }))).rejects.toThrow('无法解密');
    await expect(vault.readCredentials(profile({ workspaceId: otherWorkspaceId }))).rejects.toThrow('无法解密');
    await expect(vault.readCredentials(profile({ hubOrigin: 'https://other-hub.test' }))).rejects.toThrow('无法解密');
    await expect(vault.readCredentials(profile({ name: '另一个名字' }))).rejects.toThrow('无法解密');

    // 篡改记录头：时间戳、密文、IV 都必须导致拒绝。
    storage.records.set(key,{ ...original,createdAt: original.createdAt + 1 });
    await expect(vault.readCredentials(profile())).rejects.toThrow('无法解密');

    // 翻密文中部的一个 base64url 字符（GCM 会校验整段密文，必须拒绝）。
    const middle = Math.floor(original.ciphertext.length / 2);
    const middleChar = original.ciphertext[middle] ?? 'A';
    const flipped =
      original.ciphertext.slice(0,middle) + (middleChar === 'A' ? 'B' : 'A') + original.ciphertext.slice(middle + 1);
    storage.records.set(key,{ ...original,ciphertext: flipped });
    await expect(vault.readCredentials(profile())).rejects.toThrow('无法解密');

    storage.records.set(key,{ ...original,iv: 'AAAAAAAAAAAAAAAA' });
    await expect(vault.readCredentials(profile())).rejects.toThrow('无法解密');

    // 把凭证记录挪到检查点键下（伪造/换位写入）：用途不同 → AAD 不同 → 拒绝，
    // 不会静默把别的用途的数据当作检查点返回。
    storage.records.set(`${profile().id}:checkpoint`,original);
    await expect(vault.readRecord(profile(),'checkpoint')).rejects.toThrow('无法解密');
    expect(await vault.readRecord(profile(),'archive')).toBeNull();
  });

  it('initializes exactly one master key when two clients race for the first use', async () => {
    const storage = fakeStorage();
    const first = createClientVault(storage);
    const second = createClientVault(storage);

    const secondProfile = profile({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',name: '副账号' });
    await Promise.all([
      first.saveCredentials(profile(),{ username: 'first',password: 'p1' }),
      second.saveCredentials(secondProfile,{ username: 'second',password: 'p2' }),
      first.writeRecord(profile(),'checkpoint',{ step: 1 }),
      second.writeRecord(profile(),'archive',{ step: 2 }),
    ]);

    expect(storage.keyWrites).toBe(1);
    // 两个实例共享同一个密钥：各自都能读出对方写的记录。
    expect(await first.readCredentials(profile())).toEqual({ username: 'first',password: 'p1' });
    expect(await second.readCredentials(secondProfile)).toEqual({ username: 'second',password: 'p2' });
    expect(await second.readRecord(profile(),'checkpoint')).toEqual({ step: 1 });
    expect(await first.readRecord(profile(),'archive')).toEqual({ step: 2 });
  });

  it('surfaces storage failures instead of silently reporting "no record"', async () => {
    const storage = fakeStorage();
    const vault = createClientVault(storage);
    await vault.saveCredentials(profile(),{ username: 'u',password: 'p' });

    storage.failNext('get');
    await expect(vault.readCredentials(profile())).rejects.toThrow('本机存储操作失败');
    storage.failNext('put');
    await expect(vault.saveCredentials(profile(),{ username: 'u',password: 'p' })).rejects.toThrow('本机存储操作失败');
    storage.failNext('list');
    await expect(vault.listProfiles({ workspaceId,hubOrigin: 'https://hub.test' })).rejects.toThrow('本机存储操作失败');
    storage.failNext('remove');
    await expect(vault.removeProfile(profile())).rejects.toThrow('本机存储操作失败');
  });

  it('refuses to use a key that is extractable or has the wrong usages', async () => {
    const storage = fakeStorage();
    const extractable = await crypto.subtle.generateKey({ name: 'AES-GCM',length: 256 },true,['encrypt','decrypt']);
    storage.forceKey(extractable);
    const vault = createClientVault(storage);
    await expect(vault.saveCredentials(profile(),{ username: 'u',password: 'p' })).rejects.toThrow('本机保险箱密钥不可用');
    expect(storage.records.size).toBe(0);
  });

  it('rejects unsafe Hub/DAV URLs before writing anything', () => {
    const base = profile();
    const cases: Partial<VaultProfile>[] = [
      { hubOrigin: 'http://hub.test' },
      { hubOrigin: 'https://user:pass@hub.test' },
      { hubOrigin: 'https://hub.test/app' },
      { hubOrigin: 'https://hub.test/?q=1' },
      { davBaseUrl: 'http://dav.test/private/' },
      { davBaseUrl: 'https://user:pass@dav.test/private/' },
      { davBaseUrl: 'https://dav.test/private/?token=1' },
      { davBaseUrl: 'https://dav.test/private/#frag' },
      { davBaseUrl: 'https://hub.test/dav/' },
      { davBaseUrl: 'not-a-url' },
    ];
    for (const override of cases) {
      expect(() => normalizeProfile({ ...base,...override })).toThrow();
    }
    // 本地回环允许 HTTP Hub（本地开发），但 DAV 仍必须是 HTTPS 且不同源。
    expect(normalizeProfile({ ...base,hubOrigin: 'http://127.0.0.1:8788' }).hubOrigin).toBe('http://127.0.0.1:8788');
  });

  it('lists only credential profiles for the requested workspace/origin/region and skips corrupt records', async () => {
    const storage = fakeStorage();
    const vault = createClientVault(storage);
    const mine = profile();
    const otherRegion = profile({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',region: 'global',name: '国际服' });
    const otherWorkspace = profile({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',workspaceId: otherWorkspaceId });
    await vault.saveCredentials(mine,{ username: 'u',password: 'p' });
    await vault.saveCredentials(otherRegion,{ username: 'u',password: 'p' });
    await vault.saveCredentials(otherWorkspace,{ username: 'u',password: 'p' });
    await vault.writeRecord(mine,'checkpoint',{ step: 1 });
    storage.records.set('corrupt:id',{ nonsense: true });

    const all = await vault.listProfiles({ workspaceId,hubOrigin: 'https://hub.test' });
    expect(all.map((item) => item.id).sort()).toEqual([mine.id,otherRegion.id].sort());
    const cnOnly = await vault.listProfiles({ workspaceId,hubOrigin: 'https://hub.test',region: 'cn' });
    expect(cnOnly.map((item) => item.id)).toEqual([mine.id]);
    expect(await vault.listProfiles({ workspaceId,hubOrigin: 'https://other-hub.test' })).toEqual([]);
  });

  it('deletes credentials, checkpoint and archive together on removeProfile', async () => {
    const storage = fakeStorage();
    const vault = createClientVault(storage);
    await vault.saveCredentials(profile(),{ username: 'u',password: 'p' });
    await vault.writeRecord(profile(),'checkpoint',{ step: 1 });
    await vault.writeRecord(profile(),'archive',{ entries: [] });
    expect(storage.records.size).toBe(3);
    await vault.removeProfile(profile());
    expect(storage.records.size).toBe(0);
    expect(await vault.readCredentials(profile())).toBeNull();
  });

  it('rejects oversized or non-JSON payloads without writing a record', async () => {
    const storage = fakeStorage();
    const vault = createClientVault(storage);
    await expect(vault.writeRecord(profile(),'checkpoint',{ big: 'x'.repeat(4 * 1024 * 1024 + 16) })).rejects.toThrow();
    expect(storage.records.size).toBe(0);
  });

  it('rejects credential shapes that would break the Basic header', async () => {
    const storage = fakeStorage();
    const vault = createClientVault(storage);
    await expect(vault.saveCredentials(profile(),{ username: 'a:b',password: 'p' })).rejects.toThrow();
    expect(storage.records.size).toBe(0);
  });
});
