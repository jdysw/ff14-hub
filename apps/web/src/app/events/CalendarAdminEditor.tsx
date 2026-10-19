/**
 * 站点管理员活动编辑器。
 * 仅显示通过设备白名单校验的站点管理员；服务器对每次写入重复验证设备和角色。
 * 所有字段均为格式化表单；不暴露 JSON 编辑入口，不将令牌写入状态或本地存储。
 */
import { eventCalendarItemSchema, type EventCalendarItem } from '@ff14-hub/shared';
import { useEffect, useState } from 'react';

interface Override { id: string; revision: number; hidden: boolean; event: EventCalendarItem | null }
interface EditorForm {
  title: string; category: string; description: string; sourceUrl: string; starts: string; ends: string;
}
const EMPTY: EditorForm = { title: '', category: '季节活动', description: '', sourceUrl: '', starts: '', ends: '' };
const OFFSET = 8 * 3600_000;

function localInput(ms: number | null): string {
  return ms === null ? '' : new Date(ms + OFFSET).toISOString().slice(0, 16);
}
function utcFromChinaInput(value: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value + ':00Z');
  return Number.isFinite(parsed) ? parsed - OFFSET : null;
}
function formOf(item: EventCalendarItem): EditorForm {
  return {
    title: item.title, category: item.category, description: item.description,
    sourceUrl: item.sourceUrl ?? '', starts: localInput(item.startsAt), ends: localInput(item.endsAt),
  };
}
function eventFromForm(form: EditorForm) {
  return {
    region: 'cn' as const, title: form.title.trim(), category: form.category.trim(),
    description: form.description.trim(), location: '', startsAt: utcFromChinaInput(form.starts),
    endsAt: utcFromChinaInput(form.ends), allDay: false, sourceUrl: form.sourceUrl.trim() || null,
  };
}

export function CalendarAdminEditor({ getToken, events, onSaved }: {
  readonly getToken: () => string | null;
  readonly events: readonly EventCalendarItem[];
  readonly onSaved: () => void;
}) {
  const [allowed, setAllowed] = useState(false);
  const [entries, setEntries] = useState<Override[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<EditorForm>(EMPTY);
  const [status, setStatus] = useState('');
  const [working, setWorking] = useState(false);
  const token = getToken();

  async function api(path: string, method = 'GET', payload?: unknown): Promise<Response> {
    const credential = getToken();
    if (!credential) throw new Error('未连接设备');
    return fetch('/api/v1/admin/calendar' + path, {
      method, credentials: 'omit', cache: 'no-store',
      headers: {
        Authorization: 'Bearer ' + credential,
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  }

  async function load() {
    const response = await api('/entries');
    if (!response.ok) throw new Error('读取管理员修订列表失败');
    const json: unknown = await response.json();
    if (json && typeof json === 'object' && 'entries' in json && Array.isArray(json.entries)) {
      setEntries(json.entries as Override[]);
    }
  }

  useEffect(() => {
    if (!token) { setAllowed(false); return; }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/v1/admin/calendar/me', {
          credentials: 'omit', cache: 'no-store', signal: controller.signal,
          headers: { Authorization: 'Bearer ' + token },
        });
        if (!controller.signal.aborted) setAllowed(response.ok);
      } catch { if (!controller.signal.aborted) setAllowed(false); }
    })();
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    if (!allowed) return;
    void load().catch(() => setStatus('管理员修订列表读取失败，请刷新。'));
  }, [allowed]);

  if (!allowed) return null;

  const revision = editingId === null ? 0 : entries.find(e => e.id === editingId)?.revision ?? 0;
  function edit(item: EventCalendarItem) {
    setEditingId(item.id);
    setForm(formOf(item));
    setStatus('');
  }
  function reset() { setEditingId(null); setForm(EMPTY); setStatus(''); }

  async function save() {
    const input = eventFromForm(form);
    const parsed = eventCalendarItemSchema.omit({ id: true }).safeParse(input);
    if (!parsed.success || (input.startsAt === null) !== (input.endsAt === null) ||
        (input.startsAt !== null && input.endsAt !== null && input.endsAt <= input.startsAt)) {
      setStatus('请检查标题、类别、时间范围和 HTTPS 来源链接；开始与结束必须同时填写。');
      return;
    }
    setWorking(true);
    try {
      const result = editingId === null ?
        await api('/entries', 'POST', input) :
        await api('/entries/' + encodeURIComponent(editingId), 'PUT', {
          event: input, expectedRevision: revision,
        });
      if (!result.ok) {
        setStatus(result.status === 409 ? '已被其他管理员修改，请刷新编辑列表。' :
          '保存失败：请检查管理员权限和字段。');
        return;
      }
      await load(); onSaved(); reset(); setStatus('活动已保存到云端，对所有玩家生效。');
    } catch { setStatus('网络错误，活动未确认保存成功。'); }
    finally { setWorking(false); }
  }

  async function hide() {
    if (editingId === null || !window.confirm('确定隐藏该活动？官方定时同步不会自动恢复此活动。')) return;
    setWorking(true);
    try {
      const result = await api('/entries/' + encodeURIComponent(editingId) + '/hide', 'POST', {
        expectedRevision: revision,
      });
      if (!result.ok) { setStatus('隐藏失败，可能是权限不足或修订版本冲突，请刷新。'); return; }
      await load(); onSaved(); reset(); setStatus('已隐藏活动。');
    } catch { setStatus('网络错误，无法确认隐藏结果。'); }
    finally { setWorking(false); }
  }
  const allEvents = [...events.filter(event => !entries.some(e => e.id === event.id && e.hidden)),
    ...entries.filter(e => !e.hidden && e.event && !events.some(event => event.id === e.id)).map(e => e.event!)];

  return <section className="calendar-admin" aria-label="国服活动管理员编辑">
    <header><h3>活动管理</h3><p>仅站点管理员可见 · 修改直接保存到 D1，官方定时同步不会覆盖</p></header>
    <div className="calendar-admin__layout">
      <div>
        <button className="button" type="button" onClick={reset}>＋ 新建活动</button>
        <label>选择已有活动编辑
          <select aria-label="选择要编辑的活动" value={editingId ?? ''}
            onChange={e => {
              const item = allEvents.find(x => x.id === e.target.value);
              if (item) edit(item); else reset();
            }}>
            <option value="">新建活动</option>
            {allEvents.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
        </label>
        <details><summary>查看已隐藏的活动</summary>
          {entries.filter(x => x.hidden).map(x => <button key={x.id} type="button"
            onClick={() => { setEditingId(x.id); setForm(EMPTY); setStatus('请补全信息并保存，即可恢复此活动。'); }}>
            {x.id} · 编辑并恢复
          </button>)}
        </details>
      </div>
      <form onSubmit={e => { e.preventDefault(); void save(); }}>
        <label>活动名称 <input required maxLength={120} value={form.title} onChange={e => setForm(v => ({ ...v, title: e.target.value }))}/></label>
        <label>活动分类
          <select value={form.category} onChange={e => setForm(v => ({ ...v, category: e.target.value }))}>
            {['季节活动','限时联动','版本更新','莫古莫古大收集','直播与线下','月卡与商城','其他活动','官方公告'].map(v => <option key={v}>{v}</option>)}
          </select>
        </label>
        <label>开始时间（北京时间） <input type="datetime-local" value={form.starts} onChange={e => setForm(v => ({ ...v, starts: e.target.value }))}/></label>
        <label>结束时间（北京时间） <input type="datetime-local" value={form.ends} onChange={e => setForm(v => ({ ...v, ends: e.target.value }))}/></label>
        <label>活动详情 <textarea rows={3} maxLength={600} value={form.description} onChange={e => setForm(v => ({ ...v, description: e.target.value }))}/></label>
        <label>官方来源链接（HTTPS） <input type="url" value={form.sourceUrl} onChange={e => setForm(v => ({ ...v, sourceUrl: e.target.value }))} placeholder="https://ff.web.sdo.com/…"/></label>
        <div className="calendar-admin__actions">
          <button className="button" disabled={working} type="submit">{working ? '保存中…' : editingId ? '保存修改' : '创建活动'}</button>
          {editingId && <button className="button button--danger" disabled={working} type="button" onClick={() => void hide()}>隐藏活动</button>}
        </div>
        {status && <p role="status">{status}</p>}
      </form>
    </div>
  </section>;
}
