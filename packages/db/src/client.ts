/**
 * D1 + Drizzle 客户端工厂。
 *
 * 用法：
 *   const db = createDb(c.env.DB);
 *   const rows = await db.select().from(sessions).where(eq(sessions.status, 'online')).limit(50);
 *
 * 注意：D1 单库单写者、单次调用最多 50 条查询（免费），
 * 所以业务代码里**禁止 N+1**，批量写一律 `db.batch([...])`。
 */

import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof createDb>;

export { sql, eq, and, or, desc, asc, gte, lte, inArray, like, isNull, isNotNull, count } from 'drizzle-orm';
export * as t from './schema';
