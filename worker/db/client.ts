/**
 * Drizzle 客户端工厂。
 *
 * 说明：本文件**不**创建连接池，也不在启动时修改 schema（规划 4.1：
 * 不允许启动时隐式改生产 Schema）。schema 变更只通过 migrations/*.sql 显式应用。
 */
import { drizzle } from 'drizzle-orm/d1';
import { schema } from './schema';

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Database = ReturnType<typeof createDb>;
