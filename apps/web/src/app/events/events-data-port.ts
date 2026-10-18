/**
 * 活动模块的数据端口操作表（阶段 04 / HUB-011）。
 *
 * 与导航端口同理：组件只能按**声明的操作名**调用，拿不到 Token、URL、workspace 与 header。
 *
 * 为什么这一层必须存在（边界，硬约束）：
 * - 设备 Token 只在端口层可见。它只进入 `Authorization` 头，**绝不**写进 URL、
 *   日志或抛出的错误消息（错误消息只由服务端已脱敏的 `message` 与本文件的固定文案组成）。
 * - 每个操作在发请求**之前**用共享 Schema 校验输入，在返回**之前**用共享 Schema 校验响应；
 *   校验失败一律抛错，绝不返回半可信数据（宁可让界面显示错误，也不显示错的数据）。
 * - 端口层**不做**任何本地缓存或乐观写入：离线时不能假装「已经保存到服务器」
 *   （ADR-0004 D10 / D11）。写入成功后由组件重新拉取列表。
 *
 * 幂等（ADR-0004 D11）：写操作的 `operationId` 由端口用 `crypto.randomUUID()` 生成，
 * 组件无权指定。端口把「上一次意图的指纹 → operationId」记在闭包里：
 * 同一意图重试（内容完全相同）复用同一个 ID，服务端据此判为重放而不是第二次写入；
 * 内容变了（指纹变了）就换新 ID，此时服务端若发现同一 ID 换意图会以 409 拒绝——这正是要的。
 */
import {
  API_V1_PREFIX,
  EVENTS_UPCOMING_PHASE_FILTERS,
  apiErrorBodySchema,
  createWorkspaceEventRequestSchema,
  deleteWorkspaceEventRequestSchema,
  eventListResponseSchema,
  eventRegionSchema,
  publicEventListResponseSchema,
  syncConflictSchema,
  updateWorkspaceEventRequestSchema,
  type ApiErrorCode,
  type EventListResponse,
  type PublicEventListResponse,
  type SyncConflict,
} from '@ff14-hub/shared';
import { z } from 'zod';
import { NETWORK_FAILURE_STATUS, buildApiUrl, normalizeApiError } from '../../lib/api-client';
import type { ModulePortContext, ModulePortFactory } from '../widgets/module-data-ports';

/** 个人活动的路径前缀（`GET/POST` 列表，`PATCH/DELETE` 单条）。 */
const ME_EVENTS_PATH = `${API_V1_PREFIX}/me/events`;
/** 公共来源活动（匿名只读，本阶段为空表）。 */
const PUBLIC_EVENTS_PATH = `${API_V1_PREFIX}/events`;

/**
 * 本模块允许的操作名。键名是**契约**：组件只能引用这里的常量，避免两处各写一遍字符串。
 * 未在此列出的操作名一律被 `createModuleDataPort` 拒绝（连请求都不会发出）。
 */
export const EVENTS_PORT_OPERATIONS = {
  listPersonal: 'events.listPersonal',
  listPublic: 'events.listPublic',
  create: 'events.create',
  update: 'events.update',
  delete: 'events.delete',
} as const;

export type EventsPortOperation = (typeof EVENTS_PORT_OPERATIONS)[keyof typeof EVENTS_PORT_OPERATIONS];

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 网络层失败（连响应都没拿到）时使用的错误码；与 `api-client` 的约定一致。 */
export const EVENTS_NETWORK_ERROR_CODE = 'network_error' as const;

/**
 * 端口抛出的错误。
 *
 * 为什么要有自己的错误类型：组件需要**程序化**地处理冲突（「服务器上是 revision N，
 * 你基于 M」），而不是解析 message 文案。`details` 原样保留服务端给的结构化细节，
 * `conflict` 是按共享 `syncConflictSchema` 解析出来的冲突（解析不了时为 null，绝不猜）。
 */
export class EventsPortError extends Error {
  /** HTTP 状态码；网络层失败为 `NETWORK_FAILURE_STATUS`（0）。 */
  readonly status: number;
  readonly code: ApiErrorCode | typeof EVENTS_NETWORK_ERROR_CODE;
  /** 服务端 `details`（契约保证可安全回显）；无则为 null。 */
  readonly details: unknown;
  /** 解析成功时的结构化冲突，否则 null。 */
  readonly conflict: SyncConflict | null;

  constructor(
    message: string,
    status: number,
    code: ApiErrorCode | typeof EVENTS_NETWORK_ERROR_CODE,
    details: unknown,
    conflict: SyncConflict | null,
  ) {
    super(message);
    this.name = 'EventsPortError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.conflict = conflict;
  }
}

function textOfRevision(value: number | null): string {
  return value === null ? '未知' : String(value);
}

/**
 * 把结构化冲突转成可读中文（唯一实现：端口用它做错误消息，组件用它做界面提示）。
 * 只使用共享枚举里的 `reason`，因此服务端新增原因是可发现的（落到兜底文案而不是猜）。
 */
export function describeEventConflict(conflict: SyncConflict): string {
  if (conflict.reason === 'revision_conflict') {
    return (
      `服务器上是 revision ${textOfRevision(conflict.currentRevision)}，` +
      `你基于 ${textOfRevision(conflict.baseRevision)}（并发冲突，请重新载入后再试）`
    );
  }
  if (conflict.reason === 'operation_payload_mismatch') {
    return '同一个操作 ID 已被用于不同内容，服务器已拒绝且未写入（请重新提交一次）。';
  }
  if (conflict.reason === 'entity_not_found') {
    return '该活动在服务器上已不存在（可能已被其他设备删除）。';
  }
  return '活动写入发生冲突，请重新载入后再试。';
}

/** 从响应体里取出结构化冲突：契约位置是 `details.conflict`（ADR-0004 D7）。 */
function conflictOf(details: unknown): SyncConflict | null {
  if (details === null || typeof details !== 'object') {
    return null;
  }
  const parsed = syncConflictSchema.safeParse((details as Record<string, unknown>)['conflict']);
  return parsed.success ? parsed.data : null;
}

/**
 * 把非 2xx 响应转成端口错误。
 * 复用 `api-client` 的 `normalizeApiError` 做兜底：**非契约形状**的响应体（例如中间层返回的
 * HTML 错误页）只会得到固定文案，绝不把原始文本回显成消息。
 */
function toPortError(status: number, payload: unknown): EventsPortError {
  const parsed = apiErrorBodySchema.safeParse(payload);
  const fallback = normalizeApiError(payload);
  const code: ApiErrorCode = parsed.success ? parsed.data.code : fallback.code;
  const message = parsed.success ? parsed.data.message : fallback.message;
  const details: unknown = parsed.success ? parsed.data.details ?? null : null;
  const conflict = conflictOf(details);
  return new EventsPortError(
    conflict === null ? `活动接口返回 ${String(status)}：${message}` : describeEventConflict(conflict),
    status,
    code,
    details,
    conflict,
  );
}

/**
 * 「没有 HTTP 状态码可用」时的占位值（与 `api-client` 的约定一致）。
 * 网络层失败与本地拒绝都用它：前者没有响应，后者根本没发请求；区分靠 `code`。
 */
const NO_HTTP_STATUS = NETWORK_FAILURE_STATUS;

/** 网络层失败：明确说「没拿到响应」，绝不伪装成空数据或成功。 */
function networkError(): EventsPortError {
  return new EventsPortError('网络请求失败，请检查网络后重试。', NO_HTTP_STATUS, EVENTS_NETWORK_ERROR_CODE, null, null);
}

/** 输入/响应不符合共享契约：只说「不合法」，不回显原始内容。 */
function contractError(detail: string): EventsPortError {
  return new EventsPortError(detail, NO_HTTP_STATUS, 'validation_failed', null, null);
}

// ---------------------------------------------------------------------------
// 输入校验与请求
// ---------------------------------------------------------------------------

/** 活动 ID 的形状与共享 `workspaceEventSchema.id` 一致（1..64）。 */
const eventIdSchema = z.string().min(1).max(64);

/** 列表筛选输入：与共享的 `filterEvents` 参数一致（`all` 表示不按阶段筛）。 */
const listFilterInputSchema = z
  .object({
    region: eventRegionSchema.nullable().optional(),
    phase: z.enum(EVENTS_UPCOMING_PHASE_FILTERS).nullable().optional(),
  })
  .strict();

/** 只按区服筛（公共列表没有个人活动的阶段概念）。 */
const publicListInputSchema = z.object({ region: eventRegionSchema.nullable().optional() }).strict();

/** 更新输入：`expectedRevision`（CAS 乐观锁）+ `patch`（至少一个字段）。 */
const updateInputSchema = z
  .object({
    id: eventIdSchema,
    expectedRevision: z.number().int().nonnegative(),
    patch: z.record(z.string(), z.unknown()),
  })
  .strict();

/** 删除输入：墓碑化 + CAS。 */
const deleteInputSchema = z
  .object({
    id: eventIdSchema,
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

/**
 * 去掉调用方传来的 `operationId`。
 *
 * 为什么必须去掉：幂等 ID 由端口生成，组件无权决定（否则组件可以拿别人的 ID 冒充重放）。
 * 非对象输入返回空对象，因此它会因「缺少必填字段」而被 Schema 拒绝——绝不把非法输入
 * 静默当成「空请求」放行。
 */
function withoutOperationId(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  const copy: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  delete copy['operationId'];
  return copy;
}

/**
 * 稳定的意图指纹：对象按键排序后再序列化，因此「同一个意图」无论键顺序如何都得到同一个
 * 字符串（键顺序若影响指纹，重试就会被误判成新意图而换掉 operationId）。
 */
function stableIntentText(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableIntentText(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const body = keys.map((key) => `${JSON.stringify(key) ?? '""'}:${stableIntentText(record[key])}`).join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 「上次意图指纹 → operationId」的闭包记忆（每个写操作一份，互不串用）。 */
interface IntentMemory {
  operationIdFor(fingerprint: string): string;
}

function createIntentMemory(): IntentMemory {
  let lastFingerprint: string | null = null;
  let lastOperationId = '';
  return {
    operationIdFor(fingerprint) {
      if (lastFingerprint !== fingerprint || lastOperationId === '') {
        lastFingerprint = fingerprint;
        lastOperationId = crypto.randomUUID();
      }
      return lastOperationId;
    },
  };
}

interface JsonRequest {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly query?: URLSearchParams;
  /** 有 body 时必须是**已校验**的纯数据（本文件里全部来自共享 Schema 的输出）。 */
  readonly body?: unknown;
}

/**
 * 发一个 JSON 请求并返回**未校验**的响应体（调用方必须自己用共享 Schema 校验）。
 *
 * - URL 由 `buildApiUrl` 拼接：只接受以 `/` 开头的路径，且 baseUrl 必须是空串或 http(s)，
 *   因此组件不可能借端口把请求打到任意主机。
 * - 401 先调用 `onUnauthorized`（让应用切回未登录态），再抛错；错误消息里不含凭证。
 */
async function requestJson(context: ModulePortContext, input: JsonRequest): Promise<unknown> {
  const queryString = input.query === undefined ? '' : input.query.toString();
  const url = buildApiUrl(queryString === '' ? input.path : `${input.path}?${queryString}`, context.apiBaseUrl);

  const headers = new Headers();
  // 凭证只走请求头。刻意不做「token 为空就跳过认证」的分支：那会让未认证请求看起来像
  // 已认证请求；诚实的做法是照常发送，由服务端返回 401。
  headers.set('Authorization', `Bearer ${context.token}`);
  headers.set('Content-Type', 'application/json');

  const init: RequestInit = { method: input.method, headers };
  if (input.body !== undefined) {
    init.body = JSON.stringify(input.body);
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw networkError();
  }

  const payload = await readJsonBody(response);

  if (!response.ok) {
    if (response.status === 401) {
      context.onUnauthorized?.();
    }
    throw toPortError(response.status, payload);
  }
  return payload;
}

/** 读取响应体；不是 JSON 时返回 undefined（绝不上抛原始文本）。 */
async function readJsonBody(response: Response): Promise<unknown> {
  try {
    const parsed: unknown = await response.json();
    return parsed;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 操作表
// ---------------------------------------------------------------------------

/**
 * 活动模块允许的操作。未列出的操作名一律被拒绝（由 `createModuleDataPort` 兜住）。
 *
 * 写操作**不解析响应体**：共享契约没有为写操作定义响应形状，猜一个形状只会制造假失败。
 * 界面在写入成功后重新拉取列表（列表响应有共享 Schema 校验），因此「看到的」永远是已校验数据。
 */
export const eventsModulePortFactory: ModulePortFactory = (context) => {
  const intents = {
    create: createIntentMemory(),
    update: createIntentMemory(),
    delete: createIntentMemory(),
  };

  return {
    [EVENTS_PORT_OPERATIONS.listPersonal]: async (input): Promise<EventListResponse> => {
      const filter = listFilterInputSchema.safeParse(input ?? {});
      if (!filter.success) {
        throw contractError('个人活动列表的筛选参数不合法，已在本地拒绝（未发出请求）。');
      }
      const query = new URLSearchParams();
      if (filter.data.region !== undefined && filter.data.region !== null) {
        query.set('region', filter.data.region);
      }
      if (filter.data.phase !== undefined && filter.data.phase !== null && filter.data.phase !== 'all') {
        query.set('phase', filter.data.phase);
      }
      const payload = await requestJson(context, { method: 'GET', path: ME_EVENTS_PATH, query });
      const parsed = eventListResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw contractError('个人活动列表的响应不符合共享契约，已丢弃（未返回半可信数据）。');
      }
      return parsed.data;
    },

    [EVENTS_PORT_OPERATIONS.listPublic]: async (input): Promise<PublicEventListResponse> => {
      const filter = publicListInputSchema.safeParse(input ?? {});
      if (!filter.success) {
        throw contractError('公共活动列表的筛选参数不合法，已在本地拒绝（未发出请求）。');
      }
      const query = new URLSearchParams();
      if (filter.data.region !== undefined && filter.data.region !== null) {
        query.set('region', filter.data.region);
      }
      const payload = await requestJson(context, { method: 'GET', path: PUBLIC_EVENTS_PATH, query });
      const parsed = publicEventListResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw contractError('公共活动列表的响应不符合共享契约，已丢弃（未返回半可信数据）。');
      }
      return parsed.data;
    },

    [EVENTS_PORT_OPERATIONS.create]: async (input): Promise<void> => {
      const candidate = withoutOperationId(input);
      const operationId = intents.create.operationIdFor(stableIntentText(candidate));
      // 共享 Schema 已经带了「区间必须合法」的 refine，因此这里用**完整** Schema 校验：
      // 注入端口生成的 operationId 后再 parse，等于校验「去掉 operationId 的部分」，
      // 同时又不会丢掉共享实现里的 refine（自己再写一份区间规则就会漂移）。
      const parsed = createWorkspaceEventRequestSchema.safeParse({ ...candidate, operationId });
      if (!parsed.success) {
        throw contractError('新建活动的请求不合法，已在本地拒绝（未发出请求）。');
      }
      await requestJson(context, { method: 'POST', path: ME_EVENTS_PATH, body: parsed.data });
    },

    [EVENTS_PORT_OPERATIONS.update]: async (input): Promise<void> => {
      const parsedInput = updateInputSchema.safeParse(input);
      if (!parsedInput.success) {
        throw contractError('更新活动的请求形状不合法，已在本地拒绝（未发出请求）。');
      }
      const patch = withoutOperationId(parsedInput.data.patch);
      const operationId = intents.update.operationIdFor(
        stableIntentText({
          kind: EVENTS_PORT_OPERATIONS.update,
          id: parsedInput.data.id,
          expectedRevision: parsedInput.data.expectedRevision,
          patch,
        }),
      );
      const parsed = updateWorkspaceEventRequestSchema.safeParse({
        ...patch,
        expectedRevision: parsedInput.data.expectedRevision,
        operationId,
      });
      if (!parsed.success) {
        throw contractError('更新活动的请求不合法，已在本地拒绝（未发出请求）。');
      }
      await requestJson(context, {
        method: 'PATCH',
        // ID 必须编码后再拼进路径：`/` 或 `..` 会改变目标端点（ID 的字符集另有 Schema 限制）。
        path: `${ME_EVENTS_PATH}/${encodeURIComponent(parsedInput.data.id)}`,
        body: parsed.data,
      });
    },

    [EVENTS_PORT_OPERATIONS.delete]: async (input): Promise<void> => {
      const parsedInput = deleteInputSchema.safeParse(input);
      if (!parsedInput.success) {
        throw contractError('删除活动的请求形状不合法，已在本地拒绝（未发出请求）。');
      }
      const operationId = intents.delete.operationIdFor(
        stableIntentText({
          kind: EVENTS_PORT_OPERATIONS.delete,
          id: parsedInput.data.id,
          expectedRevision: parsedInput.data.expectedRevision,
        }),
      );
      const parsed = deleteWorkspaceEventRequestSchema.safeParse({
        expectedRevision: parsedInput.data.expectedRevision,
        operationId,
      });
      if (!parsed.success) {
        throw contractError('删除活动的请求不合法，已在本地拒绝（未发出请求）。');
      }
      await requestJson(context, {
        method: 'DELETE',
        path: `${ME_EVENTS_PATH}/${encodeURIComponent(parsedInput.data.id)}`,
        body: parsed.data,
      });
    },
  };
};
