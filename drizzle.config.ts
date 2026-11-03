import type { Config } from 'drizzle-kit';

/**
 * drizzle-kit 配置：从 `packages/db/src/schema.ts` 生成 D1 迁移。
 *
 *   pnpm --filter @stratus/db generate     # 生成 db/migrations/000N_*.sql
 *   pnpm db:migrate                        # wrangler d1 migrations apply
 *
 * 生成的 SQL 与 `docs/02-architecture/03-data-model.md` 的 DDL 一一对应；
 * 迁移文件**只增不改**，改表结构 = 生成新迁移。
 */
export default {
  dialect: 'sqlite',
  driver: 'd1-http',
  schema: './packages/db/src/schema.ts',
  out: './db/migrations',
  strict: true,
  verbose: true,
} satisfies Config;
