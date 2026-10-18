// Bundled only by vite.sync-e2e.config.ts. Never imported by the production application.
import {changedDocumentKeys,type FishDocument} from '../../packages/fish-sync/src/index';
import {createSyncCoordinator,createVaultCheckpointStore,type LocalPort} from '../../packages/fish-sync/src/coordinator';
import {createClientVault,createIndexedDbVaultStorage,type VaultProfile} from '../../packages/fish-sync/src/vault';
import {createWebDavClient} from '../../packages/fish-sync/src/webdav';
import {createHubSyncPort} from '../../packages/fish-sync/src/hub';
import {createBrowserProfileLock} from '../../packages/fish-sync/src/browser-lock';
export {createBrowserProfileLock};

/** Synthetic local source, NOT a fishcake storage adapter. DAV transport and Hub use actual fetch. */
export function createFixtureClient(profile:VaultProfile,token:string,initial:FishDocument){
  let document=structuredClone(initial);let serial=0;let revision='0';let operationId='';
  const revisions:Record<string,number>={};
  const mutate=(next:FishDocument,touched:readonly string[]=[])=>{
    for(const key of new Set([...changedDocumentKeys(document,next),...touched]))revisions[key]=(revisions[key]??0)+1;
    document=structuredClone(next);revision=String(++serial);operationId='';
  };
  const local:LocalPort={
    read:()=>Promise.resolve({document:structuredClone(document),revision,operationId,revisions:{...revisions}}),
    write:(input)=>{
      if(input.expectedRevision!==revision)return Promise.reject(new Error('fixture CAS conflict'));
      mutate(input.document,input.touched);operationId=input.operationId;
      return Promise.resolve({revision,revisions:{...revisions}});
    },
  };
  const vault=createClientVault(createIndexedDbVaultStorage('ff14-hub-sync-runtime-e2e'));
  const hub=createHubSyncPort({hubOrigin:profile.hubOrigin,workspaceId:profile.workspaceId,region:profile.region,getToken:()=>token});
  const coordinator=createSyncCoordinator({
    local,hub,checkpoints:createVaultCheckpointStore(vault),lock:createBrowserProfileLock(),
    dav:createWebDavClient({baseUrl:profile.davBaseUrl,hubOrigin:profile.hubOrigin,username:'fixture-dav-user',password:'fixture-dav-password'}),
  });
  return {coordinator,profile,mutate,readLocal:()=>local.read()};
}
