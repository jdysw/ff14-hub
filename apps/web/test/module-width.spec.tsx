// @vitest-environment jsdom
import {cleanup,render} from '@testing-library/react';
import {afterEach,expect,it} from 'vitest';
import {ModuleGrid,planHomeModules} from '../src/app/local/ModuleGrid';
import {localBackupSchema,localDataSchema} from '../src/app/local/store';
afterEach(cleanup);
it('reserves a full row as a barrier and keeps following modules below it',()=>{
 expect(planHomeModules([200,100,80,90],'events,fishing,pvp,market','balanced',[],[false,true,false,false])).toEqual([0,2,0,1]);
 expect(planHomeModules([200,100,80],'events,fishing,pvp','auto',[],[true,true,true])).toEqual([2,2,2]);
 expect(planHomeModules([100,100],'pvp,market','balanced',[2,2],[false,true])).toEqual([0,2]);
 expect(planHomeModules([200,100,80],'events,fishing,pvp','auto')).toEqual([0,1,2]);
});
it('marks exactly the configured visible modules without affecting hidden preferences',()=>{
 const view=render(<ModuleGrid identity="events,market,weather" wideSections={['market','notes']}><div/><div/><div/></ModuleGrid>);
 expect([...view.container.querySelectorAll('.personal-module-slot')].map(node=>node.getAttribute('data-wide'))).toEqual([null,'true',null]);
 view.rerender(<ModuleGrid identity="events,market,weather" wideSections={['weather']}><div/><div/><div/></ModuleGrid>);
 expect([...view.container.querySelectorAll('.personal-module-slot')].map(node=>node.getAttribute('data-wide'))).toEqual([null,null,'true']);
});
it('keeps old backups valid and round-trips per-module widths without losing other settings',()=>{
 const data=localDataSchema.parse({version:1,revision:0,fish:{cn:[],global:[]},links:[],notes:[],configuration:{order:['events','fishing','pvp','notes'],visible:{events:true,fishing:true,pvp:true,notes:false},region:'cn'}});
 expect(data.configuration.fullWidth).toBeUndefined();
 data.configuration.fullWidth=['fishing','weather'];
 const backup=localBackupSchema.parse({format:'ff14-hub-local',version:1,exportedAt:'now',data});
 expect(backup.data.configuration.fullWidth).toEqual(['fishing','weather']);
 expect(backup.data.configuration.visible.notes).toBe(false);
 expect(()=>localDataSchema.parse({...data,configuration:{...data.configuration,fullWidth:['events','events']}})).toThrow();
 expect(()=>localDataSchema.parse({...data,configuration:{...data.configuration,fullWidth:['unknown']}})).toThrow();
});
