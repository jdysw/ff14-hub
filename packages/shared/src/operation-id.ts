/** 本机钓鱼进度与数据导入的幂等操作标识；不依赖已退役服务端工作台。 */
import {z} from 'zod';
export const operationIdSchema=z.string().min(8).max(64)
  .regex(/^[A-Za-z0-9_-]+$/,'operationId 只允许字母、数字、下划线与连字符');
