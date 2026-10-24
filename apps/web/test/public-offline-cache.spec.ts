// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest';
import {DEFAULT_GAME_DATA} from '@ff14-hub/shared';
import {PUBLIC_CALENDAR_CACHE_KEY,readCachedPublicCalendar,saveCachedPublicCalendar} from '../src/app/local/public-calendar-cache';
import {readCachedNavigation,saveCachedNavigation} from '../src/app/local/public-navigation-cache';
import {loadGameData,gameDataSource,invalidateGameData} from '../src/app/admin/game-data';
import {vi} from 'vitest';

afterEach(()=>{localStorage.clear();vi.unstubAllGlobals();invalidateGameData();});
const calendar={
  serverTimeMs:Date.now(),source:{name:'国服官方活动',homeUrl:'https://ff.web.sdo.com/',checkedAtMs:Date.now(),stale:false},
  events:[],
};
it('公开活动缓存必须有效且可跨刷新读取，过期或格式损坏的数据不再使用',()=>{
  saveCachedPublicCalendar(calendar);
  const value=readCachedPublicCalendar();
  expect(value?.source.stale).toBe(true);
  expect(value?.events).toEqual([]);
  const key=PUBLIC_CALENDAR_CACHE_KEY;
  const raw=JSON.parse(localStorage.getItem(key)!) as {at:number;value:unknown};
  localStorage.setItem(key,JSON.stringify({...raw,at:Date.now()-32*86400_000}));
  expect(readCachedPublicCalendar()).toBeNull();
  localStorage.setItem(key,'not-json');
  expect(readCachedPublicCalendar()).toBeNull();
});
it('只缓存经完整契约校验的公开导航目录，不能缓存任意记录',()=>{
  saveCachedNavigation({entries:[],sourceVersion:1,updatedAt:Date.now()});
  expect(readCachedNavigation()).toEqual([]);
  saveCachedNavigation({entries:[{url:'javascript:alert(1)'}]});
  expect(readCachedNavigation()).toEqual([]);
});
it('站点动态修订离线时回退到内置可信规则，不阻断静态鱼类目录',async()=>{
  vi.stubGlobal('fetch',vi.fn(()=>Promise.reject(new Error('offline'))));
  invalidateGameData();
  expect(await loadGameData()).toEqual(DEFAULT_GAME_DATA);
  expect(gameDataSource()).toBe('bundled');
});
