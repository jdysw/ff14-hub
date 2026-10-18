/**
 * 受信的「本机 WebDAV 档案」面板（06B）。
 *
 * 位置与边界（刻意的）：
 * - 它渲染在 `SyncPanel` **下方**、`WidgetHost` 与模块数据端口**之外**：组件拿不到设备 Token、
 *   拿不到任意 API 路径，也不通过 `ModuleDataPort`——它只调用受信 API `GET /api/v1/me/profile`
 *   取得当前会话的工作空间标识，然后用本机保险箱存取 DAV 凭证。
 * - 会话作用域**只来自受信 API**：不接受 URL/组件传入的 workspace id。凭证列表按
 *   「工作空间 + 当前站点源 + 区服」过滤，因此切换会话后不会看到上一个工作空间的档案。
 * - 本阶段**不发起任何 WebDAV 网络请求**：只做本机加密保管、列出元数据、校验可解密与删除；
 *   真实 DAV 读写仍由 06A 的独立客户端在后续阶段接入。
 * - 设备 Token 始终只在会话内存中：本面板不读取、不写入、不显示它。
 * - 口令输入在保存成功后立即清空；表单有内容时登记为私有草稿，避免 Service Worker 更新丢输入。
 */
import { useCallback,useEffect,useMemo,useRef,useState } from 'react';
import {
  createClientVault,
  createIndexedDbVaultStorage,
  normalizeProfile,
  type ClientVault,
  type VaultProfile,
  type VaultRegion,
} from '@ff14-hub/fish-sync/vault';
import type { WorkspaceProfile } from '@ff14-hub/shared';
import type { ApiResult } from '../../lib/api-client';
import { registerPrivateDraftSource } from '../pwa/draft-registry';

const REGION_LABELS: Readonly<Record<VaultRegion,string>> = { cn: '国服',global: '国际服' };
const REGIONS: readonly VaultRegion[] = ['cn','global'];

let sharedVault: ClientVault|null = null;
/** 默认保险箱：整个页面共用一个 IndexedDB 连接（避免多标签/多实例重复打开）。 */
function defaultVault(): ClientVault {
  sharedVault ??= createClientVault(createIndexedDbVaultStorage());
  return sharedVault;
}

interface FormState {
  name: string;
  davBaseUrl: string;
  username: string;
  password: string;
}

const EMPTY_FORM: FormState = { name: '',davBaseUrl: '',username: '',password: '' };
const isDirty = (form: FormState): boolean =>
  form.name !== '' || form.davBaseUrl !== '' || form.username !== '' || form.password !== '';

export interface ClientVaultPanelProps {
  /** 受信档案读取入口（`GET /api/v1/me/profile`，由会话凭证装配）。 */
  readonly readProfile: () => Promise<ApiResult<WorkspaceProfile>>;
  /** 便于测试注入；默认使用真实 IndexedDB。 */
  readonly vault?: ClientVault;
  /** 视图是否可见：不可见时暂停读取，但草稿与列表保留。 */
  readonly active?: boolean;
}

export function ClientVaultPanel({ readProfile,vault,active = true }: ClientVaultPanelProps) {
  const client = useMemo(() => vault ?? defaultVault(),[vault]);
  const [workspaceId,setWorkspaceId] = useState<string|null>(null);
  const [region,setRegion] = useState<VaultRegion>('cn');
  const [profiles,setProfiles] = useState<VaultProfile[]>([]);
  const [form,setForm] = useState<FormState>(EMPTY_FORM);
  const [notice,setNotice] = useState<string|null>(null);
  const [error,setError] = useState<string|null>(null);
  const [verified,setVerified] = useState<Readonly<Record<string,string>>>({});
  const [confirmDelete,setConfirmDelete] = useState(false);
  const [busy,setBusy] = useState(false);
  const [refreshKey,setRefreshKey] = useState(0);
  const alive = useRef(true);
  const dirty = isDirty(form);
  /** 最近一次已发布的作用域：会话/区服变化时绝不用旧作用域的结果覆盖新状态。 */
  const scope = workspaceId === null ? null : `${workspaceId}|${window.location.origin}|${region}`;
  const publishedScope = useRef<string|null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => registerPrivateDraftSource(() => dirty), [dirty]);

  const refresh = useCallback(async (workspace: string,nextRegion: VaultRegion): Promise<void> => {
    const rows = await client.listProfiles({ workspaceId: workspace,hubOrigin: window.location.origin,region: nextRegion });
    const target = `${workspace}|${window.location.origin}|${nextRegion}`;
    if (!alive.current || publishedScope.current !== target) {
      return;
    }
    setProfiles(rows);
  },[client]);

  useEffect(() => {
    if (!active || workspaceId !== null) {
      return;
    }
    let cancelled = false;
    void (async () => {
      let result: ApiResult<WorkspaceProfile>;
      try { result = await readProfile(); }
      catch {
        if (!cancelled && alive.current) setError('当前会话档案读取失败，请切换页面重试');
        return;
      }
      if (cancelled || !alive.current) {
        return;
      }
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      const trustedRegion: VaultRegion = result.data.region === 'global' ? 'global' : 'cn';
      setWorkspaceId(result.data.id);
      setRegion(trustedRegion);
      publishedScope.current = `${result.data.id}|${window.location.origin}|${trustedRegion}`;
    })();
    return () => {
      cancelled = true;
    };
  }, [active,readProfile,workspaceId]);

  useEffect(() => {
    if (!active || workspaceId === null) {
      return;
    }
    const target = `${workspaceId}|${window.location.origin}|${region}`;
    publishedScope.current = target;
    void (async () => {
      try {
        await refresh(workspaceId,region);
      } catch (cause) {
        if (alive.current && publishedScope.current === target) {
          setError(cause instanceof Error ? cause.message : '本机档案读取失败');
        }
      }
    })();
  }, [active,workspaceId,region,refreshKey,refresh]);

  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      if (alive.current) {
        setError(cause instanceof Error ? cause.message : '本机档案操作失败');
      }
    } finally {
      if (alive.current) {
        setBusy(false);
      }
    }
  },[busy]);

  const save = (): void => {
    void run(async () => {
      if (workspaceId === null) {
        throw new Error('尚未取得工作空间标识，请稍后重试');
      }
      const hubOrigin = window.location.origin;
      // 先规范化（同时校验 Hub/WebDAV 地址），再决定这是新建还是覆盖同名同址档案。
      const candidate = normalizeProfile({
        id: crypto.randomUUID(),
        workspaceId,
        hubOrigin,
        davBaseUrl: form.davBaseUrl,
        region,
        name: form.name,
      });
      const existing = profiles.find(
        (item) => item.name === candidate.name && item.region === candidate.region && item.davBaseUrl === candidate.davBaseUrl,
      );
      const profile: VaultProfile = existing === undefined ? candidate : { ...candidate,id: existing.id };
      await client.saveCredentials(profile,{ username: form.username,password: form.password });
      if (!alive.current) {
        return;
      }
      // 保存成功后立即清空口令输入，且**从不回显**它。
      setForm((current) => ({ ...current,password: '' }));
      setNotice(existing === undefined ? '已在本机加密保存该档案（未上传任何服务器）。' : '已更新本机加密档案。');
      await refresh(workspaceId,region);
    });
  };

  const verify = (profile: VaultProfile): void => {
    void run(async () => {
      const credentials = await client.readCredentials(profile);
      if (credentials === null) {
        throw new Error('该档案在本机没有可解密的凭证记录');
      }
      if (!alive.current) {
        return;
      }
      setVerified((current) => ({ ...current,[profile.id]: '可解密（仅校验，未显示口令）' }));
      setNotice(`档案「${profile.name}」的本机记录可以解密。`);
    });
  };

  const remove = (profile: VaultProfile): void => {
    void run(async () => {
      await client.removeProfile(profile);
      if (!alive.current || workspaceId === null) {
        return;
      }
      setVerified((current) => {
        const next = { ...current };
        delete next[profile.id];
        return next;
      });
      setNotice(`已删除本机档案「${profile.name}」的凭证、检查点与归档记录。`);
      await refresh(workspaceId,region);
    });
  };

  return (
    <section className="fishing-panel" aria-label="本机 WebDAV 档案">
      <header className="fishing-header">
        <h2>本机 WebDAV 档案</h2>
        <button disabled={busy || workspaceId === null} onClick={() => { setRefreshKey((value) => value + 1); }} type="button">
          刷新本机档案
        </button>
      </header>
      <p>
        本阶段只在本机保存 WebDAV 配置：口令用 WebCrypto AES-GCM 加密后写入浏览器 IndexedDB，
        加密密钥不可导出；本页不会发起任何 WebDAV 网络请求，也不会把 DAV 地址、账号或口令发送给 Hub。
      </p>
      <p>Hub 设备令牌只保存在会话内存中，不写入本机保险箱，也不会出现在这里。</p>
      {workspaceId === null ? <p role="status">正在通过受信接口读取当前会话的工作空间标识…</p> : null}
      {error !== null ? <p role="alert">{error}</p> : null}
      {notice !== null ? <p className="notice notice--ok" role="status">{notice}</p> : null}

      <label>
        档案区服
        <select value={region} disabled={busy} onChange={(event) => { setRegion(event.target.value === 'global' ? 'global' : 'cn'); }}>
          {REGIONS.map((value) => <option key={value} value={value}>{REGION_LABELS[value]}</option>)}
        </select>
      </label>
      <label>
        档案名称
        <input maxLength={80} value={form.name} disabled={busy} onChange={(event) => { setForm((current) => ({ ...current,name: event.target.value })); }} />
      </label>
      <label>
        WebDAV 地址（HTTPS，且不能与本站同源）
        <input maxLength={2048} placeholder="https://dav.example.com/remote.php/dav/files/user/" value={form.davBaseUrl} disabled={busy}
          onChange={(event) => { setForm((current) => ({ ...current,davBaseUrl: event.target.value })); }} />
      </label>
      <label>
        WebDAV 用户名
        <input maxLength={500} autoComplete="off" value={form.username} disabled={busy}
          onChange={(event) => { setForm((current) => ({ ...current,username: event.target.value })); }} />
      </label>
      <label>
        WebDAV 口令（保存后立即清空输入框）
        <input type="password" maxLength={2000} autoComplete="new-password" value={form.password} disabled={busy}
          onChange={(event) => { setForm((current) => ({ ...current,password: event.target.value })); }} />
      </label>
      <div className="fishing-actions">
        <button disabled={busy || workspaceId === null || form.name.trim() === '' || form.davBaseUrl === ''} onClick={save} type="button">加密保存到本机</button>
        <button disabled={busy || !dirty} onClick={() => { setForm(EMPTY_FORM); setNotice('已清空表单（本机记录未改动）。'); }} type="button">清空表单</button>
      </div>

      <h3>本机已保存的档案（{REGION_LABELS[region]}）</h3>
      {profiles.filter((profile)=>profile.region===region).length === 0 ? <p>本机没有该区服的档案。</p> : (
        <ul>
          {profiles.filter((profile)=>profile.region===region).map((profile) => (
            <li key={profile.id}>
              <span>{profile.name}</span> · <span>{REGION_LABELS[profile.region]}</span> · <code>{profile.davBaseUrl}</code>
              {' '}
              <button disabled={busy} onClick={() => { verify(profile); }} type="button">校验可解密</button>
              <button disabled={busy || !confirmDelete} onClick={() => { remove(profile); }} type="button">删除本机档案</button>
              {verified[profile.id] !== undefined ? <span className="notice notice--ok" role="status">{verified[profile.id]}</span> : null}
            </li>
          ))}
        </ul>
      )}
      <label>
        <input type="checkbox" checked={confirmDelete} onChange={(event) => { setConfirmDelete(event.target.checked); }} />
        我已确认要删除本机档案（不会影响 Hub 与 WebDAV 上的数据）
      </label>
      {scope === null ? null : <p className="panel__muted">当前作用域：工作空间 {scope.split('|')[0]} · 源 {window.location.origin} · 区服 {REGION_LABELS[region]}</p>}
    </section>
  );
}
