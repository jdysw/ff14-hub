function assertCalendarSaveResponse(response:Response):void{
  if(response.status===409){throw new Error('版本冲突：这条活动已被修改，请刷新列表后重试');}
  if(response.status===401||response.status===403){throw new Error('管理员身份不再有效');}
  if(!response.ok){throw new Error('服务器拒绝保存，请检查内容格式与必填字段');}
}
/** 国服活动后台：通过独立管理员密码＋TOTP 认证签发的临时会话授权，不使用玩家设备令牌。 */
import { eventCalendarItemSchema, type EventCalendarItem } from '@ff14-hub/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { chinaDateTime } from './public-calendar-utils';
import './calendar-admin.css';
import {useContentState} from '../admin/ContentLifecycle';
import {usePrivateDraft} from '../pwa/draft-registry';

type Mode = 'upsert' | 'hide' | 'restore';
interface EditRow {
  readonly id: string;
  readonly mode: Mode;
  readonly revision: number;
  readonly item: EventCalendarItem | null;
}
interface AdminList {
  readonly official: EventCalendarItem[];
  readonly edits: EditRow[];
}
interface AdminRecord {
  readonly id: string;
  readonly item: EventCalendarItem;
  readonly revision: number;
  readonly mode: Mode | 'official';
}
interface Draft {
  title: string; description: string; category: string; location: string;
  starts: string; ends: string; sourceUrl: string; allDay: boolean;
}
const EMPTY: Draft = {
  title: '', description: '', category: '人工维护', location: '',
  starts: '', ends: '', sourceUrl: '', allDay: false,
};
const CN_OFFSET_MS = 8 * 60 * 60_000;
function adminModeLabel(mode:Mode|'official'):string{
  if(mode==='hide')return '已隐藏';
  if(mode==='upsert')return '人工维护';
  return '公开';
}
function successMessage(mode:Mode):string{
  if(mode==='upsert')return '已保存到服务器，公开日历与订阅已同步生效';
  if(mode==='hide')return '已隐藏；管理员可随时恢复';
  return '已恢复公开显示';
}

function chinaDatetimeInput(ms: number | null): string {
  return ms === null ? '' : new Date(ms + CN_OFFSET_MS).toISOString().slice(0,16);
}
function inputFromEvent(event: EventCalendarItem): Draft {
  return {
    title: event.title, description: event.description, category: event.category,
    location: event.location, sourceUrl: event.sourceUrl ?? '',
    starts: chinaDatetimeInput(event.startsAt), ends: chinaDatetimeInput(event.endsAt),
    allDay: event.allDay,
  };
}
function parseChinaInput(value: string): number | null {
  if (!value) return null;
  const stamp = Date.parse(value + ':00+08:00');
  if (!Number.isFinite(stamp) || chinaDatetimeInput(stamp) !== value) throw new Error('请使用有效的北京时间');
  return stamp;
}
function parseDraft(draft: Draft) {
  const startsAt = parseChinaInput(draft.starts);
  const endsAt = parseChinaInput(draft.ends);
  if (startsAt !== null && endsAt !== null && endsAt <= startsAt) throw new Error('结束时间必须晚于开始时间');
  const item = {
    title: draft.title.trim(), description: draft.description.trim(),
    category: draft.category.trim(), location: draft.location.trim(),
    startsAt, endsAt, sourceUrl: draft.sourceUrl.trim() || null, allDay: draft.allDay,
  };
  const parsed = eventCalendarItemSchema.omit({ id: true, region: true }).safeParse(item);
  if (!parsed.success) throw new Error('请检查标题、分类、说明长度和来源 URL，来源应是完整 HTTPS 地址');
  return parsed.data;
}
function recordsFrom(list: AdminList): AdminRecord[] {
  const records = new Map<string, AdminRecord>(list.official.map(item => [item.id, { id: item.id, item, revision: 0, mode: 'official' as const }]));
  for (const change of list.edits) {
    const original = records.get(change.id);
    const item = change.item ?? original?.item;
    if (item) records.set(change.id, { id: change.id, item, revision: change.revision, mode: change.mode });
  }
  return [...records.values()].sort((a,b) => {
    const aEnd = a.item.endsAt ?? 0, bEnd = b.item.endsAt ?? 0;
    return bEnd - aEnd || a.item.title.localeCompare(b.item.title);
  });
}

export function CalendarAdminPanel({ getToken, onClose, onSaved }: {
  readonly getToken: () => string | null;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const [records, setRecords] = useState<AdminRecord[]>([]);
  const content=useContentState();
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [search, setSearch] = useState('');
  const [showHistory, setShowHistory] = useState(false);

  const fetchList = useCallback(async (signal?: AbortSignal) => {
    const token = getToken();
    if (!token) throw new Error('管理员会话已过期，请返回管理后台重新登录');
    const response = await fetch('/api/v1/admin/calendar/items', {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      method: 'GET', cache: 'no-store', credentials: 'omit', ...(signal ? { signal } : {}),
    });
    if (response.status === 401 || response.status === 403) throw new Error('管理员会话已失效，请使用账号密码和 TOTP 重新登录');
    if (!response.ok) throw new Error('管理员活动列表暂时不可用');
    const data = await response.json() as AdminList;
    if (!Array.isArray(data.official) || !Array.isArray(data.edits)) throw new Error('后台数据格式异常');
    if (!signal?.aborted) setRecords(recordsFrom(data));
  }, [getToken]);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => fetchList(controller.signal)).catch(e => {
      if (!controller.signal.aborted) setMessage(e instanceof Error ? e.message : '读取失败');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [fetchList]);

  const selected = records.find(row => row.id === selectedId);
  usePrivateDraft(saving||JSON.stringify(draft)!==JSON.stringify(selected?inputFromEvent(selected.item):EMPTY));
  const [now] = useState(Date.now);
  const visible = useMemo(() => records.filter(row => !content.excluded('calendar',row.id)&&
    (showHistory || row.item.endsAt === null || row.item.endsAt >= now || row.mode === 'hide') &&
    (row.item.title + ' ' + row.item.category).toLowerCase().includes(search.trim().toLowerCase())
  ), [records, search, showHistory, now,content]);

  function select(row: AdminRecord) {
    setSelectedId(row.id);
    setDraft(inputFromEvent(row.item));
    setMessage('');
  }
  function createNew() {
    setSelectedId(null);
    setDraft({ ...EMPTY });
    setMessage('');
  }
  async function submit(method: 'upsert' | 'hide' | 'restore') {
    const token = getToken();
    if (!token) { setMessage('管理员会话已失效，请返回管理后台重新登录'); return; }
    let url = '/api/v1/admin/calendar/items';
    let httpMethod = 'POST';
    const revision = selected?.revision ?? 0;
    let body: unknown = { expectedRevision: revision };
    try {
      if (method === 'upsert') {
        body = { expectedRevision: revision, item: parseDraft(draft) };
        if (selectedId !== null) { url += '/' + encodeURIComponent(selectedId); httpMethod = 'PUT'; }
      } else {
        if (selectedId === null) throw new Error('请先选择要操作的活动');
        if (method === 'hide' && !window.confirm('确定要从公开日历和 ICS 订阅中隐藏该活动吗？')) return;
        url += '/' + encodeURIComponent(selectedId) + '/' + method;
      }
      setSaving(true);
      setMessage('');
      const response = await fetch(url, {
        method: httpMethod, credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assertCalendarSaveResponse(response);
      await fetchList();
      const saved = await response.json() as {id: string};
      setSelectedId(saved.id);
      setMessage(successMessage(method));
      onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败');
    } finally { setSaving(false); }
  }
  const patch = (field: keyof Draft, value: string | boolean) =>
    setDraft(old => ({ ...old, [field]: value }));

  async function refreshOfficial() {
    const token=getToken();
    if(!token){setMessage('管理员会话已失效，请重新登录');return;}
    setSaving(true);setMessage('正在同步官方公告…');
    try{
      const response=await fetch('/api/v1/admin/calendar/refresh',{
        method:'POST',credentials:'omit',cache:'no-store',redirect:'error',
        headers:{Authorization:'Bearer '+token},
      });
      if(response.status===429)throw new Error('手动同步每 5 分钟最多一次，请稍后再试');
      if(response.status===401||response.status===403)throw new Error('管理员会话已失效，请重新登录');
      if(!response.ok)throw new Error('官方同步失败，已保留原有活动数据，请稍后重试');
      await fetchList();onSaved();setMessage('官方公告已同步，人工编辑内容已保留');
    }catch(error){setMessage(error instanceof Error?error.message:'同步失败');}
    finally{setSaving(false);}
  }

  return <section className="calendar-admin" aria-label="国服活动内容管理">
    <header className="calendar-admin__header">
      <div><button type="button" className="text-button" onClick={onClose}>← 返回管理概览</button>
        <h2>活动内容管理</h2>
        <p>官方公告每 6 小时自动同步；手动同步不会覆盖你的修改。</p></div>
      <div className="calendar-admin__actions">
        <button className="button" type="button" disabled={saving} onClick={()=>void refreshOfficial()}>同步官方公告</button>
        <button className="button" type="button" onClick={createNew}>＋ 新建活动</button>
      </div>
    </header>
    <div className="calendar-admin__layout">
      <section className="calendar-admin__list" aria-label="可编辑活动">
        <input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="搜索活动名称／类别" aria-label="搜索可编辑活动"/>
        <label><input type="checkbox" checked={showHistory} onChange={e => setShowHistory(e.target.checked)}/> 包含历史已结束活动</label>
        {loading ? <output style={{display:'block'}}>正在读取后台活动…</output> : <p className="panel__muted">共 {visible.length} 项 · 已隐藏的活动也可从此恢复</p>}
        <ul>{visible.map(row => <li key={row.id}><button type="button"
          aria-current={selectedId === row.id ? 'true' : undefined} onClick={() => select(row)}>
          <strong>{row.item.title}</strong>
          <span>{adminModeLabel(row.mode)} · {row.item.category}</span>
          <small>{row.item.endsAt === null ? '时间待核实' : chinaDateTime(row.item.endsAt)}</small>
        </button></li>)}</ul>
      </section>
      <form className="calendar-admin__form" aria-label="结构化活动编辑表单" onSubmit={event => {
        event.preventDefault();
        void submit('upsert');
      }}>
        <h3>{selected ? '编辑活动' : '新建活动'}</h3>
        {selected && <p className="panel__muted">版本 {selected.revision} · {selected.mode === 'hide' ? '当前已隐藏' : '公开显示'}</p>}
        <label>活动名称 <input required maxLength={120} value={draft.title} onChange={e=>patch('title',e.target.value)} placeholder="例如：守护天节"/></label>
        <label>分类 <input required maxLength={32} list="calendar-admin-categories" value={draft.category} onChange={e=>patch('category',e.target.value)} /></label>
        <datalist id="calendar-admin-categories">{['季节活动','限时联动','莫古莫古大收集','版本更新','直播与线下','月卡与商城','人工维护'].map(x=><option value={x} key={x}/>)}</datalist>
        <div className="calendar-admin__dates">
          <label>开始时间（北京时间）<input type="datetime-local" value={draft.starts} onChange={e=>patch('starts',e.target.value)}/></label>
          <label>结束时间（北京时间）<input type="datetime-local" value={draft.ends} onChange={e=>patch('ends',e.target.value)}/></label>
        </div>
        <p className="panel__muted">时间可分别留空；有完整起止时间才进入日历和 ICS。结束条件可填写在简介中。</p>
        <label>简介 <textarea rows={3} maxLength={600} value={draft.description} onChange={e=>patch('description',e.target.value)} placeholder="活动奖励、参与方式、注意事项"/></label>
        <label>地点（可选）<input maxLength={120} value={draft.location} onChange={e=>patch('location',e.target.value)} placeholder="游戏内地点或活动入口"/></label>
        <label>原始公告链接（HTTPS，可选）<input type="url" value={draft.sourceUrl} onChange={e=>patch('sourceUrl',e.target.value)} placeholder="https://..."/></label>
        <div className="calendar-admin__actions">
          {selected&&<button type="button" disabled={saving} onClick={()=>{setSaving(true);void content.change('calendar',selected.id,'trash').then(()=>{createNew();onSaved();setMessage('活动已移入回收站，可恢复；官方同步不会重新收录');}).catch((error:unknown)=>setMessage(error instanceof Error?error.message:'删除失败')).finally(()=>setSaving(false));}}>删除活动</button>}
          <button className="button" type="submit" disabled={saving}>{saving ? '保存中…' : '保存到后端'}</button>
          {selected && selected.mode !== 'hide' && <button className="button button--secondary" type="button" disabled={saving} onClick={()=>void submit('hide')}>隐藏活动</button>}
          {selected && (selected.mode === 'hide' || (selected.mode === 'upsert' && !selected.id.startsWith('manual:'))) && <button className="button button--secondary" type="button" disabled={saving} onClick={()=>void submit('restore')}>{selected.mode === 'hide' ? '恢复显示' : '恢复官方原文'}</button>}
          <button className="text-button" type="button" onClick={()=>setDraft(selected ? inputFromEvent(selected.item) : { ...EMPTY })}>撤销表单修改</button>
        </div>
        {message && <output className="notice" style={{display:'block'}}>{message}</output>}
      </form>
    </div>
  </section>;
}
