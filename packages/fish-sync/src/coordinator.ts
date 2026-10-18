/**
 * 纯注入端口的同步协调器（06B）。
 *
 * 它**不**自带任何 IO：本地鱼糕存储、WebDAV、Hub、检查点存储与锁都是注入的端口。
 * 因此：DAV 凭证与 Hub 设备 Token 都留在这个模块之外（端口实现里的闭包），
 * 协调器本身既看不到也存不下它们；所有行为都能用内存假端口做确定性单测。
 *
 * 不变量（每一条都有对应单测）：
 * 1. **三方预览**先算清冲突；有未解决冲突就不产生计划、也绝不写入。
 * 2. **副作用顺序固定**为 WebDAV → Hub → 本地；每一步之后都把进度写进加密检查点。
 * 3. **计划先落盘再执行**：任何副作用之前，`planned` 检查点已在耐久存储里。
 * 4. **恢复必须重读重校验**：任何一侧出现「计划之外的新变化」就停下并**保留**检查点，
 *    绝不无条件覆盖，也绝不静默丢弃用户意图。
 * 5. **丢失响应**不当作成功：用同一 `{token, operationId}` 取得幂等回执，
 *    再校验完整读集；目标值相同不能证明操作归属。
 * 6. 只有**显式给出被检查过的 operationId** 才能归档/丢弃待处理意图。
 * 7. Hub 只接收最小字段意图（`{fishId, field, value, expectedRevision}`），
 *    扩展字段永远只在客户端；整批计划超过 200 项字段变化直接拒绝（不做部分导入）。
 *
 * 本轮**不**包含：真实鱼糕站点存储适配、真实 WebDAV 联调、跨标签页互斥（锁端口目前只有
 * 进程内实现）、自动化后台同步。这些是明确的未完成项，不把「单测通过」讲成「已能自动同步」。
 */
import { z } from 'zod';
import {
  FISH_SETS,
  canonicalJson,
  changedDocumentKeys,
  documentChanges,
  fieldsToDocument,
  fishDocumentSchema,
  mergeFishDocuments,
  touchedSince,
  type FishDocument,
  type Json,
  type MergeConflict,
  type Replica,
  type SyncField,
} from './index';
import { DavConflict, documentHash, type DavPair } from './webdav';
import type { ClientVault, VaultProfile } from './vault';

export type SyncRegion = 'cn' | 'global';
const regionSchema = z.enum(['cn','global']);

/** Hub 字段名 → 集合名（`index.ts` 的 `SET_FIELDS` 反向表）。 */
const HUB_FIELD_TO_SET = { caught: 'completed', pinned: 'pinned', alarm: 'alarmFish' } as const;
const HUB_MAX_CHANGES = 200;

// ---------------------------------------------------------------------------
// 端口
// ---------------------------------------------------------------------------

/** 本地副本读数。`revision` 是不透明 CAS 令牌，由本地适配器定义（例如内容哈希/计数器）。 */
export interface LocalReplica {
  /** Receipt of the last successful CAS write, required to recover a lost write response. */
  readonly operationId?: string;
  readonly document: FishDocument;
  readonly revisions: Readonly<Record<string, number>>;
  readonly revision: string;
}

export interface LocalWriteInput {
  readonly operationId: string;
  readonly document: FishDocument;
  /** 本次真正改动的键（含净零翻转），供本地适配器推进字段修订号。 */
  readonly touched: readonly string[];
  readonly expectedRevision: string;
}

export interface LocalWriteResult {
  readonly revision: string;
  readonly revisions: Readonly<Record<string, number>>;
}

/** 本地存储端口。`write` 必须是 CAS：令牌不匹配时必须失败，绝不无条件覆盖。 */
export interface LocalPort {
  read(): Promise<LocalReplica>;
  write(input: LocalWriteInput): Promise<LocalWriteResult>;
}

/** WebDAV 端口（在端口实现里持有凭证闭包；协调器看不到用户名/密码）。 */
export interface DavPort {
  readPair(): Promise<DavPair>;
  resume(pair: DavPair): Promise<DavPair>;
  commit(document: FishDocument, region: SyncRegion, expected: DavPair, touched: ReadonlySet<string>, transactionId: string): Promise<DavPair>;
}

export interface HubField {
  readonly fishId: number;
  readonly field: 'caught' | 'pinned' | 'alarm';
  readonly value: boolean;
  readonly revision: number;
}

export interface HubChange {
  readonly fishId: number;
  readonly field: 'caught' | 'pinned' | 'alarm';
  readonly value: boolean;
  readonly expectedRevision: number;
}

export interface HubSnapshot {
  readonly region: SyncRegion;
  readonly watermark: number;
  readonly fields: readonly HubField[];
}

export interface HubPreviewToken {
  readonly token: string;
  readonly watermark: number;
  readonly expiresAt: number;
}

export interface HubApplyResult {
  readonly applied: number;
  readonly replayed: boolean;
}

/** Hub 端口（在端口实现里持有设备 Token 闭包；预览令牌是短时能力，仅存于加密检查点）。 */
export interface HubPort {
  snapshot(region: SyncRegion): Promise<HubSnapshot>;
  preview(region: SyncRegion, changes: readonly HubChange[]): Promise<HubPreviewToken>;
  apply(input: { readonly token: string; readonly operationId: string }): Promise<HubApplyResult>;
}

export type PendingStage = 'planned' | 'dav-committed' | 'hub-applied';

export interface ArchivedOperation {
  readonly operationId: string;
  readonly archivedAt: number;
  readonly region: SyncRegion;
  readonly document: FishDocument;
  readonly touched: readonly string[];
  readonly hubChanges: readonly HubChange[];
  readonly stage: PendingStage;
  readonly blockedReason: string | null;
}

/**
 * 耐久检查点存储端口。默认实现把内容加密存进本机保险箱（见 `createVaultCheckpointStore`）。
 * `read` 返回 `unknown`：协调器自己校验结构，损坏的检查点会被当成「不可用」而不是「不存在」。
 */
export interface CheckpointStore {
  read(profile: VaultProfile): Promise<unknown>;
  write(profile: VaultProfile, checkpoint: SyncCheckpoint): Promise<void>;
  archive(profile: VaultProfile, entry: ArchivedOperation): Promise<void>;
  clear(profile: VaultProfile): Promise<void>;
}

export interface ProfileLockPort {
  /** 取得该档案的独占锁；已被占用时抛 `CoordinatorError('lock-busy')`。返回释放函数。 */
  acquire(profileId: string): Promise<() => Promise<void>>;
}

// ---------------------------------------------------------------------------
// 检查点结构（落盘的形状，必须严格校验）
// ---------------------------------------------------------------------------

const revisionMapSchema = z.record(z.string().min(1).max(200),z.number().int().nonnegative());
const hubChangeSchema = z
  .object({
    fishId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    field: z.enum(['caught','pinned','alarm']),
    value: z.boolean(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

export const baselineStateSchema = z
  .object({
    document: fishDocumentSchema,
    revisions: z.object({local: revisionMapSchema,webdav: revisionMapSchema,hub: revisionMapSchema}).strict(),
    localRevision: z.string().min(1).max(4096),
    davFishEtag: z.string().max(1024).nullable(),
    davSidecarEtag: z.string().max(1024).nullable(),
    davDocumentHash: z.string().max(128).nullable(),
    hubWatermark: z.number().int().nonnegative(),
    syncedAt: z.number().int().nonnegative(),
  })
  .strict();
export type BaselineState = z.infer<typeof baselineStateSchema>;

const expectedStateSchema = z
  .object({
    localRevision: z.string().min(1).max(4096),
    davFishEtag: z.string().max(1024).nullable(),
    davSidecarEtag: z.string().max(1024).nullable(),
    davDocumentHash: z.string().max(128).nullable(),
    hubWatermark: z.number().int().nonnegative(),
    hubFields: z.array(z.object({fishId:z.number().int().positive(),field:z.enum(['caught','pinned','alarm']),value:z.boolean(),revision:z.number().int().positive()}).strict()).max(15000),
  })
  .strict();
export type ExpectedState = z.infer<typeof expectedStateSchema>;

export const pendingOperationSchema = z
  .object({
    operationId: z.uuid(),
    startedAt: z.number().int().nonnegative(),
    region: regionSchema,
    document: fishDocumentSchema,
    touched: z.array(z.string().min(1).max(200)).max(30_000),
    hubChanges: z.array(hubChangeSchema).max(HUB_MAX_CHANGES),
    hubPreview: z
      .object({
        token: z.uuid(),
        watermark: z.number().int().nonnegative(),
        expiresAt: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    expected: expectedStateSchema,
    stage: z.enum(['planned','dav-committed','hub-applied']),
    dav: z
      .object({
        fishEtag: z.string().max(1024).nullable(),
        sidecarEtag: z.string().max(1024).nullable(),
        documentHash: z.string().max(128),
      })
      .strict()
      .nullable(),
    hub: z
      .object({
        applied: z.number().int().nonnegative(),
        replayed: z.boolean(),
        watermark: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    blockedReason: z.string().max(500).nullable(),
  })
  .strict();
export type PendingOperation = z.infer<typeof pendingOperationSchema>;

export const syncCheckpointSchema = z
  .object({
    v: z.literal(2),
    profileId: z.uuid(),
    baseline: baselineStateSchema.nullable(),
    pending: pendingOperationSchema.nullable(),
  })
  .strict();
export type SyncCheckpoint = z.infer<typeof syncCheckpointSchema>;

const archiveRecordSchema = z
  .object({
    v: z.literal(1),
    entries: z
      .array(
        z
          .object({
            operationId: z.uuid(),
            archivedAt: z.number().int().nonnegative(),
            region: regionSchema,
            document: fishDocumentSchema,
            touched: z.array(z.string().max(200)).max(30_000),
            hubChanges: z.array(hubChangeSchema).max(HUB_MAX_CHANGES),
            stage: z.enum(['planned','dav-committed','hub-applied']),
            blockedReason: z.string().max(500).nullable(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
const MAX_ARCHIVED = 10;

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export type CoordinatorErrorCode =
  | 'lock-busy'
  | 'checkpoint-unavailable'
  | 'pending-operation'
  | 'no-pending-operation'
  | 'operation-mismatch'
  | 'plan-too-large'
  | 'stale-preview'
  | 'preview-expired'
  | 'dav-conflict'
  | 'local-conflict'
  | 'blocked';

/** 所有协调器失败都是显式错误：不返回「看起来成功」的结果。 */
export class CoordinatorError extends Error {
  readonly code: CoordinatorErrorCode;
  readonly operationId: string | null;

  constructor(code: CoordinatorErrorCode,message: string,operationId: string | null = null) {
    super(message);
    this.name = 'CoordinatorError';
    this.code = code;
    this.operationId = operationId;
  }
}

// ---------------------------------------------------------------------------
// 计划与结果
// ---------------------------------------------------------------------------

export interface SyncPlan {
  readonly profileId: string;
  readonly operationId: string;
  readonly region: SyncRegion;
  readonly document: FishDocument;
  readonly changedKeys: readonly string[];
  readonly touchedKeys: readonly string[];
  readonly hubChanges: readonly HubChange[];
  readonly hubPreview: HubPreviewToken|null;
  readonly expected: ExpectedState;
  readonly previewedAt: number;
}

export type PreviewResult =
  | { readonly state: 'conflict'; readonly conflicts: readonly MergeConflict[] }
  | { readonly state: 'ready'; readonly plan: SyncPlan };

export interface SyncOutcome {
  readonly operationId: string;
  readonly document: FishDocument;
  readonly appliedHubChanges: number;
  readonly replayedHubApply: boolean;
  readonly syncedAt: number;
}

export interface PendingSummary {
  readonly operationId: string;
  readonly stage: PendingStage;
  readonly region: SyncRegion;
  readonly startedAt: number;
  readonly hubChangeCount: number;
  readonly blockedReason: string|null;
}

export interface CoordinatorPorts {
  readonly local: LocalPort;
  readonly dav: DavPort;
  readonly hub: HubPort;
  readonly checkpoints: CheckpointStore;
  readonly lock: ProfileLockPort;
  readonly now?: () => number;
  readonly newId?: () => string;
}

export interface SyncCoordinator {
  preview(request: { profile: VaultProfile; resolutions?: Readonly<Record<string, Replica|'baseline'>> }): Promise<PreviewResult>;
  apply(request: { profile: VaultProfile; plan: SyncPlan }): Promise<SyncOutcome>;
  recover(request: { profile: VaultProfile }): Promise<{ status: 'idle' }|{ status: 'completed'; outcome: SyncOutcome }>;
  status(profile: VaultProfile): Promise<PendingSummary|null>;
  resolvePending(request: { profile: VaultProfile; operationId: string; mode: 'archive'|'discard' }): Promise<{ status: 'archived'|'discarded' }>;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const sameDocument = (left: FishDocument|null,right: FishDocument|null): boolean =>
  left !== null && right !== null && canonicalJson(left) === canonicalJson(right);

function hubRevisionsOf(snapshot: HubSnapshot): Record<string, number> {
  const revisions: Record<string, number> = {};
  for (const field of snapshot.fields) {
    revisions[`${HUB_FIELD_TO_SET[field.field]}:${String(field.fishId)}`] = field.revision;
  }
  return revisions;
}

function hubHasChanges(snapshot: HubSnapshot,changes: readonly HubChange[]): boolean {
  const index = new Map(snapshot.fields.map((field) => [`${String(field.fishId)}:${field.field}`,field]));
  return changes.every((change) => {
    const row = index.get(`${String(change.fishId)}:${change.field}`);
    return row !== undefined && row.value === change.value && row.revision === change.expectedRevision + 1;
  });
}

const toSet = (values: readonly string[]): ReadonlySet<string> => new Set(values);

// ---------------------------------------------------------------------------
// 端口默认实现：进程内锁 + 保险箱检查点存储
// ---------------------------------------------------------------------------

/**
 * 进程内（同一标签页/同一 JS 上下文）的按档案独占锁。
 * **限制**：它不跨标签页。跨标签页互斥需要 Web Locks（`navigator.locks`）等外部互斥，
 * 尚未接入；在接入之前不要把本协调器说成「多标签页安全的自动同步」。
 */
export function createInMemoryProfileLock(): ProfileLockPort {
  const held = new Set<string>();
  return {
    // 刻意不是 async：「检查 + 占用」必须在同一 tick 内完成，否则并发调用会同时通过检查。
    acquire: (profileId) => {
      if (held.has(profileId)) {
        return Promise.reject(new CoordinatorError('lock-busy','该档案已有同步操作在进行中'));
      }
      held.add(profileId);
      return Promise.resolve(() => {
        held.delete(profileId);
        return Promise.resolve();
      });
    },
  };
}

/** 把加密保险箱当作检查点存储：内容以 `checkpoint`/`archive` 用途加密落盘。 */
export function createVaultCheckpointStore(vault: ClientVault): CheckpointStore {
  return {
    read: (profile) => vault.readRecord(profile,'checkpoint'),
    write: async (profile,checkpoint) => {
      await vault.writeRecord(profile,'checkpoint',checkpoint);
    },
    archive: async (profile,entry) => {
      const existing = await vault.readRecord(profile,'archive');
      let entries: unknown[] = [];
      if (existing !== null) {
        const parsed = archiveRecordSchema.safeParse(existing);
        // 归档记录损坏时不覆盖、不吞掉：直接报错，等人来处理。
        if (!parsed.success) throw new CoordinatorError('checkpoint-unavailable','归档记录损坏；已停止写入以保留现场');
        entries = parsed.data.entries;
      }
      const next = archiveRecordSchema.parse({
        v: 1,
        entries: [...entries,entry].slice(-MAX_ARCHIVED),
      });
      await vault.writeRecord(profile,'archive',next);
    },
    clear: async (profile) => {
      await vault.deleteRecord(profile,'checkpoint');
    },
  };
}

// ---------------------------------------------------------------------------
// 合并
// ---------------------------------------------------------------------------

interface MergeInputs {
  readonly baseline: BaselineState|null;
  readonly localDocument: FishDocument;
  readonly localRevisions: Readonly<Record<string, number>>;
  readonly davDocument: FishDocument|null;
  readonly davRevisions: Readonly<Record<string, number>>;
  readonly hubDocument: FishDocument;
  readonly hubRevisions: Readonly<Record<string, number>>;
  readonly resolutions: Readonly<Record<string, Replica|'baseline'>>;
}

interface MergeOutput {
  readonly document: FishDocument;
  readonly conflicts: MergeConflict[];
  readonly touched: { readonly local: ReadonlySet<string>; readonly webdav: ReadonlySet<string>; readonly hub: ReadonlySet<string> };
}

/**
 * 首次同步（没有基线）的合并：**缺位不算分歧**。
 *
 * 本地/DAV 的 fish.json 是「完整声明」（数组里没有就是 false），因此它们对并集里的每个键都有意见；
 * Hub 只对**确实存在行**的字段有意见。于是「本地有进度 + Hub 还是空工作空间」不会被
 * 误判成几千个冲突，而两个完整副本的真正分歧仍然要求逐键显式选择。
 */
function mergeFirstSync(inputs: MergeInputs): MergeOutput {
  const davPresent = inputs.davDocument !== null;
  const hubKeys = new Set(Object.keys(inputs.hubRevisions));
  const conflicts: MergeConflict[] = [];
  const touchedLocal = new Set<string>();
  const touchedDav = new Set<string>();
  const touchedHub = new Set<string>();
  const entries: [string, Json][] = [];

  const resolve = (key: string,opinions: Partial<Record<Replica, Json|undefined>>): Json|undefined => {
    const values = Object.values(opinions).filter((value) => value !== undefined);
    if (values.length === 0) {
      return undefined;
    }
    const unique = new Set(values.map((value) => canonicalJson(value)));
    if (unique.size === 1) {
      return values[0];
    }
    const resolution = inputs.resolutions[key];
    if (resolution !== undefined && resolution !== 'baseline' && Object.hasOwn(opinions,resolution)) {
      return opinions[resolution];
    }
    conflicts.push({ key,baseline: undefined,values: opinions });
    return undefined;
  };

  for (const set of FISH_SETS) {
    const pool = new Set<number>([
      ...inputs.localDocument[set],
      ...(inputs.davDocument?.[set] ?? []),
      ...inputs.hubDocument[set],
    ]);
    const selected: number[] = [];
    for (const fishId of [...pool].sort((left,right) => left - right)) {
      const key = `${set}:${String(fishId)}`;
      const opinions: Partial<Record<Replica, Json|undefined>> = { local: inputs.localDocument[set].includes(fishId) };
      if (davPresent) {
        opinions.webdav = inputs.davDocument?.[set].includes(fishId) ?? false;
      }
      if (hubKeys.has(key)) {
        opinions.hub = inputs.hubDocument[set].includes(fishId);
      }
      const value = resolve(key,opinions);
      // 首次同步没有基线：真正的「改动」由合并结果与各副本现状的差集表达
      // （`changedDocumentKeys(null, merged)`），这里不额外伪造 touched 标记。
      if (value === true) {
        selected.push(fishId);
      }
    }
    entries.push([set,selected]);
  }
  for (const key of new Set([...Object.keys(inputs.localDocument),...(inputs.davDocument === null ? [] : Object.keys(inputs.davDocument))])) {
    if ((FISH_SETS as readonly string[]).includes(key)) {
      continue;
    }
    const opinions: Partial<Record<Replica, Json|undefined>> = { local: inputs.localDocument[key] };
    if (davPresent) {
      opinions.webdav = inputs.davDocument?.[key];
    }
    const value = resolve(`extra:${key}`,opinions);
    if (value !== undefined) {
      entries.push([key,value]);
    }
  }
  return {
    document: fishDocumentSchema.parse(Object.fromEntries(entries)),
    conflicts,
    touched: { local: touchedLocal,webdav: touchedDav,hub: touchedHub },
  };
}

function mergeWithBaseline(inputs: MergeInputs,baseline: BaselineState): MergeOutput {
  const touchedLocal = touchedSince(baseline.revisions.local,inputs.localRevisions);
  const touchedDav = touchedSince(baseline.revisions.webdav,inputs.davRevisions);
  const touchedHub = touchedSince(baseline.revisions.hub,inputs.hubRevisions);
  const resolutions = new Map<string, Replica|'baseline'>(Object.entries(inputs.resolutions));
  const result = mergeFishDocuments({
    baseline: baseline.document,
    local: inputs.localDocument,
    webdav: inputs.davDocument ?? fieldsToDocument([]),
    hub: inputs.hubDocument,
    touched: { local: touchedLocal,webdav: touchedDav,hub: touchedHub },
    resolutions,
  });
  return { document: result.document,conflicts: result.conflicts,touched: { local: touchedLocal,webdav: touchedDav,hub: touchedHub } };
}

// ---------------------------------------------------------------------------
// 协调器
// ---------------------------------------------------------------------------

interface Reading {
  readonly local: LocalReplica;
  readonly pair: DavPair;
  readonly davRevisions: Readonly<Record<string, number>>;
  readonly hub: HubSnapshot;
}

export function createSyncCoordinator(ports: CoordinatorPorts): SyncCoordinator {
  const now = ports.now ?? (() => Date.now());
  const newId = ports.newId ?? (() => crypto.randomUUID());
  const previews = new Map<string,{scope:string;plan:string}>();

  const withLock = async <T>(profileId: string,task: () => Promise<T>): Promise<T> => {
    const release = await ports.lock.acquire(profileId);
    try {
      return await task();
    } finally {
      await release();
    }
  };

  /** 读取检查点。损坏/无法解密 = 显式失败，绝不当成「没有检查点」继续跑。 */
  const readCheckpoint = async (profile: VaultProfile): Promise<SyncCheckpoint|null> => {
    let raw: unknown;
    try {
      raw = await ports.checkpoints.read(profile);
    } catch (cause) {
      throw new CoordinatorError('checkpoint-unavailable',cause instanceof Error ? cause.message : '本机检查点不可用');
    }
    if (raw === null || raw === undefined) {
      return null;
    }
    const parsed = syncCheckpointSchema.safeParse(raw);
    if (!parsed.success || parsed.data.profileId !== profile.id) {
      throw new CoordinatorError('checkpoint-unavailable','本机检查点结构损坏或作用域不匹配；已停止同步以保留现场');
    }
    return parsed.data;
  };

  const writeCheckpoint = async (profile: VaultProfile,checkpoint: SyncCheckpoint): Promise<void> => {
    await ports.checkpoints.write(profile,checkpoint);
  };

  /** Reads never resume a remote transaction; only advance may recover our own durable intent. */
  const readDav = async (): Promise<DavPair> => {
    try {
      const pair = await ports.dav.readPair();
      return pair;
    } catch (cause) {
      if (cause instanceof DavConflict) {
        throw new CoordinatorError('dav-conflict',cause.message);
      }
      throw cause;
    }
  };

  const readAll = async (region: SyncRegion): Promise<Reading> => {
    const local = await ports.local.read();
    const pair = await readDav();
    const hub = await ports.hub.snapshot(region);
    if (hub.region !== region || (pair.metadata !== null && pair.metadata.region !== region)) {
      throw new CoordinatorError('dav-conflict','副本区服与当前档案不匹配');
    }
    return { local,pair,davRevisions: pair.metadata?.fieldRevisions ?? {},hub };
  };

  const buildPlan = async (
    profile: VaultProfile,
    reading: Reading,
    baseline: BaselineState|null,
    resolutions: Readonly<Record<string, Replica|'baseline'>>,
  ): Promise<PreviewResult> => {
    if (reading.pair.metadata?.state === 'prepared') throw new CoordinatorError('dav-conflict','WebDAV 有待恢复提交；预览不会写入，请先显式恢复原操作');
    const inputs: MergeInputs = {
      baseline,
      localDocument: reading.local.document,
      localRevisions: reading.local.revisions,
      davDocument: reading.pair.document,
      davRevisions: reading.davRevisions,
      hubDocument: fieldsToDocument(reading.hub.fields),
      hubRevisions: hubRevisionsOf(reading.hub),
      resolutions,
    };
    const merged = baseline === null ? mergeFirstSync(inputs) : mergeWithBaseline(inputs,baseline);
    if (merged.conflicts.length > 0) {
      return { state: 'conflict',conflicts: merged.conflicts };
    }
    const hubChanges = documentChanges(merged.document,reading.hub.fields);
    // 整批拒绝：绝不做「悄悄只导入一部分」。
    if (hubChanges.length > HUB_MAX_CHANGES) {
      throw new CoordinatorError('plan-too-large',`本轮最多 ${String(HUB_MAX_CHANGES)} 项字段变化（本次 ${String(hubChanges.length)} 项），请拆分后重试；不会部分写入`);
    }
    const changed = new Set<string>([
      ...changedDocumentKeys(baseline?.document ?? null,merged.document),
      ...merged.touched.local,
      ...merged.touched.webdav,
      ...merged.touched.hub,
    ]);
    let hubPreview: HubPreviewToken|null = null;
    if (hubChanges.length > 0) {
      try {
        hubPreview = await ports.hub.preview(profile.region,hubChanges);
        if (hubPreview.watermark !== reading.hub.watermark) throw new Error('Hub预览水位已变化');
      } catch (cause) {
        throw new CoordinatorError('stale-preview',cause instanceof Error ? cause.message : 'Hub 预览失败，请重新读取后再预览');
      }
    }
    return {
      state: 'ready',
      plan: {
        profileId: profile.id,
        operationId: newId(),
        region: profile.region,
        document: merged.document,
        changedKeys: [...changed].sort(),
        touchedKeys: [...changed].sort(),
        hubChanges,
        hubPreview,
        expected: {
          localRevision: reading.local.revision,
          davFishEtag: reading.pair.fish.etag,
          davSidecarEtag: reading.pair.sidecar.etag,
          davDocumentHash: reading.pair.document === null ? null : await documentHash(reading.pair.document),
          hubWatermark: reading.hub.watermark,
          hubFields: reading.hub.fields.map((field)=>({...field})),
        },
        previewedAt: now(),
      },
    };
  };

  /** 在副作用之前重校验：任何一侧与预览时不一致 → 停止，不写任何东西。 */
  const assertMatchesPlan = (reading: Reading,plan: SyncPlan): void => {
    const localHashMatches = reading.local.revision === plan.expected.localRevision;
    const davFishMatches = reading.pair.fish.etag === plan.expected.davFishEtag;
    const davSidecarMatches = reading.pair.sidecar.etag === plan.expected.davSidecarEtag;
    const hubMatches = reading.hub.watermark === plan.expected.hubWatermark;
    if (!localHashMatches || !davFishMatches || !davSidecarMatches || !hubMatches) {
      throw new CoordinatorError('stale-preview','预览期间本地、WebDAV 或 Hub 已发生变化，请重新预览；没有写入任何副本',plan.operationId);
    }
  };

  const davHasPlan = async (pair: DavPair,document: FishDocument): Promise<boolean> =>
    pair.document !== null && (await documentHash(pair.document)) === (await documentHash(document));

  const fieldsKey = (fields: readonly HubField[]): string => canonicalJson(
    [...fields].sort((a,b)=>a.fishId-b.fishId||a.field.localeCompare(b.field)).map((f)=>({...f})),
  );
  const projectedFields = (pending: PendingOperation): HubField[] => {
    const rows = new Map(pending.expected.hubFields.map((f)=>[`${f.fishId}:${f.field}`,f]));
    for (const c of pending.hubChanges) rows.set(`${c.fishId}:${c.field}`,{
      fishId:c.fishId,field:c.field,value:c.value,revision:c.expectedRevision+1,
    });
    return [...rows.values()];
  };

  /** Recovery proves operation identity and the complete Hub read set before further effects. */
  const advance = async (profile: VaultProfile,state: SyncCheckpoint,reading: Reading): Promise<SyncOutcome> => {
    const baseline = state.baseline;
    if (state.pending === null) throw new CoordinatorError('no-pending-operation','没有待处理的同步操作');
    let pending: PendingOperation = state.pending;
    const persist = async (): Promise<void> => writeCheckpoint(profile,{v:2,profileId:profile.id,baseline,pending});
    const block = async (reason: string): Promise<never> => {
      pending = {...pending,blockedReason:reason};
      await persist();
      throw new CoordinatorError('blocked',reason,pending.operationId);
    };
    if (pending.blockedReason !== null) throw new CoordinatorError('blocked',pending.blockedReason,pending.operationId);
    if (pending.region !== profile.region) await block('检查点区服与档案不符');
    if (pending.stage !== 'hub-applied' && reading.local.revision !== pending.expected.localRevision) {
      await block('本地在操作期间出现新改动；已保留待处理意图');
    }
    if (pending.stage === 'planned') {
      let pair = reading.pair;
      const ours = pair.metadata?.transactionId === pending.operationId;
      if (ours) {
        if (pair.metadata === null || !sameDocument(pair.metadata.document,pending.document)) await block('WebDAV事务意图不匹配');
        if (reading.hub.watermark !== pending.expected.hubWatermark) await block('Hub在DAV恢复前已变化');
        if (pair.metadata?.state === 'prepared') pair = await ports.dav.resume(pair);
      } else {
        const matches = pair.metadata?.state !== 'prepared' &&
          pair.fish.etag === pending.expected.davFishEtag && pair.sidecar.etag === pending.expected.davSidecarEtag &&
          (pair.document === null ? pending.expected.davDocumentHash === null : await documentHash(pair.document) === pending.expected.davDocumentHash);
        if (!matches || reading.hub.watermark !== pending.expected.hubWatermark) await block('WebDAV或Hub已被其他写入改变；请重新合并');
        try {
          pair = await ports.dav.commit(pending.document,pending.region,pair,toSet(pending.touched),pending.operationId);
        } catch (cause) {
          if (cause instanceof DavConflict) return block(cause.message);
          throw cause;
        }
      }
      if (!pair.sidecarFresh || pair.metadata?.transactionId !== pending.operationId || !(await davHasPlan(pair,pending.document))) {
        await block('WebDAV未形成属于本操作的一致提交');
      }
      pending = {...pending,stage:'dav-committed',dav:{fishEtag:pair.fish.etag,sidecarEtag:pair.sidecar.etag,documentHash:await documentHash(pending.document)}};
      await persist();
    }

    const assertDav = async (): Promise<DavPair> => {
      const pair = await readDav();
      if (!pair.sidecarFresh || pair.metadata?.transactionId !== pending.operationId ||
          pair.fish.etag !== pending.dav?.fishEtag || pair.sidecar.etag !== pending.dav?.sidecarEtag ||
          !(await davHasPlan(pair,pending.document))) await block('WebDAV在提交后出现新改动；已保留意图');
      return pair;
    };
    await assertDav();
    if (pending.stage === 'dav-committed') {
      const local = await ports.local.read();
      if (local.revision !== pending.expected.localRevision) await block('本地在Hub提交前已变化');
      const snapshot = await ports.hub.snapshot(pending.region);
      const expectedAfter = fieldsKey(projectedFields(pending));
      const before = snapshot.watermark === pending.expected.hubWatermark && fieldsKey(snapshot.fields) === fieldsKey(pending.expected.hubFields);
      const after = pending.hubChanges.length > 0 && fieldsKey(snapshot.fields) === expectedAfter;
      if (!before && !after) await block('Hub出现计划之外的改动；已保留待处理意图');
      let result: HubApplyResult = {applied:0,replayed:false};
      if (pending.hubChanges.length > 0) {
        const token = pending.hubPreview;
        if (token === null) return block('缺少Hub预览令牌');
        // Already committed operations may replay after expiration. Values alone never prove ownership.
        if (before && token.expiresAt <= now()) return block('Hub预览已过期；请重新预览');
        result = await ports.hub.apply({token:token.token,operationId:pending.operationId});
      }
      const finalHub = await ports.hub.snapshot(pending.region);
      if (fieldsKey(finalHub.fields) !== expectedAfter || !hubHasChanges(finalHub,pending.hubChanges)) await block('Hub提交后读集与计划不一致');
      pending = {...pending,stage:'hub-applied',hub:{...result,watermark:finalHub.watermark}};
      await persist();
    }

    const hubBeforeLocal = await ports.hub.snapshot(pending.region);
    if (hubBeforeLocal.watermark !== pending.hub?.watermark || fieldsKey(hubBeforeLocal.fields) !== fieldsKey(projectedFields(pending))) {
      await block('Hub在本地提交前出现新改动；已保留意图');
    }
    await assertDav();
    const local = await ports.local.read();
    if (local.revision !== pending.expected.localRevision &&
        !(local.operationId === pending.operationId && sameDocument(local.document,pending.document))) {
      await block('本地修订已变化且没有本操作回执；已保留意图');
    }
    if (!sameDocument(local.document,pending.document)) {
      await ports.local.write({operationId:pending.operationId,document:pending.document,touched:pending.touched,expectedRevision:pending.expected.localRevision});
    }
    const finalLocal = await ports.local.read();
    if (!sameDocument(finalLocal.document,pending.document) ||
        (finalLocal.revision !== pending.expected.localRevision && finalLocal.operationId !== pending.operationId)) await block('本地最终状态不匹配');
    const finalPair = await assertDav();
    const finalHub = await ports.hub.snapshot(pending.region);
    if (finalHub.watermark !== pending.hub?.watermark || fieldsKey(finalHub.fields) !== fieldsKey(projectedFields(pending))) await block('Hub最终状态已变化');
    const syncedAt = now();
    const nextBaseline: BaselineState = {
      document:pending.document,
      revisions:{local:{...finalLocal.revisions},webdav:{...finalPair.metadata?.fieldRevisions},hub:hubRevisionsOf(finalHub)},
      localRevision:finalLocal.revision,davFishEtag:finalPair.fish.etag,davSidecarEtag:finalPair.sidecar.etag,
      davDocumentHash:await documentHash(pending.document),hubWatermark:finalHub.watermark,syncedAt,
    };
    await writeCheckpoint(profile,{v:2,profileId:profile.id,baseline:nextBaseline,pending:null});
    return {operationId:pending.operationId,document:pending.document,appliedHubChanges:pending.hub?.applied??0,replayedHubApply:pending.hub?.replayed??false,syncedAt};
  };

  return {
    preview: async ({ profile,resolutions }) =>
      withLock(profile.id,async () => {
        const checkpoint = await readCheckpoint(profile);
        if (checkpoint?.pending != null) {
          throw new CoordinatorError('pending-operation',`存在未完成的同步操作（${checkpoint.pending.stage}），请先恢复或显式归档`,checkpoint.pending.operationId);
        }
        const reading = await readAll(profile.region);
        const result = await buildPlan(profile,reading,checkpoint?.baseline ?? null,resolutions ?? {});
        if(result.state==='ready'){
          if(previews.size>=30){const oldest=previews.keys().next().value;if(oldest!==undefined)previews.delete(oldest);}
          previews.set(result.plan.operationId,{scope:JSON.stringify(profile),plan:JSON.stringify(result.plan)});
        }
        return result;
      }),

    apply: async ({ profile,plan:inputPlan }) => {
      const plan=structuredClone(inputPlan);
      return withLock(profile.id,async () => {
        if (plan.profileId !== profile.id || plan.region !== profile.region) throw new CoordinatorError('stale-preview','计划不属于当前档案');
        const checkpoint = await readCheckpoint(profile);
        if (checkpoint?.pending != null) {
          if (checkpoint.pending.operationId !== plan.operationId) {
            throw new CoordinatorError('pending-operation','存在另一个未完成的同步操作，请先恢复或显式归档',checkpoint.pending.operationId);
          }
          // 同一 operationId：这是一次重试，走恢复路径而不是重新开始。
          const reading = await readAll(checkpoint.pending.region);
          return await advance(profile,checkpoint,reading);
        }
        if (plan.hubPreview !== null && plan.hubPreview.expiresAt <= now()) {
          throw new CoordinatorError('preview-expired','Hub 预览已过期，请重新预览；没有写入任何副本',plan.operationId);
        }
        const issued=previews.get(plan.operationId);
        if(issued?.scope!==JSON.stringify(profile)||issued.plan!==JSON.stringify(plan)){
          throw new CoordinatorError('stale-preview','计划已变化或不属于当前预览；请重新预览');
        }
        const reading = await readAll(plan.region);
        assertMatchesPlan(reading,plan);
        // 计划先落盘，再执行任何副作用。
        const pending: PendingOperation = {
          operationId: plan.operationId,
          startedAt: now(),
          region: plan.region,
          document: plan.document,
          touched: [...plan.touchedKeys],
          hubChanges: plan.hubChanges.map((change) => ({ ...change })),
          hubPreview: plan.hubPreview,
          expected: plan.expected,
          stage: 'planned',
          dav: null,
          hub: null,
          blockedReason: null,
        };
        pendingOperationSchema.parse(pending);
        const state: SyncCheckpoint = { v: 2,profileId: profile.id,baseline: checkpoint?.baseline ?? null,pending };
        await writeCheckpoint(profile,state);
        return await advance(profile,state,reading);
      });
    },

    recover: async ({ profile }) =>
      withLock(profile.id,async () => {
        const checkpoint = await readCheckpoint(profile);
        if (checkpoint?.pending == null) {
          return { status: 'idle' as const };
        }
        if (checkpoint.pending.blockedReason !== null) {
          throw new CoordinatorError('blocked',checkpoint.pending.blockedReason,checkpoint.pending.operationId);
        }
        // 恢复一律重读重校验：不信任任何内存里的旧读数。
        const reading = await readAll(checkpoint.pending.region);
        const outcome = await advance(profile,checkpoint,reading);
        return { status: 'completed' as const,outcome };
      }),

    status: async (profile) => {
      const checkpoint = await readCheckpoint(profile);
      const pending = checkpoint?.pending ?? null;
      if (pending === null) {
        return null;
      }
      return {
        operationId: pending.operationId,
        stage: pending.stage,
        region: pending.region,
        startedAt: pending.startedAt,
        hubChangeCount: pending.hubChanges.length,
        blockedReason: pending.blockedReason,
      };
    },

    resolvePending: async ({ profile,operationId,mode }) =>
      withLock(profile.id,async () => {
        const checkpoint = await readCheckpoint(profile);
        const pending = checkpoint?.pending ?? null;
        if (pending === null) {
          throw new CoordinatorError('no-pending-operation','当前没有待处理的同步操作');
        }
        // 只有调用方明确给出、且与现场一致的 operationId 才能处置：避免误删别人的意图。
        if (pending.operationId !== operationId) {
          throw new CoordinatorError('operation-mismatch','operationId 与当前待处理操作不一致；检查点未被修改',pending.operationId);
        }
        if (mode === 'archive') {
          await ports.checkpoints.archive(profile,{
            operationId: pending.operationId,
            archivedAt: now(),
            region: pending.region,
            document: pending.document,
            touched: pending.touched,
            hubChanges: pending.hubChanges,
            stage: pending.stage,
            blockedReason: pending.blockedReason,
          });
        }
        await writeCheckpoint(profile,{ v: 2,profileId: profile.id,baseline: checkpoint?.baseline ?? null,pending: null });
        return { status: mode === 'archive' ? ('archived' as const) : ('discarded' as const) };
      }),
  };
}

/** 便于测试/适配：把共享层的 `SyncField` 归一成 Hub 端口使用的读数。 */
export function hubFieldsFromSyncFields(fields: readonly SyncField[]): HubField[] {
  return fields.map((field) => ({ fishId: field.fishId,field: field.field,value: field.value,revision: field.revision }));
}
