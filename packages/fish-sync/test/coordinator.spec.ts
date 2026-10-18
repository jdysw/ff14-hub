import { describe,it,expect } from 'vitest';
import {
  createInMemoryProfileLock,
  createSyncCoordinator,
  createVaultCheckpointStore,
  syncCheckpointSchema,
  type CheckpointStore,
  type HubChange,
  type HubField,
  type HubPort,
  type HubPreviewToken,
  type HubSnapshot,
  type LocalPort,
  type LocalReplica,
  type LocalWriteInput,
  type LocalWriteResult,
  type SyncCheckpoint,
  type SyncCoordinator,
} from '../src/coordinator';
import { createWebDavClient,type DavPair } from '../src/webdav';
import { changedDocumentKeys,type FishDocument } from '../src/index';
import { createClientVault,type VaultProfile,type VaultStorage } from '../src/vault';

const PROFILE: VaultProfile = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  hubOrigin: 'https://hub.test',
  davBaseUrl: 'https://dav.test/private/',
  region: 'cn',
  name: '验收档案',
};

const emptyDocument = (): FishDocument => ({ completed: [],pinned: [],alarmFish: [] });
const doc = (
  completed: number[],
  pinned: number[] = [],
  alarmFish: number[] = [],
  extras: Record<string, unknown> = {},
): FishDocument => ({ completed,pinned,alarmFish,...extras });

// ---------------------------------------------------------------------------
// 内存端口
// ---------------------------------------------------------------------------

function createLocalFake(events: string[]) {
  let document = emptyDocument();
  let revisions: Record<string, number> = {};
  let revision = 'local-0';
  let operationId = '';
  let seq = 0;
  let failure: Error|null = null;
  let gate: Promise<void>|null = null;
  const port: LocalPort & {
    seed(document: FishDocument,revisions?: Record<string, number>): void;
    mutate(document: FishDocument): void;
    failNextWrite(error: Error): void;
    holdReads(): () => void;
    readonly current: () => LocalReplica;
  } = {
    current: () => ({ document,revisions: { ...revisions },revision,operationId }),
    seed: (next,nextRevisions = {}) => {
      operationId = '';
      document = next;
      revisions = { ...nextRevisions };
      revision = `local-${++seq}`;
    },
    mutate: (next) => {
      operationId = '';
      document = next;
      revision = `local-${++seq}`;
    },
    failNextWrite: (error) => {
      failure = error;
    },
    holdReads: () => {
      let release = (): void => undefined;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        gate = null;
        release();
      };
    },
    read: async () => {
      events.push('local:read');
      if (gate !== null) {
        await gate;
      }
      return { document,revisions: { ...revisions },revision,operationId };
    },
    write: (input: LocalWriteInput): Promise<LocalWriteResult> => {
      events.push('local:write');
      if (failure !== null) {
        const error = failure;
        failure = null;
        return Promise.reject(error);
      }
      if (input.expectedRevision !== revision) {
        return Promise.reject(new Error('本地副本已被其他写入改变（CAS 失败）'));
      }
      const changed = new Set<string>([...input.touched,...changedDocumentKeys(document,input.document)]);
      for (const key of changed) {
        revisions[key] = (revisions[key] ?? 0) + 1;
      }
      document = input.document;
      operationId = input.operationId;
      revision = `local-${++seq}`;
      return Promise.resolve({ revision,revisions: { ...revisions } });
    },
  };
  return port;
}

function createDavFake(events: string[]) {
  const files = new Map<string,{ text: string; etag: string }>();
  let seq = 0;
  let interruptFishPut = false;
  const write = (path: string,text: string) => {
    const row = { text,etag: `"${String(++seq)}"` };
    files.set(path,row);
    return row;
  };
  const network: typeof fetch = async (input,init) => {
    const address = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(address).pathname.split('/').at(-1) ?? '';
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    if (method !== 'GET') {
      events.push(`dav:${method} ${path}`);
    }
    const row = files.get(path);
    if (method === 'GET') {
      return row === undefined ? new Response(null,{ status: 404 }) : new Response(row.text,{ headers: { ETag: row.etag } });
    }
    if ((headers.get('If-None-Match') === '*' && row !== undefined) || (headers.has('If-Match') && headers.get('If-Match') !== row?.etag)) {
      return new Response(null,{ status: 412 });
    }
    if (method === 'DELETE') {
      files.delete(path);
      return new Response(null,{ status: 204 });
    }
    if (path === 'fish.json' && interruptFishPut) {
      interruptFishPut = false;
      throw new Error('WebDAV网络或CORS请求失败；请重新读取以确认是否已写入');
    }
    const body = typeof init?.body === 'string' ? init.body : await new Response(init?.body).text();
    const stored = write(path,body);
    return new Response(null,{ status: 201,headers: { ETag: stored.etag } });
  };
  const client = createWebDavClient({
    baseUrl: PROFILE.davBaseUrl,
    hubOrigin: PROFILE.hubOrigin,
    username: 'dav-user',
    password: 'never-leaves-this-closure',
    fetch: network,
  });
  return {
    client,
    text: (name: string) => files.get(name)?.text ?? null,
    interruptNextFishPut: () => {
      interruptFishPut = true;
    },
  };
}

function createHubFake(events: string[]) {
  const fields = new Map<string,HubField>();
  let watermark = 0;
  const previews = new Map<string,{ changes: HubChange[]; watermark: number; expiresAt: number; consumed: boolean }>();
  const ledger = new Map<string,{ applied: number; replayed: boolean }>();
  let failNextApply: 'before'|'after'|null = null;
  let failNextPreview = false;
  let clock = (): number => Date.now();
  const keyOf = (fishId: number,field: HubField['field']): string => `${String(fishId)}:${field}`;
  const port: HubPort & {
    setClock(next: () => number): void;
    failApply(mode: 'before'|'after'): void;
    failPreview(): void;
    put(fishId: number,field: HubField['field'],value: boolean,revision: number): void;
    mutate(fishId: number,field: HubField['field'],value: boolean): void;
    readonly watermark: number;
    readonly fields: ReadonlyMap<string,HubField>;
  } = {
    fields,
    setClock: (next) => {
      clock = next;
    },
    failApply: (mode) => {
      failNextApply = mode;
    },
    failPreview: () => {
      failNextPreview = true;
    },
    put: (fishId,field,value,revision) => {
      fields.set(keyOf(fishId,field),{ fishId,field,value,revision });
      watermark += 1;
    },
    mutate: (fishId,field,value) => {
      const existing = fields.get(keyOf(fishId,field));
      fields.set(keyOf(fishId,field),{ fishId,field,value,revision: (existing?.revision ?? 0) + 1 });
      watermark += 1;
    },
    get watermark() {
      return watermark;
    },
    snapshot: (region) => {
      events.push('hub:snapshot');
      return Promise.resolve({ region,watermark,fields: [...fields.values()] } satisfies HubSnapshot);
    },
    preview: (_region,changes) => {
      events.push('hub:preview');
      if (failNextPreview) {
        failNextPreview = false;
        return Promise.reject(new Error('字段修订号已变化，请重新预览'));
      }
      for (const change of changes) {
        if ((fields.get(keyOf(change.fishId,change.field))?.revision ?? 0) !== change.expectedRevision) {
          return Promise.reject(new Error('字段修订号已变化，请重新预览'));
        }
      }
      const token = crypto.randomUUID();
      const expiresAt = clock() + 600_000;
      previews.set(token,{ changes: [...changes],watermark,expiresAt,consumed: false });
      return Promise.resolve({ token,watermark,expiresAt } satisfies HubPreviewToken);
    },
    apply: ({ token,operationId }) => {
      events.push('hub:apply');
      const cached = ledger.get(`${token}:${operationId}`);
      if (cached !== undefined) {
        return Promise.resolve({...cached,replayed:true});
      }
      const preview = previews.get(token);
      if (preview === undefined || preview.consumed || preview.expiresAt <= clock()) {
        return Promise.reject(new Error('预览已过期或已使用，请重新预览'));
      }
      if (preview.watermark !== watermark) {
        return Promise.reject(new Error('数据已变化，请重新预览'));
      }
      if (failNextApply === 'before') {
        failNextApply = null;
        return Promise.reject(new Error('网络中断（响应丢失，服务端未提交）'));
      }
      for (const change of preview.changes) {
        fields.set(keyOf(change.fishId,change.field),{
          fishId: change.fishId,
          field: change.field,
          value: change.value,
          revision: change.expectedRevision + 1,
        });
        watermark += 1;
      }
      preview.consumed = true;
      const result = { applied: preview.changes.length,replayed: false };
      ledger.set(`${token}:${operationId}`,result);
      if (failNextApply === 'after') {
        failNextApply = null;
        return Promise.reject(new Error('网络中断（响应丢失，服务端已提交）'));
      }
      return Promise.resolve(result);
    },
  };
  return port;
}

function createCheckpointFake(events: string[]) {
  let state: unknown = null;
  let failWriteFor: string|null = null;
  let readError: Error|null = null;
  const writes: SyncCheckpoint[] = [];
  const archived: unknown[] = [];
  const store: CheckpointStore & {
    seed(checkpoint: SyncCheckpoint|null): void;
    failNextWriteFor(stage: string): void;
    failRead(error: Error): void;
    readonly state: unknown;
    readonly writes: readonly SyncCheckpoint[];
    readonly archived: readonly unknown[];
  } = {
    writes,
    archived,
    get state() {
      return state;
    },
    seed: (checkpoint) => {
      state = checkpoint === null ? null : (JSON.parse(JSON.stringify(checkpoint)) as unknown);
    },
    failNextWriteFor: (stage) => {
      failWriteFor = stage;
    },
    failRead: (error) => {
      readError = error;
    },
    read: () => {
      if (readError !== null) {
        const error = readError;
        readError = null;
        return Promise.reject(error);
      }
      return Promise.resolve(state);
    },
    write: (_profile,checkpoint) => {
      const stage = checkpoint.pending?.stage ?? 'complete';
      if (failWriteFor === stage) {
        failWriteFor = null;
        return Promise.reject(new Error('本机存储写入失败'));
      }
      events.push(`checkpoint:${stage}`);
      writes.push(JSON.parse(JSON.stringify(checkpoint)) as SyncCheckpoint);
      state = JSON.parse(JSON.stringify(checkpoint)) as unknown;
      return Promise.resolve();
    },
    archive: (_profile,entry) => {
      archived.push(entry);
      return Promise.resolve();
    },
    clear: () => {
      state = null;
      return Promise.resolve();
    },
  };
  return store;
}

function baselineOf(document: FishDocument,revisions: Record<string, number>,hubWatermark: number): SyncCheckpoint {
  return {
    v: 2,
    profileId: PROFILE.id,
    baseline: {
      document,
      revisions:{local:revisions,webdav:revisions,hub:revisions},
      localRevision: 'local-baseline',
      davFishEtag: null,
      davSidecarEtag: null,
      davDocumentHash: null,
      hubWatermark,
      syncedAt: 1,
    },
    pending: null,
  };
}

function setup() {
  const events: string[] = [];
  const local = createLocalFake(events);
  const dav = createDavFake(events);
  const hub = createHubFake(events);
  const checkpoints = createCheckpointFake(events);
  const coordinator: SyncCoordinator = createSyncCoordinator({
    local,
    dav: dav.client,
    hub,
    checkpoints,
    lock: createInMemoryProfileLock(),
  });
  return { events,local,dav,hub,checkpoints,coordinator };
}

const putCount = (events: readonly string[]): number => events.filter((event) => event.startsWith('dav:PUT')).length;

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('sync coordinator', () => {
  it('merges three replicas, writes DAV → Hub → Local, and only sends the minimal Hub intent', async () => {
    const { events,local,dav,hub,checkpoints,coordinator } = setup();
    checkpoints.seed(baselineOf(doc([1]),{ 'completed:1': 1 },2));

    // 本地新增 completed:2（扩展字段只属于客户端）。
    local.seed(doc([1,2],[],[],{ future: { note: 'local-only' } }),{ 'completed:1': 1,'completed:2': 1 });
    // WebDAV 已有 pinned:3。
    await dav.client.commit(doc([1]),'cn',await dav.client.readPair(),new Set());
    await dav.client.commit(doc([1],[3]),'cn',await dav.client.readPair(),new Set());
    // Hub 已有 alarm:4（caught:1 与基线一致）。
    hub.put(1,'caught',true,1);
    hub.put(4,'alarm',true,1);

    const preview = await coordinator.preview({ profile: PROFILE });
    expect(preview.state).toBe('ready');
    if (preview.state !== 'ready') {
      return;
    }
    const { plan } = preview;
    expect(plan.document).toEqual({ completed: [1,2],pinned: [3],alarmFish: [4],future: { note: 'local-only' } });
    // 最小意图：只发真正需要改的 2 个字段；alarm:4 已经在 Hub 等于目标值 → 不发。
    expect(plan.hubChanges).toEqual([
      { fishId: 2,field: 'caught',value: true,expectedRevision: 0 },
      { fishId: 3,field: 'pinned',value: true,expectedRevision: 0 },
    ]);
    expect(plan.touchedKeys).toContain('pinned:3');

    const mark = events.length;
    const outcome = await coordinator.apply({ profile: PROFILE,plan });
    expect(outcome.appliedHubChanges).toBe(2);
    expect(outcome.replayedHubApply).toBe(false);

    // 三方最终一致；扩展字段留在客户端与 DAV；Hub 只认识最小字段。
    expect(local.current().document).toEqual(plan.document);
    expect(JSON.parse(dav.text('fish.json') ?? 'null') as unknown).toEqual(plan.document);
    expect([...hub.fields.keys()].sort()).toEqual(['1:caught','2:caught','3:pinned','4:alarm']);

    // 副作用顺序：计划先落盘 → DAV → Hub → 本地 → 最后记基线。
    const tail = events.slice(mark);
    const firstPut = tail.findIndex((event) => event.startsWith('dav:PUT'));
    const planned = tail.indexOf('checkpoint:planned');
    expect(planned).toBeGreaterThanOrEqual(0);
    expect(planned).toBeLessThan(firstPut);
    expect(firstPut).toBeLessThan(tail.indexOf('hub:apply'));
    expect(tail.indexOf('hub:apply')).toBeLessThan(tail.indexOf('local:write'));
    expect(tail.filter((event) => event.startsWith('checkpoint:')).at(-1)).toBe('checkpoint:complete');
    expect(tail.filter((event) => event.startsWith('checkpoint:'))).toHaveLength(4);

    const final = syncCheckpointSchema.parse(checkpoints.state);
    expect(final.pending).toBeNull();
    expect(final.baseline?.document).toEqual(plan.document);
    expect(final.baseline?.hubWatermark).toBe(hub.watermark);
    // 有基线之后再预览：没有任何需要写入的变化。
    const again = await coordinator.preview({ profile: PROFILE });
    expect(again.state).toBe('ready');
    if (again.state === 'ready') {
      expect(again.plan.hubChanges).toEqual([]);
      expect(again.plan.changedKeys).toEqual([]);
    }
  });

  it('blocks every write while a conflict is unresolved, and resolves it with an explicit replica', async () => {
    const { events,local,dav,hub,checkpoints,coordinator } = setup();
    checkpoints.seed(baselineOf(emptyDocument(),{},0));
    local.seed(doc([5]),{ 'completed:5': 1 });
    await dav.client.commit(doc([5]),'cn',await dav.client.readPair(),new Set(['completed:5']));
    hub.put(5,'caught',false,1);

    const putsBefore = putCount(events);
    const conflict = await coordinator.preview({ profile: PROFILE });
    expect(conflict.state).toBe('conflict');
    if (conflict.state !== 'conflict') {
      return;
    }
    expect(conflict.conflicts.map((item) => item.key)).toEqual(['completed:5']);
    expect(putCount(events)).toBe(putsBefore);
    expect(events).not.toContain('local:write');
    expect(events).not.toContain('hub:apply');
    expect(checkpoints.writes).toHaveLength(0);

    const resolved = await coordinator.preview({ profile: PROFILE,resolutions: { 'completed:5': 'local' } });
    expect(resolved.state).toBe('ready');
    if (resolved.state === 'ready') {
      expect(resolved.plan.document.completed).toEqual([5]);
    }
  });

  it('treats absence as "no opinion" on first sync, but still requires explicit choices for real disagreement', async () => {
    const first = setup();
    first.local.seed(doc([7]),{ 'completed:7': 1 });
    const ready = await first.coordinator.preview({ profile: PROFILE });
    expect(ready.state).toBe('ready');
    if (ready.state === 'ready') {
      expect(ready.plan.document.completed).toEqual([7]);
      expect(ready.plan.hubChanges).toEqual([{ fishId: 7,field: 'caught',value: true,expectedRevision: 0 }]);
    }

    // Hub 显式写了 false（单边取消）→ 必须显式选择，不能静默取并集。
    const cancelled = setup();
    cancelled.local.seed(doc([7]),{ 'completed:7': 1 });
    cancelled.hub.put(7,'caught',false,1);
    const conflict = await cancelled.coordinator.preview({ profile: PROFILE });
    expect(conflict.state).toBe('conflict');
    if (conflict.state === 'conflict') {
      expect(conflict.conflicts.map((item) => item.key)).toEqual(['completed:7']);
    }

    // 真的存在一个空 fish.json 时 DAV 也持有意见 → 分歧。
    const withDav = setup();
    withDav.local.seed(doc([7]),{ 'completed:7': 1 });
    await withDav.dav.client.commit(emptyDocument(),'cn',await withDav.dav.client.readPair(),new Set());
    expect((await withDav.coordinator.preview({ profile: PROFILE })).state).toBe('conflict');
  });

  it('recovers a crash before the fish.json write by resuming the prepared sidecar', async () => {
    const { local,hub,checkpoints,coordinator,dav } = setup();
    checkpoints.seed(baselineOf(emptyDocument(),{},0));
    local.seed(doc([1]),{ 'completed:1': 1 });

    const preview = await coordinator.preview({ profile: PROFILE });
    expect(preview.state).toBe('ready');
    if (preview.state !== 'ready') {
      return;
    }
    // prepared 记录会写成功，fish.json 的 PUT 失败：模拟 commit 中途中断。
    dav.interruptNextFishPut();
    await expect(coordinator.apply({ profile: PROFILE,plan: preview.plan })).rejects.toThrow('WebDAV网络');
    const pending = syncCheckpointSchema.parse(checkpoints.state).pending;
    expect(pending?.stage).toBe('planned');
    expect(pending?.operationId).toBe(preview.plan.operationId);
    expect(pending?.blockedReason).toBeNull();

    // 恢复：重读 → 识别出 prepared 记录 → 续跑 → 三方一致。
    const recovered = await coordinator.recover({ profile: PROFILE });
    expect(recovered.status).toBe('completed');
    expect(local.current().document.completed).toEqual([1]);
    const final = syncCheckpointSchema.parse(checkpoints.state);
    expect(final.pending).toBeNull();
    expect(final.baseline?.document.completed).toEqual([1]);
    expect(hub.fields.get('1:caught')?.value).toBe(true);
  });

  it('recovers a lost Hub response only by replaying the original ledger operation', async () => {
    const { events,local,hub,checkpoints,coordinator } = setup();
    checkpoints.seed(baselineOf(emptyDocument(),{},0));
    local.seed(doc([2]),{ 'completed:2': 1 });

    const preview = await coordinator.preview({ profile: PROFILE });
    expect(preview.state).toBe('ready');
    if (preview.state !== 'ready') {
      return;
    }
    hub.failApply('after');
    await expect(coordinator.apply({ profile: PROFILE,plan: preview.plan })).rejects.toThrow('网络中断');
    const recovered = await coordinator.recover({profile:PROFILE});
    if (recovered.status !== 'completed') throw new Error('recovery incomplete');
    const outcome = recovered.outcome;
    expect(outcome.replayedHubApply).toBe(true);
    expect(outcome.appliedHubChanges).toBe(1);
    expect(hub.fields.get('2:caught')?.revision).toBe(1);
    expect(events.filter((event) => event === 'hub:apply')).toHaveLength(2);
    expect(syncCheckpointSchema.parse(checkpoints.state).pending).toBeNull();
  });

  it('keeps the pending intent when the Hub response was lost without commit, then completes on recover', async () => {
    const { events,local,hub,checkpoints,coordinator } = setup();
    checkpoints.seed(baselineOf(emptyDocument(),{},0));
    local.seed(doc([2]),{ 'completed:2': 1 });

    const preview = await coordinator.preview({ profile: PROFILE });
    expect(preview.state).toBe('ready');
    if (preview.state !== 'ready') {
      return;
    }
    hub.failApply('before');
    await expect(coordinator.apply({ profile: PROFILE,plan: preview.plan })).rejects.toThrow('网络中断');
    const pending = syncCheckpointSchema.parse(checkpoints.state).pending;
    expect(pending?.stage).toBe('dav-committed');
    expect(pending?.operationId).toBe(preview.plan.operationId);
    expect(pending?.blockedReason).toBeNull();
    // 没有「看起来成功」：本地写入还没有发生。
    expect(events).not.toContain('local:write');
    expect(hub.fields.get('2:caught')).toBeUndefined();

    const recovered = await coordinator.recover({ profile: PROFILE });
    expect(recovered.status).toBe('completed');
    expect(hub.fields.get('2:caught')?.value).toBe(true);
    expect(local.current().document.completed).toEqual([2]);
  });

  it('completes on recover when the local write happened but the final checkpoint was lost', async () => {
    const { local,hub,checkpoints,coordinator } = setup();
    checkpoints.seed(baselineOf(emptyDocument(),{},0));
    local.seed(doc([3]),{ 'completed:3': 1 });

    const preview = await coordinator.preview({ profile: PROFILE });
    expect(preview.state).toBe('ready');
    if (preview.state !== 'ready') {
      return;
    }
    checkpoints.failNextWriteFor('complete');
    await expect(coordinator.apply({ profile: PROFILE,plan: preview.plan })).rejects.toThrow('本机存储写入失败');
    expect(local.current().document.completed).toEqual([3]);
    expect(syncCheckpointSchema.parse(checkpoints.state).pending?.stage).toBe('hub-applied');
    expect(hub.fields.get('3:caught')?.value).toBe(true);

    const recovered = await coordinator.recover({ profile: PROFILE });
    expect(recovered.status).toBe('completed');
    expect(syncCheckpointSchema.parse(checkpoints.state).pending).toBeNull();
  });

  it('refuses a stale or expired preview without writing anything', async () => {
    const stale = setup();
    stale.checkpoints.seed(baselineOf(emptyDocument(),{},0));
    stale.local.seed(doc([4]),{ 'completed:4': 1 });
    const stalePreview = await stale.coordinator.preview({ profile: PROFILE });
    expect(stalePreview.state).toBe('ready');
    if (stalePreview.state !== 'ready') {
      return;
    }
    stale.hub.mutate(9,'caught',true);
    await expect(stale.coordinator.apply({ profile: PROFILE,plan: stalePreview.plan })).rejects.toMatchObject({ code: 'stale-preview' });
    expect(putCount(stale.events)).toBe(0);
    expect(stale.events).not.toContain('hub:apply');
    expect(stale.events).not.toContain('local:write');

    // Hub 在预览时就拒绝（服务端修订号已变化）。
    const serverStale = setup();
    serverStale.local.seed(doc([4]),{ 'completed:4': 1 });
    serverStale.hub.failPreview();
    await expect(serverStale.coordinator.preview({ profile: PROFILE })).rejects.toMatchObject({ code: 'stale-preview' });

    let clock = 1_000;
    const expired = setup();
    expired.hub.setClock(() => clock);
    expired.checkpoints.seed(baselineOf(emptyDocument(),{},0));
    expired.local.seed(doc([4]),{ 'completed:4': 1 });
    const expiredPreview = await expired.coordinator.preview({ profile: PROFILE });
    expect(expiredPreview.state).toBe('ready');
    if (expiredPreview.state !== 'ready') {
      return;
    }
    clock += 700_000;
    await expect(expired.coordinator.apply({ profile: PROFILE,plan: expiredPreview.plan })).rejects.toMatchObject({ code: 'preview-expired' });
    expect(putCount(expired.events)).toBe(0);
    expect(expired.events).not.toContain('hub:apply');
  });

  it('refuses a whole plan that exceeds the 200-field Hub cap', async () => {
    const { local,coordinator } = setup();
    local.seed(doc(Array.from({ length: 201 },(_, index) => index + 1)),{});
    await expect(coordinator.preview({ profile: PROFILE })).rejects.toMatchObject({ code: 'plan-too-large' });
  });

  it('stops recovery when unrelated replicas changed, preserving the checkpoint', async () => {
    const hubChanged = setup();
    hubChanged.checkpoints.seed(baselineOf(emptyDocument(),{},0));
    hubChanged.local.seed(doc([5]),{ 'completed:5': 1 });
    const hubPreview = await hubChanged.coordinator.preview({ profile: PROFILE });
    expect(hubPreview.state).toBe('ready');
    if (hubPreview.state !== 'ready') {
      return;
    }
    hubChanged.hub.failApply('before');
    await expect(hubChanged.coordinator.apply({ profile: PROFILE,plan: hubPreview.plan })).rejects.toThrow('网络中断');
    // 中断期间另一台设备改了别的字段：watermark 前进 → 恢复必须停下。
    hubChanged.hub.mutate(99,'pinned',true);
    await expect(hubChanged.coordinator.recover({ profile: PROFILE })).rejects.toMatchObject({ code: 'blocked' });
    const preserved = syncCheckpointSchema.parse(hubChanged.checkpoints.state).pending;
    expect(preserved?.stage).toBe('dav-committed');
    expect(preserved?.blockedReason).not.toBeNull();
    expect(hubChanged.hub.fields.get('5:caught')).toBeUndefined();

    const davChanged = setup();
    davChanged.checkpoints.seed(baselineOf(emptyDocument(),{},0));
    davChanged.local.seed(doc([6]),{ 'completed:6': 1 });
    const davPreview = await davChanged.coordinator.preview({ profile: PROFILE });
    expect(davPreview.state).toBe('ready');
    if (davPreview.state !== 'ready') {
      return;
    }
    davChanged.hub.failApply('before');
    await expect(davChanged.coordinator.apply({ profile: PROFILE,plan: davPreview.plan })).rejects.toThrow('网络中断');
    // 第三方在恢复前重写了 fish.json。
    await davChanged.dav.client.commit(doc([6],[77]),'cn',await davChanged.dav.client.readPair(),new Set());
    await expect(davChanged.coordinator.recover({ profile: PROFILE })).rejects.toMatchObject({ code: 'blocked' });

    const localChanged = setup();
    localChanged.checkpoints.seed(baselineOf(emptyDocument(),{},0));
    localChanged.local.seed(doc([8]),{ 'completed:8': 1 });
    const localPreview = await localChanged.coordinator.preview({ profile: PROFILE });
    expect(localPreview.state).toBe('ready');
    if (localPreview.state !== 'ready') {
      return;
    }
    localChanged.hub.failApply('before');
    await expect(localChanged.coordinator.apply({ profile: PROFILE,plan: localPreview.plan })).rejects.toThrow('网络中断');
    localChanged.local.mutate(doc([8,88]));
    await expect(localChanged.coordinator.recover({ profile: PROFILE })).rejects.toMatchObject({ code: 'blocked' });
    expect(localChanged.local.current().document.completed).toEqual([8,88]);
  });

  it('stops instead of starting fresh when the checkpoint is missing, corrupt or unreadable', async () => {
    const other = setup();
    other.checkpoints.seed({ v: 2,profileId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',baseline: null,pending: null });
    await expect(other.coordinator.preview({ profile: PROFILE })).rejects.toMatchObject({ code: 'checkpoint-unavailable' });

    const corrupt = setup();
    corrupt.checkpoints.seed({ nope: true } as unknown as SyncCheckpoint);
    await expect(corrupt.coordinator.preview({ profile: PROFILE })).rejects.toMatchObject({ code: 'checkpoint-unavailable' });

    const unreadable = setup();
    unreadable.checkpoints.failRead(new Error('本机记录无法解密；配置、密钥或记录已变化'));
    await expect(unreadable.coordinator.preview({ profile: PROFILE })).rejects.toMatchObject({ code: 'checkpoint-unavailable' });
    expect(unreadable.checkpoints.writes).toHaveLength(0);
  });

  it('holds an exclusive per-profile lock and releases it after both success and failure', async () => {
    const { local,checkpoints,coordinator } = setup();
    checkpoints.seed(baselineOf(emptyDocument(),{},0));
    local.seed(doc([1]),{ 'completed:1': 1 });
    const release = local.holdReads();
    const running = coordinator.preview({ profile: PROFILE });
    await new Promise<void>((resolve) => {
      setTimeout(resolve,0);
    });
    await expect(coordinator.preview({ profile: PROFILE })).rejects.toMatchObject({ code: 'lock-busy' });
    release();
    await expect(running).resolves.toMatchObject({ state: 'ready' });
    // 成功之后锁已释放。
    await expect(coordinator.preview({ profile: PROFILE })).resolves.toMatchObject({ state: 'ready' });

    // 失败之后同样会释放锁。
    const failing = setup();
    failing.checkpoints.seed({ broken: true } as unknown as SyncCheckpoint);
    await expect(failing.coordinator.recover({ profile: PROFILE })).rejects.toMatchObject({ code: 'checkpoint-unavailable' });
    failing.checkpoints.seed(baselineOf(emptyDocument(),{},0));
    failing.local.seed(doc([1]),{ 'completed:1': 1 });
    await expect(failing.coordinator.preview({ profile: PROFILE })).resolves.toMatchObject({ state: 'ready' });
  });

  it('only archives or discards a pending operation after an explicit operationId check', async () => {
    const archive = setup();
    archive.checkpoints.seed(baselineOf(emptyDocument(),{},0));
    archive.local.seed(doc([5]),{ 'completed:5': 1 });
    const preview = await archive.coordinator.preview({ profile: PROFILE });
    expect(preview.state).toBe('ready');
    if (preview.state !== 'ready') {
      return;
    }
    archive.hub.failApply('before');
    await expect(archive.coordinator.apply({ profile: PROFILE,plan: preview.plan })).rejects.toThrow('网络中断');
    const status = await archive.coordinator.status(PROFILE);
    expect(status?.operationId).toBe(preview.plan.operationId);
    expect(status?.stage).toBe('dav-committed');

    await expect(
      archive.coordinator.resolvePending({ profile: PROFILE,operationId: '00000000-0000-4000-8000-000000000000',mode: 'archive' }),
    ).rejects.toMatchObject({ code: 'operation-mismatch' });
    expect(syncCheckpointSchema.parse(archive.checkpoints.state).pending).not.toBeNull();

    await expect(
      archive.coordinator.resolvePending({ profile: PROFILE,operationId: preview.plan.operationId,mode: 'archive' }),
    ).resolves.toEqual({ status: 'archived' });
    expect(archive.checkpoints.archived).toHaveLength(1);
    const cleared = syncCheckpointSchema.parse(archive.checkpoints.state);
    expect(cleared.pending).toBeNull();
    expect(cleared.baseline).not.toBeNull();

    const discard = setup();
    discard.checkpoints.seed(baselineOf(emptyDocument(),{},0));
    discard.local.seed(doc([5]),{ 'completed:5': 1 });
    const discardPreview = await discard.coordinator.preview({ profile: PROFILE });
    expect(discardPreview.state).toBe('ready');
    if (discardPreview.state !== 'ready') {
      return;
    }
    discard.hub.failApply('before');
    await expect(discard.coordinator.apply({ profile: PROFILE,plan: discardPreview.plan })).rejects.toThrow('网络中断');
    await expect(
      discard.coordinator.resolvePending({ profile: PROFILE,operationId: discardPreview.plan.operationId,mode: 'discard' }),
    ).resolves.toEqual({ status: 'discarded' });
    expect(syncCheckpointSchema.parse(discard.checkpoints.state).pending).toBeNull();
    expect(discard.checkpoints.archived).toHaveLength(0);

    // 没有待处理操作时 recover 是空操作。
    await expect(discard.coordinator.recover({ profile: PROFILE })).resolves.toEqual({ status: 'idle' });
  });

  it('never starts a second plan while another operation id is pending, but resumes the same one', async () => {
    const { local,hub,checkpoints,coordinator } = setup();
    checkpoints.seed(baselineOf(emptyDocument(),{},0));
    local.seed(doc([5]),{ 'completed:5': 1 });
    const preview = await coordinator.preview({ profile: PROFILE });
    expect(preview.state).toBe('ready');
    if (preview.state !== 'ready') {
      return;
    }
    hub.failApply('before');
    await expect(coordinator.apply({ profile: PROFILE,plan: preview.plan })).rejects.toThrow('网络中断');
    await expect(coordinator.preview({ profile: PROFILE })).rejects.toMatchObject({ code: 'pending-operation' });
    await expect(
      coordinator.apply({ profile: PROFILE,plan: { ...preview.plan,operationId: '00000000-0000-4000-8000-000000000000' } }),
    ).rejects.toMatchObject({ code: 'pending-operation' });
    // 同一个 operationId → 走恢复而不是重开。
    await expect(coordinator.apply({ profile: PROFILE,plan: preview.plan })).resolves.toBeDefined();
    expect(syncCheckpointSchema.parse(checkpoints.state).pending).toBeNull();
  });

  it('round-trips the durable checkpoint and the archive through the encrypted client vault', async () => {
    const records = new Map<string,unknown>();
    const keys = new Map<string,CryptoKey>();
    const storage: VaultStorage = {
      ensureKey: (candidate) => {
        const existing = keys.get('master');
        if (existing !== undefined) {
          return Promise.resolve(existing);
        }
        keys.set('master',candidate);
        return Promise.resolve(candidate);
      },
      get: (id) => Promise.resolve(records.get(id)),
      put: (id,record) => {
        records.set(id,record);
        return Promise.resolve();
      },
      remove: (id) => {
        records.delete(id);
        return Promise.resolve();
      },
      list: () => Promise.resolve([...records.values()]),
    };
    const store = createVaultCheckpointStore(createClientVault(storage));
    const checkpoint = baselineOf(doc([1,2]),{ 'completed:1': 2 },7);
    await store.write(PROFILE,checkpoint);
    expect(JSON.stringify([...records.values()])).not.toContain('alarmFish');
    expect(await store.read(PROFILE)).toEqual(checkpoint);

    await store.archive(PROFILE,{
      operationId: '00000000-0000-4000-8000-000000000001',
      archivedAt: 1,
      region: 'cn',
      document: doc([1]),
      touched: ['completed:1'],
      hubChanges: [],
      stage: 'dav-committed',
      blockedReason: 'test',
    });
    // 归档写到另一个用途的记录，不会覆盖检查点。
    expect(await store.read(PROFILE)).toEqual(checkpoint);
    expect(records.size).toBe(2);
  });

  it('does not mutate a foreign prepared DAV transaction during preview or stale apply', async () => {
    const s=setup();
    s.dav.interruptNextFishPut();
    await expect(s.dav.client.commit(doc([1]),'cn',await s.dav.client.readPair(),new Set())).rejects.toThrow();
    const before=putCount(s.events);
    await expect(s.coordinator.preview({profile:PROFILE})).rejects.toMatchObject({code:'dav-conflict'});
    expect(putCount(s.events)).toBe(before);
    expect((await s.dav.client.readPair()).metadata?.state).toBe('prepared');
  });

  it('checks Hub and local divergence before resuming its own prepared DAV transaction', async () => {
    for(const replica of ['hub','local'] as const){
      const s=setup();s.local.seed(doc([1]));
      const preview=await s.coordinator.preview({profile:PROFILE});
      if(preview.state!=='ready')throw new Error('expected ready');
      s.dav.interruptNextFishPut();
      await expect(s.coordinator.apply({profile:PROFILE,plan:preview.plan})).rejects.toThrow();
      if(replica==='hub')s.hub.mutate(99,'caught',true);else s.local.mutate(doc([1,99]));
      const before=putCount(s.events);
      await expect(s.coordinator.recover({profile:PROFILE})).rejects.toMatchObject({code:'blocked'});
      expect(putCount(s.events)).toBe(before);
      expect((await s.dav.client.readPair()).metadata?.state).toBe('prepared');
    }
  });

  it('keeps separate replica clocks so a large local revision cannot hide a Hub net-zero edit', async () => {
    const s=setup();
    const baseline=baselineOf(emptyDocument(),{},1);
    if(baseline.baseline===null)throw new Error('baseline');
    baseline.baseline.revisions={local:{'completed:1':99},webdav:{'completed:1':1},hub:{'completed:1':1}};
    s.checkpoints.seed(baseline);
    s.local.seed(doc([1]),{'completed:1':100});
    await s.dav.client.commit(emptyDocument(),'cn',await s.dav.client.readPair(),new Set());
    s.hub.put(1,'caught',false,2);
    const result=await s.coordinator.preview({profile:PROFILE});
    expect(result.state).toBe('conflict');
    if(result.state==='conflict')expect(result.conflicts.map((c)=>c.key)).toContain('completed:1');
  });

  it('rejects a concurrent DAV commit even when its document equals the target', async () => {
    const s=setup();s.local.seed(doc([1]));
    const preview=await s.coordinator.preview({profile:PROFILE});
    if(preview.state!=='ready')throw new Error('expected ready');
    s.hub.failApply('before');
    await expect(s.coordinator.apply({profile:PROFILE,plan:preview.plan})).rejects.toThrow();
    await s.dav.client.commit(preview.plan.document,'cn',await s.dav.client.readPair(),new Set(['completed:1']));
    await expect(s.coordinator.recover({profile:PROFILE})).rejects.toMatchObject({code:'blocked'});
    expect(s.hub.fields.size).toBe(0);
  });

  it('blocks Hub changes after a lost apply response, including changes outside planned fields', async () => {
    const s=setup();s.local.seed(doc([1]));
    const preview=await s.coordinator.preview({profile:PROFILE});
    if(preview.state!=='ready')throw new Error('expected ready');
    s.hub.failApply('after');
    await expect(s.coordinator.apply({profile:PROFILE,plan:preview.plan})).rejects.toThrow();
    s.hub.mutate(99,'pinned',true);
    await expect(s.coordinator.recover({profile:PROFILE})).rejects.toMatchObject({code:'blocked'});
    expect(s.events).not.toContain('local:write');
  });

  it('revalidates remotes before a local CAS on hub-applied recovery', async () => {
    for(const replica of ['hub','dav'] as const){
      const s=setup();s.local.seed(emptyDocument());s.hub.put(1,'caught',true,1);
      const preview=await s.coordinator.preview({profile:PROFILE,resolutions:{'completed:1':'hub'}});
      if(preview.state!=='ready')throw new Error('expected ready');
      s.local.failNextWrite(new Error('local transport'));
      await expect(s.coordinator.apply({profile:PROFILE,plan:preview.plan})).rejects.toThrow('local transport');
      if(replica==='hub')s.hub.mutate(99,'caught',true);
      else await s.dav.client.commit(doc([1,99]),'cn',await s.dav.client.readPair(),new Set());
      const writes=s.events.filter((e)=>e==='local:write').length;
      await expect(s.coordinator.recover({profile:PROFILE})).rejects.toMatchObject({code:'blocked'});
      expect(s.events.filter((e)=>e==='local:write')).toHaveLength(writes);
      expect(s.local.current().document).toEqual(emptyDocument());
    }
  });

  it('refuses another profile or region plan before any effects', async () => {
    const s=setup();s.local.seed(doc([1]));
    const preview=await s.coordinator.preview({profile:PROFILE});
    if(preview.state!=='ready')throw new Error('expected ready');
    await expect(s.coordinator.apply({profile:{...PROFILE,region:'global'},plan:preview.plan})).rejects.toMatchObject({code:'stale-preview'});
    expect(putCount(s.events)).toBe(0);
  });

  it('requires a fresh preview if the caller changes the target document', async () => {
    const s=setup();s.local.seed(doc([1]));
    const preview=await s.coordinator.preview({profile:PROFILE});
    if(preview.state!=='ready')throw new Error('expected ready');
    preview.plan.document.completed.push(99);
    await expect(s.coordinator.apply({profile:PROFILE,plan:preview.plan})).rejects.toMatchObject({code:'stale-preview'});
    expect(putCount(s.events)).toBe(0);
    expect(s.checkpoints.writes).toHaveLength(0);
  });

  it('recovers a lost DAV stage checkpoint using its transaction id', async () => {
    const s=setup();s.local.seed(doc([1]));
    const preview=await s.coordinator.preview({profile:PROFILE});
    if(preview.state!=='ready')throw new Error('expected ready');
    s.checkpoints.failNextWriteFor('dav-committed');
    await expect(s.coordinator.apply({profile:PROFILE,plan:preview.plan})).rejects.toThrow('本机存储写入失败');
    const before=putCount(s.events);
    expect((await s.dav.client.readPair()).metadata?.transactionId).toBe(preview.plan.operationId);
    await expect(s.coordinator.recover({profile:PROFILE})).resolves.toMatchObject({status:'completed'});
    expect(putCount(s.events)).toBe(before);
  });

  it('accepts an actual lost local write checkpoint only with the operation receipt', async () => {
    const s=setup();s.local.seed(emptyDocument());s.hub.put(1,'caught',true,1);
    const preview=await s.coordinator.preview({profile:PROFILE,resolutions:{'completed:1':'hub'}});
    if(preview.state!=='ready')throw new Error('expected ready');
    s.checkpoints.failNextWriteFor('complete');
    await expect(s.coordinator.apply({profile:PROFILE,plan:preview.plan})).rejects.toThrow('本机存储写入失败');
    expect(s.local.current().operationId).toBe(preview.plan.operationId);
    const count=s.events.filter((e)=>e==='local:write').length;
    await expect(s.coordinator.recover({profile:PROFILE})).resolves.toMatchObject({status:'completed'});
    expect(s.events.filter((e)=>e==='local:write')).toHaveLength(count);
  });

  it('preserves a corrupt encrypted archive instead of overwriting it', async () => {
    const records=new Map<string,unknown>();let key:CryptoKey|undefined;
    const vault=createClientVault({
      ensureKey:(candidate)=>Promise.resolve(key??=candidate),get:(id)=>Promise.resolve(records.get(id)),
      put:(id,value)=>{records.set(id,value);return Promise.resolve();},
      remove:(id)=>{records.delete(id);return Promise.resolve();},list:()=>Promise.resolve([...records.values()]),
    });
    await vault.writeRecord(PROFILE,'archive',{unexpected:true});
    const original=JSON.stringify([...records.values()]);
    await expect(createVaultCheckpointStore(vault).archive(PROFILE,{
      operationId:crypto.randomUUID(),archivedAt:1,region:'cn',document:emptyDocument(),touched:[],hubChanges:[],stage:'planned',blockedReason:null,
    })).rejects.toMatchObject({code:'checkpoint-unavailable'});
    expect(JSON.stringify([...records.values()])).toBe(original);
  });
});

/** 类型级护栏：DAV 客户端适配器必须仍然满足协调器的端口契约。 */
type DavPortContract = { readPair: () => Promise<DavPair> };
const davContract: DavPortContract = { readPair: () => createWebDavClient({
  baseUrl: 'https://dav.test/private/',
  hubOrigin: 'https://hub.test',
  username: 'u',
  password: 'p',
}).readPair() };
void davContract;
