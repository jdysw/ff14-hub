import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventCategory, extractOfficialActivityRange, extractOfficialLandingRange, readCnCalendar, resetCnCalendarCacheForTests } from '../modules/events/calendar-feed';

afterEach(() => { resetCnCalendarCacheForTests(); vi.unstubAllGlobals(); });

describe('国服官方活动分类', () => {
  it('官方明确标注的版本、活动、联动和商城类别互不混淆', () => {
    expect(eventCategory('7.45版本更新说明')).toBe('版本更新');
    expect(eventCategory('【季节活动】守护天节')).toBe('季节活动');
    expect(eventCategory('糖豆人联动复刻')).toBe('限时联动');
    expect(eventCategory('莫古莫古★大收集')).toBe('莫古莫古大收集');
    expect(eventCategory('月卡启航计划')).toBe('月卡与商城');
    expect(eventCategory('系统维护公告')).toBe('官方公告');
  });
});

describe('盛趣官方公告活动时间提取', () => {
  it('从明确的北京时间完整区间提取', () => {
    const result = extractOfficialActivityRange(
      '<p>活动时间：2026年10月19日 10:00 ～ 2026年11月2日 23:59</p>',
    );
    expect(result).toEqual({
      startsAt: Date.UTC(2026, 9, 19, 2, 0),
      endsAt: Date.UTC(2026, 10, 2, 15, 59),
    });
  });

  it('不将发布时间、签到统计周期或不完整的活动日期推成时间', () => {
    expect(extractOfficialActivityRange('发布于 2026年10月19日 10:00')).toBeNull();
    expect(extractOfficialActivityRange('活动时间：2026年10月19日～11月2日')).toBeNull();
    expect(extractOfficialActivityRange('每日统计时间：2026年10月19日10:00-2026年10月20日10:00')).toBeNull();
    expect(extractOfficialActivityRange('活动时间：2026年2月30日10:00-2026年3月1日10:00')).toBeNull();
  });

  it('拒绝结束早于开始的活动区间', () => {
    expect(extractOfficialActivityRange('活动时间：2026年10月20日10:00-2026年10月19日10:00')).toBeNull();
  });

  it('忽略脚本和样式的伪造活动时间', () => {
    expect(extractOfficialActivityRange(
      '<script>活动时间：2026年10月19日10:00-2026年10月30日10:00</script><p>欢迎</p>',
    )).toBeNull();
  });
});

describe('盛趣官方活动 API 适配器', () => {
  it('does not include upstream URLs or query values in failure diagnostics',async()=>{
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    vi.stubGlobal('fetch',vi.fn(()=>Promise.reject(new TypeError('Failed to fetch https://cqnews.web.sdo.com/api/news/newsList?credential=test-only-private-value'))));
    try{
      await expect(readCnCalendar()).rejects.toThrow();
      const output=warn.mock.calls.map(call=>String(call[0])).join(' ');
      expect(output).toContain('[origin]');expect(output).not.toContain('test-only-private-value');expect(output).not.toContain('https://');
    }finally{warn.mockRestore();}
  });
  it('uses the redirect mode supported by Workers and still rejects redirected origins',async()=>{
    const calls:{url:string;redirect:RequestInit['redirect']}[]=[];
    vi.stubGlobal('fetch',vi.fn((url:string,init?:RequestInit)=>{
      calls.push({url:String(url),redirect:init?.redirect});
      if(init?.redirect==='error')return Promise.reject(new TypeError('redirect:error is unsupported at the edge'));
      return Promise.resolve(new Response('',{status:302,headers:{Location:'https://untrusted.example/calendar'}}));
    }));
    await expect(readCnCalendar()).rejects.toThrow('国服官方活动 API 暂不可用');
    expect(calls).toHaveLength(2);
    expect(calls.every(call=>call.redirect==='manual'&&call.url.startsWith('https://cqnews.web.sdo.com/api/news/'))).toBe(true);
  });
  it('rejects oversized upstream bodies even without a content-length header',async()=>{
    vi.stubGlobal('fetch',vi.fn(()=>Promise.resolve(new Response('x'.repeat(1_000_001),{status:200}))));
    await expect(readCnCalendar()).rejects.toThrow('国服官方活动 API 暂不可用');
  });
  it('仅访问盛趣官方固定路径并保留无法确认起止时间的活动', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      urls.push(String(url));
      if (String(url).includes('newsDetail')) {
        return Promise.resolve(new Response(JSON.stringify({ Code: 0, Data: { Content: String(url).includes('id=41') ? '<p>活动时间：2026年10月20日10:00-2026年11月2日23:59</p>' : '<p>活动时间未公布</p>' } }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ Code: 0, Data: [
        { Id: 41, Title: '季节活动', Summary: '官方公告', OutLink: 'https://ff.web.sdo.com/act' },
        { Id: 42, Title: '未知起止活动', Summary: '等待详细日程', OutLink: 'https://example.com/phishing' },
      ] }), { status: 200 }));
    }));
    const response = await readCnCalendar();
    expect(response.events).toHaveLength(2);
    expect(response.events.find((item) => item.id === 'official:41')?.startsAt).toBe(Date.UTC(2026, 9, 20, 2, 0));
    expect(response.events.find((item) => item.id === 'official:42')?.startsAt).toBeNull();
    expect(response.events.find((item) => item.id === 'official:42')?.sourceUrl).toContain('ff.web.sdo.com');
    expect(response.source.name).toContain('盛趣游戏');
    expect(urls.length).toBeGreaterThan(1);
    expect(urls.every((url) => url.startsWith('https://cqnews.web.sdo.com/api/news/'))).toBe(true);
    const count=urls.length;
    await readCnCalendar();
    expect(urls).toHaveLength(count);
    await readCnCalendar(Date.now(),undefined,true);
    expect(urls.length).toBeGreaterThan(count);
  });
});

describe('官方专题时间与两个栏目去重', () => {
  it('解析官方专题明确的同年短格式，并拒绝缺年份的跨年区间', () => {
    expect(extractOfficialLandingRange(
      '<script>不应提取脚本日期</script><p class="jp">2026年10月15日16:00 ～ 11月2日22:59</p>',
    )).toEqual({
      startsAt: Date.UTC(2026, 9, 15, 8, 0),
      endsAt: Date.UTC(2026, 10, 2, 14, 59),
    });
    expect(extractOfficialLandingRange('2026年12月28日16:00 ～ 1月3日22:59')).toBeNull();
    expect(extractOfficialActivityRange('2026年10月15日16:00 ～ 11月2日22:59')).toBeNull();
  });

  it('合并 5311 与 5203 的同名活动，直接取官方专题时间，排除非活动商城新闻', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const uri = String(url);
      calls.push(uri);
      let data: unknown;
      if (uri.includes('CategoryCode=5311')) {
        data = { Code: '0', Data: [{ Id: 393660, Title: 'FF14 x 糖豆人联动复刻限时开启！',
          Summary: '', PublishDate: '2026/09/30 17:03:43', OutLink: '' }] };
      } else if (uri.includes('CategoryCode=5203')) {
        data = { Code: '0', Data: [
          { Id: 394275, Title: '【季节活动】守护天节与奇妙的捉迷藏',
            Summary: '', PublishDate: '2026/10/15 14:21:38',
            OutLink: 'https://actff1.web.sdo.com/project/seasonal/index.html' },
          { Id: 393967, Title: 'FF14 x 糖豆人联动复刻限时开启！',
            Summary: '', PublishDate: '2026/10/08 15:26:13',
            OutLink: 'https://actff1.web.sdo.com/project/fallguys/index.html' },
          { Id: 394286, Title: '道具商城上新：往年守护天节道具',
            Summary: '', PublishDate: '2026/10/15 17:04:39',
            OutLink: 'https://ff.web.sdo.com/web7/news/news.html?id=394286' },
        ] };
      } else if (uri.includes('newsDetail?id=invalid')) {
        data = { Code: '500' };
      } else if (uri.includes('newsDetail')) {
        data = { Code: '0', Data: { Content: uri.includes('393660')
          ? '<p>活动时间：2026年10月7日16:00～2026年10月27日22:59</p>' : '' } };
      } else {
        return Promise.resolve(new Response('<p class="jp">2026年10月15日16:00 ～ 11月2日22:59</p>', { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify(data), { status: 200,
        headers: { 'Content-Type': 'application/json' } }));
    }));
    const value = await readCnCalendar();
    expect(value.events).toHaveLength(2);
    expect(value.events.map((e) => e.title).join(' ')).not.toContain('商城');
    const seasonal = value.events.find((e) => e.title.includes('守护天节'));
    const collab = value.events.find((e) => e.title.includes('糖豆人'));
    expect(seasonal?.startsAt).toBe(Date.UTC(2026, 9, 15, 8, 0));
    expect(seasonal?.endsAt).toBe(Date.UTC(2026, 10, 2, 14, 59));
    expect(collab?.startsAt).toBe(Date.UTC(2026, 9, 7, 8, 0));
    expect(collab?.sourceUrl).toContain('/project/fallguys/');
    expect(calls.some((url) => url.includes('/project/seasonal/'))).toBe(true);
    expect(calls.every((url) => url.startsWith('https://cqnews.web.sdo.com/api/news/') ||
      url.startsWith('https://actff1.web.sdo.com/project/'))).toBe(true);
  });
});
