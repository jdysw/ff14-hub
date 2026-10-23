import {readDeviceRecord,updateDeviceRecord} from './secure-storage';
export interface BackupStatus{exportedAt?:number;restoredAt?:number}
export const BACKUP_STATUS_CHANGED='ff14hub:backup-status';
export const readBackupStatus=()=>readDeviceRecord<BackupStatus>('backup-status');
export async function recordBackupEvent(kind:'exportedAt'|'restoredAt'){
  await updateDeviceRecord<BackupStatus>('backup-status',current=>({...current,[kind]:Date.now()}));
  window.dispatchEvent(new Event(BACKUP_STATUS_CHANGED));
}
