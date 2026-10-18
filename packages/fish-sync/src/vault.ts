/**
 * 浏览器专用本机保险箱（06B）——凭证与检查点的**唯一**落盘路径。
 *
 * 安全边界（每一条都有对应单测）：
 * - 只使用 WebCrypto AES-GCM-256；主密钥 `extractable:false`（不可导出），
 *   通过 IndexedDB 的**结构化克隆**持久化（`CryptoKey` 是少数可结构化克隆的类型之一）。
 *   应用不导出或保存裸密钥字节；底层浏览器如何保护其密钥存储由浏览器实现决定。
 * - AAD 绑定 `{版本, 档案(工作空间/区服/Hub源/DAV地址/名称), 用途}` **以及创建时间**：
 *   换工作空间、换区服、换 Hub 源、换 DAV 地址、换用途或改记录头都会解密失败（拒绝，不静默返回）。
 * - 记录键包含**本机档案 id**，所以同一工作空间下的多区服/多 DAV 账号互不覆盖；
 *   列表按「工作空间 + Hub 源 + 区服」过滤，不会把别的会话/工作空间的档案显示成本会话的。
 * - 本模块**不发起任何网络请求**：DAV 凭证与检查点只留在本机，Hub 设备 Token 从不进入本模块，
 *   也不写日志、不进 props。控制台输出被刻意保持为零。
 * - 只存 4MiB 以内的数据文档（`crypto.getRandomValues` 生成 12 字节随机 IV，每次写入都换）。
 *
 * 明确不是这一层提供的：跨标签页的写互斥（见 coordinator 的锁抽象与文档中的限制说明）。
 */
import { z } from 'zod';
import { parseBoundedJson,type Json } from './index';

/** 记录用途。三者都以同一把主密钥加密，但 AAD 不同，因此不能互相顶替。 */
export const VAULT_PURPOSES = ['credentials','checkpoint','archive'] as const;
export type VaultPurpose = (typeof VAULT_PURPOSES)[number];

const regionSchema = z.enum(['cn','global']);
export type VaultRegion = z.infer<typeof regionSchema>;

const profileShape = z
  .object({
    /** 本机档案 id（本机生成，用于记录键；不是服务端身份）。 */
    id: z.uuid(),
    /** 受信会话档案 id：必须来自 `GET /api/v1/me/profile`，绝不接受组件/URL 传入。 */
    workspaceId: z.uuid(),
    hubOrigin: z.string().max(2048),
    davBaseUrl: z.string().max(2048),
    region: regionSchema,
    name: z.string().trim().min(1).max(80),
  })
  .strict();
export type VaultProfile = z.infer<typeof profileShape>;
export const vaultProfileSchema = profileShape;

/** DAV 凭证形状。`username` 不允许包含冒号（否则 Basic 头会有歧义）。 */
const credentialsSchema = z
  .object({
    username: z.string().max(500).refine((value) => !value.includes(':'),'用户名不能包含冒号'),
    password: z.string().max(2000),
  })
  .strict();
export type DavCredentials = z.infer<typeof credentialsSchema>;
export const davCredentialsSchema = credentialsSchema;

const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const VAULT_RECORD_VERSION = 1;
export const VAULT_MAX_RECORD_BYTES = 4 * 1024 * 1024;
export const VAULT_MAX_RECORDS = 30;

export const vaultRecordSchema = z
  .object({
    v: z.literal(VAULT_RECORD_VERSION),
    profile: profileShape,
    purpose: z.enum(VAULT_PURPOSES),
    createdAt: z.number().int().nonnegative(),
    iv: base64Url.length(16),
    ciphertext: base64Url.max(6_000_000),
  })
  .strict();
export type VaultRecord = z.infer<typeof vaultRecordSchema>;

/**
 * 存储端口。`ensureKey` 必须**原子地**「返回已有主密钥，否则写入候选密钥」：
 * IndexedDB 的 readwrite 事务在同一 object store 上串行化，因此两个标签页并发初始化
 * 只会有一个候选密钥被写入，另一方读到同一个密钥。实现不得覆盖已存在的密钥。
 */
export interface VaultStorage {
  ensureKey(candidate: CryptoKey): Promise<CryptoKey>;
  get(id: string): Promise<unknown>;
  put(id: string, record: VaultRecord): Promise<void>;
  remove(id: string): Promise<void>;
  list(): Promise<unknown[]>;
}

const VAULT_ERRORS = {
  unavailable: '本机存储不可用',
  blocked: '本机存储升级被其他页面阻止',
  operationFailed: '本机存储操作失败',
  aborted: '本机存储操作已回滚',
  tooManyRecords: `本机记录数量已达上限（${String(VAULT_MAX_RECORDS)}）`,
  keyInvalid: '本机保险箱密钥不合法',
  keyUnavailable: '本机保险箱密钥不可用',
  undecryptable: '本机记录无法解密；配置、密钥或记录已变化',
} as const;

function toError(cause: unknown,fallback: string): Error {
  return cause instanceof Error ? cause : new Error(fallback);
}

/**
 * 校验并规范化档案地址：Hub 必须是 HTTPS 源（仅本地回环允许 HTTP），
 * WebDAV 必须是**另一个源**的 HTTPS 地址，且都不允许内嵌凭证/查询/片段。
 */
export function normalizeProfile(raw: unknown): VaultProfile {
  const profile = profileShape.parse(raw);
  const hub = new URL(profile.hubOrigin);
  const dav = new URL(profile.davBaseUrl);
  const loopback = hub.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(hub.hostname);
  if (
    (hub.protocol !== 'https:' && !loopback) ||
    hub.username !== '' ||
    hub.password !== '' ||
    hub.pathname !== '/' ||
    hub.search !== '' ||
    hub.hash !== ''
  ) {
    throw new Error('Hub须为HTTPS源（本地回环除外），且不能带路径、查询或凭证');
  }
  if (dav.protocol !== 'https:' || dav.username !== '' || dav.password !== '' || dav.search !== '' || dav.hash !== '') {
    throw new Error('WebDAV须为独立HTTPS地址，不能内嵌凭证、查询或片段');
  }
  if (hub.origin === dav.origin) {
    throw new Error('WebDAV不能与Hub同源；本机客户端不会把DAV配置发给后端');
  }
  if (!dav.pathname.endsWith('/')) {
    dav.pathname += '/';
  }
  return { ...profile,hubOrigin: hub.origin,davBaseUrl: dav.href };
}

/** 记录键：本机档案 id + 用途。同一工作空间的不同区服/账号因此互不覆盖。 */
export function vaultRecordKey(profile: VaultProfile,purpose: VaultPurpose): string {
  return `${profile.id}:${purpose}`;
}

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');

const fromBase64url = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text.replaceAll('-','+').replaceAll('_','/')),(char) => char.charCodeAt(0));

/**
 * 大对象不能用 `String.fromCharCode(...bytes)` 编码：参数会溢出调用栈。
 * 这里按 32KiB 分块拼接，密文（最多约 5.6MB）也能安全编码。
 */
function encodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
    binary += String.fromCharCode(...bytes.subarray(offset,offset + 32 * 1024));
  }
  return btoa(binary).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}

/** AAD：把档案作用域、用途与记录头固定进密文，任何一处被改写都会解密失败。 */
function additionalData(header: Pick<VaultRecord,'v'|'profile'|'purpose'|'createdAt'>): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify({
      v: header.v,
      profile: normalizeProfile(header.profile),
      purpose: header.purpose,
      createdAt: header.createdAt,
    }),
  );
}

function assertVaultKey(result: CryptoKey): CryptoKey {
  if (
    result.type !== 'secret' ||
    result.extractable ||
    result.algorithm.name !== 'AES-GCM' ||
    !result.usages.includes('encrypt') ||
    !result.usages.includes('decrypt')
  ) {
    throw new Error(VAULT_ERRORS.keyInvalid);
  }
  return result;
}

export interface ClientVault {
  /** 写入一条加密记录（覆盖同档案同用途的记录）。 */
  writeRecord(profile: VaultProfile,purpose: VaultPurpose,value: Json): Promise<void>;
  /** 读取一条加密记录；不存在返回 null。解密/作用域校验失败一律抛错，不返回 null。 */
  readRecord(profile: VaultProfile,purpose: VaultPurpose): Promise<Json|null>;
  /** 删除一条记录（不存在也视为成功）。 */
  deleteRecord(profile: VaultProfile,purpose: VaultPurpose): Promise<void>;
  saveCredentials(profile: VaultProfile,credentials: DavCredentials): Promise<void>;
  readCredentials(profile: VaultProfile): Promise<DavCredentials|null>;
  /** 列出本机保存的档案（只含凭证记录），按工作空间 + Hub 源（+ 可选区服）过滤。 */
  listProfiles(scope: { workspaceId: string; hubOrigin: string; region?: VaultRegion }): Promise<VaultProfile[]>;
  /** 彻底删除该档案的三条记录（凭证 / 检查点 / 归档）。 */
  removeProfile(profile: VaultProfile): Promise<void>;
}

/**
 * 构造本机保险箱。密钥初始化是**单飞**（single-flight）的：同一个实例上的并发调用共享同一次
 * `generateKey` + `ensureKey`；跨标签页则由存储端口的事务串行化保证只有一个候选被写入。
 */
export function createClientVault(storage: VaultStorage): ClientVault {
  let master: Promise<CryptoKey>|null = null;

  const key = (): Promise<CryptoKey> => {
    if (master === null) {
      const pending = crypto.subtle
        .generateKey({ name: 'AES-GCM',length: 256 },false,['encrypt','decrypt'])
        .then((candidate) => storage.ensureKey(candidate))
        .then(assertVaultKey);
      master = pending;
      // 失败不缓存：下一次调用重新尝试，而不是把「永久失败」粘在实例上。
      pending.catch(() => {
        if (master === pending) {
          master = null;
        }
      });
    }
    return master.catch(() => {
      throw new Error(VAULT_ERRORS.keyUnavailable);
    });
  };

  const writeRecord = async (raw: VaultProfile,purpose: VaultPurpose,value: Json): Promise<void> => {
    const profile = normalizeProfile(raw);
    const text = JSON.stringify(value);
    if (typeof text !== 'string') {
      throw new Error('记录内容无法序列化');
    }
    // 先在明文侧做有界校验，再加密：超限的记录不会浪费一次密钥运算或一次写入。
    parseBoundedJson(text,VAULT_MAX_RECORD_BYTES);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const header = { v: VAULT_RECORD_VERSION as 1,profile,purpose,createdAt: Date.now() };
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM',iv,additionalData: additionalData(header) },
      await key(),
      new TextEncoder().encode(text),
    );
    const record = vaultRecordSchema.parse({
      ...header,
      iv: base64url(iv),
      ciphertext: encodeBytes(new Uint8Array(encrypted)),
    });
    await storage.put(vaultRecordKey(profile,purpose),record);
  };

  const readRecord = async (raw: VaultProfile,purpose: VaultPurpose): Promise<Json|null> => {
    const profile = normalizeProfile(raw);
    // 读取失败（存储不可用）与解密失败（篡改/换作用域）必须区分：前者原样抛出。
    const stored = await storage.get(vaultRecordKey(profile,purpose));
    if (stored === undefined || stored === null) {
      return null;
    }
    let record: VaultRecord;
    try {
      // 先按 Schema 校验，再校验作用域，最后才解密：任何一步失败都当作不可信记录。
      record = vaultRecordSchema.parse(stored);
      if (
        record.purpose !== purpose ||
        JSON.stringify(normalizeProfile(record.profile)) !== JSON.stringify(profile)
      ) {
        throw new Error('作用域不匹配');
      }
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM',iv: fromBase64url(record.iv),additionalData: additionalData(record) },
        await key(),
        fromBase64url(record.ciphertext),
      );
      // JSON.parse 的产物必然是 JSON 数据（接口类型 Json）；已由 parseBoundedJson 做大小/深度界限校验。
      return parseBoundedJson(new TextDecoder('utf-8',{ fatal: true }).decode(plain),VAULT_MAX_RECORD_BYTES) as Json;
    } catch {
      throw new Error(VAULT_ERRORS.undecryptable);
    }
  };

  return {
    writeRecord,
    readRecord,
    deleteRecord: async (profile,purpose) => {
      await storage.remove(vaultRecordKey(normalizeProfile(profile),purpose));
    },
    saveCredentials: async (profile,credentials) => {
      await writeRecord(profile,'credentials',credentialsSchema.parse(credentials));
    },
    readCredentials: async (profile) => {
      const value = await readRecord(profile,'credentials');
      return value === null ? null : credentialsSchema.parse(value);
    },
    listProfiles: async (scope) => {
      const workspaceId = z.uuid().parse(scope.workspaceId);
      const hubOrigin = new URL(scope.hubOrigin).origin;
      const region = scope.region === undefined ? null : regionSchema.parse(scope.region);
      const profiles = new Map<string,VaultProfile>();
      for (const raw of await storage.list()) {
        // 损坏或来自其他用途/其他工作空间的记录只是「不匹配」，不能让整张列表读取失败。
        const parsed = vaultRecordSchema.safeParse(raw);
        if (!parsed.success || parsed.data.purpose !== 'credentials') {
          continue;
        }
        let profile: VaultProfile;
        try {
          profile = normalizeProfile(parsed.data.profile);
        } catch {
          continue;
        }
        if (profile.workspaceId !== workspaceId || profile.hubOrigin !== hubOrigin) {
          continue;
        }
        if (region !== null && profile.region !== region) {
          continue;
        }
        profiles.set(profile.id,profile);
      }
      return [...profiles.values()].sort((left,right) => left.name.localeCompare(right.name));
    },
    removeProfile: async (profile) => {
      const normalized = normalizeProfile(profile);
      for (const purpose of VAULT_PURPOSES) {
        await storage.remove(vaultRecordKey(normalized,purpose));
      }
    },
  };
}

/**
 * IndexedDB 实现。
 *
 * 两个 object store：`keys`（主密钥，结构化克隆）与 `records`（加密记录）。
 * 所有写操作都在事务里完成，且事务**在完成时**才 resolve；失败/回滚一律 reject，
 * 绝不吞掉错误（静默失败会让用户以为凭证已经保存）。
 */
export function createIndexedDbVaultStorage(name = 'ff14-hub-client-vault'): VaultStorage {
  let database: Promise<IDBDatabase>|null = null;

  const open = (): Promise<IDBDatabase> =>
    new Promise<IDBDatabase>((resolve,reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(name,1);
      } catch (cause) {
        reject(toError(cause,VAULT_ERRORS.unavailable));
        return;
      }
      request.onupgradeneeded = () => {
        const value = request.result;
        if (!value.objectStoreNames.contains('keys')) {
          value.createObjectStore('keys');
        }
        if (!value.objectStoreNames.contains('records')) {
          value.createObjectStore('records');
        }
      };
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(toError(request.error,VAULT_ERRORS.unavailable));
      };
      request.onblocked = () => {
        reject(new Error(VAULT_ERRORS.blocked));
      };
    });

  const db = (): Promise<IDBDatabase> => {
    if (database === null) {
      const pending = open();
      database = pending;
      pending.catch(() => {
        if (database === pending) {
          database = null;
        }
      });
    }
    return database;
  };

  const transaction = async <T>(
    storeName: string,
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore,set: (value: T) => void,fail: (error: Error) => void) => void,
  ): Promise<T> => {
    const value = await db();
    return new Promise<T>((resolve,reject) => {
      let tx: IDBTransaction;
      try {
        tx = value.transaction(storeName,mode);
      } catch (cause) {
        reject(toError(cause,VAULT_ERRORS.operationFailed));
        return;
      }
      let settled = false;
      let result: T|undefined;
      let failure: Error|null = null;
      const fail = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };
      const abort = (error: Error): void => {
        failure = error;
        try {
          tx.abort();
        } catch {
          // 事务已结束：忽略，仍以 failure 为准。
        }
        fail(error);
      };
      tx.oncomplete = () => {
        if (settled) {
          return;
        }
        if (failure !== null) {
          fail(failure);
          return;
        }
        settled = true;
        resolve(result as T);
      };
      tx.onerror = () => {
        fail(failure ?? toError(tx.error,VAULT_ERRORS.operationFailed));
      };
      tx.onabort = () => {
        fail(failure ?? toError(tx.error,VAULT_ERRORS.aborted));
      };
      try {
        action(
          tx.objectStore(storeName),
          (next) => {
            result = next;
          },
          abort,
        );
      } catch (cause) {
        abort(toError(cause,VAULT_ERRORS.operationFailed));
      }
    });
  };

  return {
    ensureKey: (candidate) =>
      transaction<CryptoKey>('keys','readwrite',(store,set,fail) => {
        const existing = store.get('master');
        existing.onsuccess = () => {
          if (existing.result !== undefined) {
            set(existing.result as CryptoKey);
            return;
          }
          // 只在「本次事务确认没有密钥」时 add：绝不用 put 覆盖已有主密钥。
          const added = store.add(candidate,'master');
          added.onsuccess = () => {
            set(candidate);
          };
          added.onerror = () => {
            fail(new Error(VAULT_ERRORS.keyUnavailable));
          };
        };
        existing.onerror = () => {
          fail(new Error(VAULT_ERRORS.keyUnavailable));
        };
      }),
    get: (id) =>
      transaction<unknown>('records','readonly',(store,set,fail) => {
        const request = store.get(id);
        request.onsuccess = () => {
          set(request.result as unknown);
        };
        request.onerror = () => {
          fail(new Error(VAULT_ERRORS.operationFailed));
        };
      }),
    put: (id,record) =>
      transaction<void>('records','readwrite',(store,set,fail) => {
        const count = store.count();
        count.onsuccess = () => {
          const existing = store.get(id);
          existing.onsuccess = () => {
            if (existing.result === undefined && count.result >= VAULT_MAX_RECORDS) {
              fail(new Error(VAULT_ERRORS.tooManyRecords));
              return;
            }
            const written = store.put(record,id);
            written.onsuccess = () => {
              set(undefined);
            };
            written.onerror = () => {
              fail(new Error(VAULT_ERRORS.operationFailed));
            };
          };
          existing.onerror = () => {
            fail(new Error(VAULT_ERRORS.operationFailed));
          };
        };
        count.onerror = () => {
          fail(new Error(VAULT_ERRORS.operationFailed));
        };
      }),
    remove: (id) =>
      transaction<void>('records','readwrite',(store,set,fail) => {
        const request = store.delete(id);
        request.onsuccess = () => {
          set(undefined);
        };
        request.onerror = () => {
          fail(new Error(VAULT_ERRORS.operationFailed));
        };
      }),
    list: () =>
      transaction<unknown[]>('records','readonly',(store,set,fail) => {
        const request = store.getAll();
        request.onsuccess = () => {
          set(request.result as unknown[]);
        };
        request.onerror = () => {
          fail(new Error(VAULT_ERRORS.operationFailed));
        };
      }),
  };
}
