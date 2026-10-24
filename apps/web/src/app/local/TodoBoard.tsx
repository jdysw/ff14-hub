import {useEffect,useState} from 'react';
import type {LocalData,LocalStore} from './store';
import {usePrivateDraft} from '../pwa/draft-registry';
import './personal-tools.css';
import {readDeviceRecord} from './secure-storage';
import {NOTIFICATION_SETTINGS_CHANGED,type NotificationSettings} from './local-notifications';

type Todo=LocalData['notes'][number];
const inputTime=(time?:number)=>time===undefined?'':new Date(time-new Date(time).getTimezoneOffset()*60000).toISOString().slice(0,16);
const actual=(time:number)=>new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(time);
export function todoStatus(note:Todo,now:number){
  const end=note.endsAt,start=note.startsAt;
  const target=start!==undefined&&start>now?start:end;
  if(target===undefined)return note.remindAt===undefined?'':`${actual(note.remindAt)} 提醒`;
  const seconds=Math.ceil(Math.abs(target-now)/1000),days=Math.floor(seconds/86400),hours=Math.floor(seconds/3600),minutes=Math.max(1,Math.ceil(seconds/60));
  return `${target<now?'已逾期':target===start?'距开始':'剩余'} ${days?`${days} 天`:hours?`${hours} 小时`:`${minutes} 分钟`}`;
}
export function TodoBoard({data,store,expanded=false,onExpand}:{data:LocalData;store:LocalStore;expanded?:boolean;onExpand?:()=>void}){
  const [title,setTitle]=useState(''),[text,setText]=useState(''),[times,setTimes]=useState(false),[editing,setEditing]=useState<string|null>(null);
  const [starts,setStarts]=useState(''),[ends,setEnds]=useState(''),[reminder,setReminder]=useState('');
  const [completed,setCompleted]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[now,setNow]=useState(Date.now);
  const [undo,setUndo]=useState<Todo|null>(null);
  const [notificationInfo,setNotificationInfo]=useState('通知尚未启用，设置时间后仍需在通知设置中连接渠道。');
  useEffect(()=>{let alive=true;const refresh=()=>{void readDeviceRecord<NotificationSettings>('notifications').then(settings=>{if(alive)setNotificationInfo(settings?.error?`通知登记异常：${settings.error}`:settings?.token?'后台通知已连接；最近 30 项待办会登记，投递可能有约 5 分钟延迟。':settings?.browser?'仅网页打开且浏览器允许通知时提醒。':'通知尚未启用，设置时间后仍需在通知设置中连接渠道。');}).catch(()=>undefined);};refresh();window.addEventListener(NOTIFICATION_SETTINGS_CHANGED,refresh);return()=>{alive=false;window.removeEventListener(NOTIFICATION_SETTINGS_CHANGED,refresh);};},[]);
  usePrivateDraft(Boolean(title||text||busy||editing));
  useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),30000);return()=>window.clearInterval(timer);},[]);
  const run=async(action:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setError('');try{await action();}catch(cause){setError(cause instanceof Error?cause.message:'保存失败，输入仍保留');}finally{setBusy(false);}};
  const reset=()=>{setTitle('');setText('');setStarts('');setEnds('');setReminder('');setEditing(null);setTimes(false);};
  const edit=(note:Todo)=>{setTitle(note.title);setText(note.text);setStarts(inputTime(note.startsAt));setEnds(inputTime(note.endsAt));setReminder(inputTime(note.remindAt));setEditing(note.id);setTimes(true);};
  // Minute updates change labels only. Sorting is recalculated when data changes.
  const items=data.notes.filter(note=>Boolean(note.completed)===completed).slice().sort((a,b)=>(a.endsAt??a.startsAt??a.remindAt??Infinity)-(b.endsAt??b.startsAt??b.remindAt??Infinity));
  return <section className="todo-board" aria-label="我的待办"><header className="local-notes__heading"><h3>我的待办</h3>{!expanded&&<button type="button" onClick={onExpand}>全部待办 ↗</button>}</header>
    <form onSubmit={event=>{event.preventDefault();void run(async()=>{
      const startsAt=starts?Date.parse(starts):undefined,endsAt=ends?Date.parse(ends):undefined,remindAt=reminder?Date.parse(reminder):undefined;
      if([startsAt,endsAt,remindAt].some(time=>time!==undefined&&!Number.isFinite(time)))throw new Error('请填写有效时间');
      if(startsAt!==undefined&&endsAt!==undefined&&endsAt<=startsAt)throw new Error('截止时间必须晚于开始时间');
      if(remindAt!==undefined&&remindAt<=Date.now())throw new Error('提醒时间应晚于当前时间');
      await store.change(document=>{const old=document.data.notes.find(note=>note.id===editing);if(editing&&!old)throw new Error('此待办已在其他页面删除，请重新添加');
        const note={id:old?.id??crypto.randomUUID(),title:title.trim(),text,completed:old?.completed??false,...(startsAt!==undefined?{startsAt}:{}),...(endsAt!==undefined?{endsAt}:{}),...(remindAt!==undefined?{remindAt}:{})};
        if(old)document.data.notes[document.data.notes.indexOf(old)]=note;else document.data.notes.push(note);document.data.configuration.visible.notes=true;});reset();
    });}}><div className="todo-quick"><input aria-label="待办标题" placeholder="添加待办…" value={title} maxLength={100} required onChange={event=>setTitle(event.target.value)}/><button type="button" aria-expanded={times} onClick={()=>setTimes(!times)}>时间</button><button type="submit" disabled={busy||!title.trim()}>{editing?'保存':'添加'}</button></div>
      {times&&<div className="todo-editor"><label>开始时间<input type="datetime-local" value={starts} onChange={e=>setStarts(e.target.value)}/></label><label>截止时间<input type="datetime-local" value={ends} onChange={e=>setEnds(e.target.value)}/></label><label>提醒时间<input type="datetime-local" value={reminder} onChange={e=>setReminder(e.target.value)}/></label><label>备注<textarea value={text} maxLength={10000} rows={2} onChange={e=>setText(e.target.value)}/></label><small>使用本机时区；通知需在设置中启用。后台通知可能有约 5 分钟延迟。</small></div>}{editing&&<button type="button" onClick={reset}>取消编辑</button>}
    </form>
    <nav className="todo-tabs" aria-label="待办状态"><button type="button" aria-pressed={!completed} onClick={()=>setCompleted(false)}>待完成 {data.notes.filter(n=>!n.completed).length}</button><button type="button" aria-pressed={completed} onClick={()=>setCompleted(true)}>已完成</button></nav>
    {error&&<p role="alert">{error}</p>}
    <ul>{items.slice(0,expanded?100:5).map(note=><li key={note.id}><input type="checkbox" aria-label={`完成 ${note.title}`} checked={Boolean(note.completed)} disabled={busy} onChange={()=>void run(async()=>{await store.change(document=>{const current=document.data.notes.find(n=>n.id===note.id);if(current)current.completed=!current.completed;});setUndo(note);})}/><button type="button" className="todo-title" onClick={()=>edit(note)}><strong>{note.title}</strong>{note.text&&<span>{note.text}</span>}</button><div className="todo-time"><span>{todoStatus(note,now)}</span>{(note.startsAt!==undefined||note.endsAt!==undefined)&&<small>{note.startsAt!==undefined?`开始 ${actual(note.startsAt)}`:''}{note.startsAt!==undefined&&note.endsAt!==undefined?' · ':''}{note.endsAt!==undefined?`截止 ${actual(note.endsAt)}`:''}</small>}</div>{expanded&&<button type="button" disabled={busy} aria-label={`删除 ${note.title}`} onClick={()=>void run(async()=>{await store.change(document=>{document.data.notes=document.data.notes.filter(n=>n.id!==note.id);});setUndo(note);})}>删除</button>}</li>)}</ul>
    {!items.length&&<p className="todo-empty">{completed?'还没有已完成事项':'暂时没有待办，随手记一件吧。'}</p>}
    {!expanded&&items.length>5&&<button type="button" onClick={onExpand}>查看其余 {items.length-5} 项</button>}
    {times&&<p className="todo-notification-info" role="status">{notificationInfo}</p>}
    {undo&&<p role="status">已更新“{undo.title}” <button type="button" disabled={busy} onClick={()=>void run(async()=>{await store.change(document=>{const i=document.data.notes.findIndex(n=>n.id===undo.id);if(i<0)document.data.notes.push(undo);else document.data.notes[i]!.completed=Boolean(undo.completed);});setUndo(null);})}>撤销</button></p>}
  </section>;
}
