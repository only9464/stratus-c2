# ADR-0006：用 Drizzle ORM 而不是手写 SQL

- 状态：已接受（2026-11）
- 影响面：`packages/db`、两个 worker 的所有 D1 访问

## 背景

D1 的 SQL 是 SQLite 方言，手写 `db.prepare(...).bind(...)` 最直接，但：

- 列名（`snake_case`）与 TS 字段（`camelCase`）要手写映射，容易错；
- 改表结构时，编译期发现不了"这里还引用着旧列名"；
- 多表 join 的字段别名散落在字符串里；
- 迁移没有单一真源。

## 决定

- **schema 是唯一真源**：`packages/db/src/schema.ts`（Drizzle `sqliteTable`）；
- 业务代码用 `createDb(env.DB)`（`drizzle-orm/d1`），禁止再写 `prepare().bind()`；
- 迁移由 `drizzle-kit generate` 产出到 `db/migrations/`，用 `wrangler d1 migrations apply` 执行；
- 批量写用 `db.batch([...])`（只算 1 次查询额度，绕过"单次调用 50 查询"上限）。

## 代价

| 代价 | 说明 |
|---|---|
| 多一层依赖 | `drizzle-orm`（Apache-2.0）+ `drizzle-kit`（dev） |
| bundle 变大 | 约 +40 KB（gzip 后 ~12 KB），在 64 MiB 上限内无感 |
| 复杂 SQL 要下降 | 用 `sql\`...\`` 模板拼，别硬套查询构造器 |
| 迁移文件名随机 | drizzle 生成 `0000_xxx.sql`，本项目已重命名为 `0000_init.sql` 并同步 `meta/_journal.json` |

## 约束（写进 CI 的检查清单）

1. 请求内禁止 N+1：一个列表接口最多 2~3 条查询（列表 + 计数 + 聚合）。
2. 禁止在 DO 里做跨会话查询（DO 只查自己的 SQLite）。
3. 审计与结果元数据用 `db.batch()`，不要循环 insert。
4. 改表必须走 `pnpm --filter @stratus/db generate`，**不许手改已提交的迁移**。

## 什么情况下推翻

- 需要 SQLite 的 FTS5 全文检索且 Drizzle 表达不了（用 `sql` 模板即可，不必推翻）；
- Drizzle 对 D1 的 batch 支持出现回归（届时局部退回 `prepare`，但保留 schema 作为真源）。
