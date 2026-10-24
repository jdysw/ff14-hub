/** 当前公开 API 与站点管理员集成测试共用的最小辅助。 */
import type {RuntimeEnv} from '../env';

export const TEST_BASE_URL='https://ff14-hub.test';
export function partialEnv(values:Partial<RuntimeEnv>):RuntimeEnv{
  return values as RuntimeEnv;
}
