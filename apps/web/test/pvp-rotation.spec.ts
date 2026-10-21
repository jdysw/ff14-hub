import {describe,expect,it} from 'vitest';
import {
  beijingDate,crystallineAt,crystallineSchedule,CRYSTAL_MAPS,formatPvpCountdown,
  frontlineAt,frontlineSchedule,FRONTLINE_MAPS,
} from '../src/app/pvp/rotation';

describe('PVP fixed-map schedules (Beijing time)',()=>{
  const oct21_1010=Date.parse('2026-10-21T02:10:00Z');
  it('uses the specified second 尘封 anchor so the next day is 周边遗迹群',()=>{
    expect(FRONTLINE_MAPS).toEqual([
      '尘封秘岩（争夺战）','荣誉野（碎冰战）','昂萨哈凯尔（竞争战）','沃刻其特（演习战）',
      '尘封秘岩（争夺战）','周边遗迹群（阵地战）','昂萨哈凯尔（竞争战）','沃刻其特（演习战）',
    ]);
    expect(frontlineAt(oct21_1010)).toMatchObject({
      current:'尘封秘岩（争夺战）',next:'周边遗迹群（阵地战）',index:4,
      changesAt:Date.parse('2026-10-21T16:00:00Z'),
    });
    expect(frontlineAt(Date.parse('2026-10-21T15:59:59Z')).current).toBe('尘封秘岩（争夺战）');
    expect(frontlineAt(Date.parse('2026-10-21T16:00:00Z')).current).toBe('周边遗迹群（阵地战）');
    expect(frontlineAt(Date.parse('2026-10-28T02:10:00Z')).current).toBe('沃刻其特（演习战）');
    expect(frontlineAt(Date.parse('2026-10-29T02:10:00Z')).current).toBe('尘封秘岩（争夺战）');
  });
  it('uses the specified seven-map crystalline sequence and rolls at exact hours',()=>{
    expect(CRYSTAL_MAPS).toEqual(['角力学校','火山之心','海岸斗场','九霄云上','机关大殿','休兵书库','赤土红沙']);
    expect(crystallineAt(oct21_1010)).toMatchObject({
      current:'赤土红沙',next:'角力学校',index:6,
      changesAt:Date.parse('2026-10-21T03:00:00Z'),
    });
    expect(crystallineAt(Date.parse('2026-10-21T01:59:59Z')).current).toBe('休兵书库');
    expect(crystallineAt(Date.parse('2026-10-21T03:00:00Z')).current).toBe('角力学校');
    expect(crystallineAt(Date.parse('2026-10-21T04:00:00Z')).current).toBe('火山之心');
    expect(crystallineAt(Date.parse('2026-10-21T09:00:00Z')).current).toBe('赤土红沙');
  });
  it('creates correctly ordered full schedules and stable Beijing dates independent of client timezone',()=>{
    const front=frontlineSchedule(oct21_1010);
    expect(front).toHaveLength(8);
    expect(front[0]?.date).toBe('2026-10-21');
    expect(front[1]?.date).toBe('2026-10-22');
    expect(front[1]?.current).toBe('周边遗迹群（阵地战）');
    const crystal=crystallineSchedule(oct21_1010);
    expect(crystal).toHaveLength(8);
    expect(crystal[0]).toMatchObject({date:'2026-10-21',startHour:'10:00',endHour:'11:00',current:'赤土红沙'});
    expect(crystal[1]?.current).toBe('角力学校');
    expect(crystal[7]?.current).toBe('赤土红沙');
    expect(beijingDate(Date.parse('2026-10-21T16:00:00Z'))).toBe('2026-10-22');
    expect(formatPvpCountdown(Date.parse('2026-10-21T03:00:00Z'),oct21_1010)).toBe('00:50:00');
    expect(formatPvpCountdown(oct21_1010-1_000,oct21_1010)).toBe('00:00:00');
  });
});
