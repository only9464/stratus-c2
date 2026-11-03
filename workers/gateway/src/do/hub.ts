/**
 * HubDO —— 单例协调对象。
 *
 * 只做三件事（都是"全局但低频"的）：
 *   1) 注册 nonce 去重（24h），避免把 KV 的写额度烧在注册上
 *   2) 会话在线状态索引（给控制台的"会话列表实时变化"用）
 *   3) 操作员 Hub WebSocket 扇出
 */

import type { Env } from '../types';

interface Attachment {
  role: 'hub';
  opId: string;
}

export class HubDO {
  private readonly sql: SqlStorage;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS nonces (k TEXT PRIMARY KEY, exp INTEGER NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS presence (sid TEXT PRIMARY KEY, status TEXT NOT NULL, ts INTEGER NOT NULL)`);
    });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    switch (url.pathname) {
      case '/nonce':
        return this.handleNonce(req);
      case '/presence':
        return this.handlePresence(req);
      case '/ws':
        return this.handleWs(req);
      case '/sessions':
        return Response.json(this.sql.exec('SELECT sid, status, ts FROM presence ORDER BY ts DESC LIMIT 500').toArray());
      default:
        return new Response('not found', { status: 404 });
    }
  }

  private async handleNonce(req: Request): Promise<Response> {
    const { key, ttl } = (await req.json()) as { key: string; ttl: number };
    if (!key) return new Response('bad request', { status: 400 });
    const now = Math.floor(Date.now() / 1000);
    const hit = this.sql.exec<{ exp: number }>('SELECT exp FROM nonces WHERE k = ?', key).toArray()[0];
    if (hit && hit.exp > now) return new Response('replay', { status: 409 });
    this.sql.exec(
      `INSERT INTO nonces (k, exp) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET exp=excluded.exp`,
      key,
      now + (ttl || 86400),
    );
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null) this.ctx.storage.setAlarm(Date.now() + 3_600_000);
    return new Response('ok');
  }

  private async handlePresence(req: Request): Promise<Response> {
    const { sid, status } = (await req.json()) as { sid: string; status: string };
    if (!sid || !status) return new Response('bad request', { status: 400 });
    this.sql.exec(
      `INSERT INTO presence (sid, status, ts) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET status=excluded.status, ts=excluded.ts`,
      sid,
      status,
      Math.floor(Date.now() / 1000),
    );
    this.broadcast(JSON.stringify({ t: 'session.update', sid, status, ts: Math.floor(Date.now() / 1000) }));
    return new Response('ok');
  }

  private async handleWs(req: Request): Promise<Response> {
    if (req.headers.get('upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const att: Attachment = { role: 'hub', opId: req.headers.get('x-stc2-operator') ?? 'unknown' };
    server.serializeAttachment(att);
    server.send(
      JSON.stringify({
        t: 'hello',
        seq: 0,
        meta: { sessions: this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM presence').toArray()[0]?.n ?? 0 },
      }),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    // 操作员 → Hub：仅支持订阅/心跳，其它忽略
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    if (!text.includes('"t":"hb"')) return;
    try {
      ws.send('{"v":1,"t":"hb_ack","seq":0}');
    } catch {
      /* ignore */
    }
  }

  async alarm(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    this.sql.exec('DELETE FROM nonces WHERE exp < ?', now);
    this.sql.exec('DELETE FROM presence WHERE ts < ?', now - 7 * 86400);
    const left = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM nonces').toArray()[0]?.n ?? 0;
    if (left > 0) this.ctx.storage.setAlarm(Date.now() + 3_600_000);
  }

  private broadcast(text: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        /* ignore */
      }
    }
  }
}
