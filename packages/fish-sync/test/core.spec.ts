import { describe,it,expect } from 'vitest';
import { parseFishDocument,serializeFishDocument,mergeFishDocuments,documentChanges,fieldsToDocument,touchedSince,type FishDocument } from '../src/index';
const empty=():FishDocument=>({completed:[],pinned:[],alarmFish:[]});
describe('fishcake compatibility and merge',()=>{
  it('roundtrips all three arrays, unknown IDs and nested extension fields',()=>{
    const raw={completed:[4776,9999999],pinned:[4925],alarmFish:[4776],future:{options:[null,true,'later']},note:'保留'};
    expect(parseFishDocument(serializeFishDocument(parseFishDocument(JSON.stringify(raw))))).toEqual(raw);
    const reserved=parseFishDocument('{"completed":[],"pinned":[],"alarmFish":[],"__proto__":{"future":1}}');
    expect(Object.hasOwn(parseFishDocument(serializeFishDocument(reserved)),'__proto__')).toBe(true);
    expect(Object.getPrototypeOf(reserved)).toBe(Object.prototype);
  });
  it('propagates cancellation, independently merges other fields and keeps extras out of Hub authority',()=>{
    const baseline={...empty(),completed:[1],future:{x:1}};
    const result=mergeFishDocuments({baseline,local:{...baseline,completed:[],pinned:[2]},webdav:baseline,hub:{...empty(),completed:[1],alarmFish:[3]}});
    expect(result.conflicts).toHaveLength(0);expect(result.document).toEqual({completed:[],pinned:[2],alarmFish:[3],future:{x:1}});
  });
  it('requires explicit first-sync resolutions and detects opposite revisioned intent even after a return to baseline',()=>{
    const first=mergeFishDocuments({baseline:null,local:{...empty(),completed:[1]},webdav:empty(),hub:empty()});
    expect(first.conflicts[0]?.key).toBe('completed:1');
    const input={baseline:empty(),local:{...empty(),completed:[1]},webdav:empty(),hub:empty(),touched:{webdav:new Set(['completed:1'])}};
    expect(mergeFishDocuments(input).conflicts).toHaveLength(1);
    expect(mergeFishDocuments({...input,resolutions:new Map([['completed:1','webdav' as const]])}).document.completed).toEqual([]);
    expect(touchedSince({'completed:1':1},{'completed:1':3})).toEqual(new Set(['completed:1']));
  });
  it('preserves intentional null or deletion of extensions and exposes competing edits',()=>{
    const baseline={...empty(),future:'old'};
    expect(mergeFishDocuments({baseline,local:{...empty(),future:null},webdav:baseline,hub:empty()}).document['future']).toBeNull();
    const deletion=mergeFishDocuments({baseline,local:empty(),webdav:baseline,hub:empty()});
    expect(Object.hasOwn(deletion.document,'future')).toBe(false);
    expect(mergeFishDocuments({baseline,local:{...empty(),future:'a'},webdav:{...empty(),future:'b'},hub:empty()}).conflicts[0]?.key).toBe('extra:future');
  });
  it('uses explicit false updates rather than union, retains unknown IDs and field revisions',()=>{
    const fields=[{fishId:999,field:'caught' as const,value:true,revision:4},{fishId:999,field:'alarm' as const,value:true,revision:2}];
    expect(documentChanges(empty(),fields)).toEqual([{fishId:999,field:'caught',value:false,expectedRevision:4},{fishId:999,field:'alarm',value:false,expectedRevision:2}]);
    expect(fieldsToDocument(fields,{...empty(),future:true})['future']).toBe(true);
  });
  it('rejects malformed, oversized and excessively nested documents without silent downgrade',()=>{
    expect(()=>parseFishDocument('{"completed":[],"pinned":[]}')).toThrow();
    expect(()=>parseFishDocument(JSON.stringify({...empty(),completed:['1']}))).toThrow();
    expect(()=>parseFishDocument(' '.repeat(1048577))).toThrow();
    expect(()=>parseFishDocument('['.repeat(50)+'0'+']'.repeat(50))).toThrow();
    expect(()=>parseFishDocument('{"completed":[],"pinned":[],"alarmFish":[],"future":9007199254740993}')).toThrow();
  });
});
