/** 国服活动后台：通过现有设备令牌和服务端管理员白名单授权，不创建新账号。 */
import { eventCalendarItemSchema, type EventCalendarItem } from '@ff14-hub/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { chinaDateTime } from './public-calendar-utils';
import './calendar-admin.css';

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
  if ((startsAt === null) !== (endsAt === null)) throw new Error('起止时间必须同时填写，或同时留空');
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
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [search, setSearch] = useState('');
  const [showHistory, setShowHistory] = useState(false);

  const fetchList = useCallback(async (signal?: AbortSignal) => {
    const token = getToken();
    if (!token) throw new Error('请在「设置 → 会话凭证」中连接管理员设备');
    const response = await fetch('/api/v1/events/admin/items', {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      method: 'GET', cache: 'no-store', credentials: 'omit', ...(signal ? { signal } : {}),
    });
    if (response.status === 401 || response.status === 403) throw new Error('该设备没有管理员权限，或凭证已失效');
    if (!response.ok) throw new Error('管理员活动列表暂时不可用');
    const data = await response.json() as AdminList;
    if (!Array.isArray(data.official) || !Array.isArray(data.edits)) throw new Error('后台数据格式异常');
    if (!signal?.aborted) setRecords(recordsFrom(data));
  }, [getToken]);
  useEffect(() => {
    const controller = new AbortController();
    void fetchList(controller.signal).catch(e => {
      if (!controller.signal.aborted) setMessage(e instanceof Error ? e.message : '读取失败');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [fetchList]);

  const selected = records.find(row => row.id === selectedId);
  const now = Date.now();
  const visible = useMemo(() => records.filter(row =>
    (showHistory || row.item.endsAt === null || row.item.endsAt >= now || row.mode === 'hide') &&
    (row.item.title + ' ' + row.item.category).toLowerCase().includes(search.trim().toLowerCase())
  ), [records, search, showHistory, now]);

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
    if (!token) { setMessage('管理员凭证已失效，请重新连接'); return; }
    let url = '/api/v1/events/admin/items';
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
      if (response.status === 409) throw new Error('版本冲突：这条活动已被修改，请刷新列表后重试');
      if (response.status === 401 || response.status === 403) throw new Error('管理员身份不再有效');
      if (!response.ok) throw new Error('服务器拒绝保存，请检查内容格式与必填字段');
      await fetchList();
      const saved = await response.json() as {id: string};
      setSelectedId(saved.id);
      setMessage(method === 'upsert' ? '已保存到服务器，公开日历与订阅已同步生效' :
        method === 'hide' ? '已隐藏；管理员可随时恢复' : '已恢复公开显示');
      onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败');
    } finally { setSaving(false); }
  }
  const patch = (field: keyof Draft, value: string | boolean) =>
    setDraft(old => ({ ...old, [field]: value }));

  return <section className="calendar-admin" aria-label="国服活动后台管理">
    <header className="calendar-admin__header">
      <div><button type="button" className="text-button" onClick={onClose}>← 返回活动日历</button>
        <h2>活动后台管理</h2>
        <p>编辑活动会直接写入 D1，定时同步官方公告不会覆盖你的修改。</p></div>
      <button className="button" type="button" onClick={createNew}>＋ 新建活动</button>
    </header>
    <div className="calendar-admin__layout">
      <section className="calendar-admin__list" aria-label="可编辑活动">
        <input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="搜索活动名称／类别" aria-label="搜索可编辑活动"/>
        <label><input type="checkbox" checked={showHistory} onChange={e => setShowHistory(e.target.checked)}/> 包含历史已结束活动</label>
        {loading ? <p role="status">正在读取后台活动…</p> : <p className="panel__muted">共 {visible.length} 项 · 已隐藏的活动也可从此恢复</p>}
        <ul>{visible.map(row => <li key={row.id}><button type="button"
          aria-current={selectedId === row.id ? 'true' : undefined} onClick={() => select(row)}>
          <strong>{row.item.title}</strong>
          <span>{row.mode === 'hide' ? '已隐藏' : row.mode === 'upsert' ? '人工维护' : '公开'} · {row.item.category}</span>
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
        <p className="panel__muted">两个时间都填才进入日历和 ICS；如果未核实，请保持两个时间均为空。</p>
        <label>简介 <textarea rows={3} maxLength={600} value={draft.description} onChange={e=>patch('description',e.target.value)} placeholder="活动奖励、参与方式、注意事项"/></label>
        <label>地点（可选）<input maxLength={120} value={draft.location} onChange={e=>patch('location',e.target.value)} placeholder="游戏内地点或活动入口"/></label>
        <label>原始公告链接（HTTPS，可选）<input type="url" value={draft.sourceUrl} onChange={e=>patch('sourceUrl',e.target.value)} placeholder="https://..."/></label>
        <div className="calendar-admin__actions">
          <button className="button" type="submit" disabled={saving}>{saving ? '保存中…' : '保存到后端'}</button>
          {selected && selected.mode !== 'hide' && <button className="button button--secondary" type="button" disabled={saving} onClick={()=>void submit('hide')}>隐藏活动</button>}
          {selected && (selected.mode === 'hide' || (selected.mode === 'upsert' && !selected.id.startsWith('manual:'))) && <button className="button button--secondary" type="button" disabled={saving} onClick={()=>void submit('restore')}>{selected.mode === 'hide' ? '恢复显示' : '恢复官方原文'}</button>}
          <button className="text-button" type="button" onClick={()=>setDraft(selected ? inputFromEvent(selected.item) : { ...EMPTY })}>撤销表单修改</button>
        </div>
        {message && <p className="notice" role="status">{message}</p>}
      </form>
    </div>
  </section>;
}
