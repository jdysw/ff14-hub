import {useEffect,useState} from 'react';
import {BACKUP_STATUS_CHANGED,readBackupStatus,type BackupStatus} from './backup-status';
export function BackupStatusLine(){
  const [status,setStatus]=useState<BackupStatus|null>(null),[error,setError]=useState(false),[loaded,setLoaded]=useState(false);
  useEffect(()=>{let alive=true;const load=()=>{void readBackupStatus().then(value=>{if(alive){setStatus(value);setError(false);}}).catch(()=>{if(alive)setError(true);}).finally(()=>{if(alive)setLoaded(true);});};load();window.addEventListener(BACKUP_STATUS_CHANGED,load);return()=>{alive=false;window.removeEventListener(BACKUP_STATUS_CHANGED,load);};},[]);
  let description='此设备尚无完整备份导出记录。';
  if(error){description='本机备份记录暂不可读';}
  else if(!loaded){description='正在读取本机备份记录…';}
  else if(status?.exportedAt){description=`上次导出：${new Date(status.exportedAt).toLocaleString('zh-CN')}，请确认文件已保存。`;}
  const restored=status?.restoredAt?` 上次恢复：${new Date(status.restoredAt).toLocaleString('zh-CN')}。`:'';
  return <p className="backup-status">{description}{restored}</p>;
}
