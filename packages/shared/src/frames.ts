/**
 * L1 信封的编解码与重放防护。
 * 服务端只解析这一层；`ct` 里的内容是端到端密文，服务端不解。
 */

import { LIMITS, PROTO_V } from './constants.ts';

export type FrameType =
  | 'hello'
  | 'hello_ack'
  | 'hb'
  | 'hb_ack'
  | 'cmd'
  | 'res'
  | 'io'
  | 'file'
  | 'ack'
  | 'screen'
  | 'pivot'
  | 'bye'
  | 'err';

const FRAME_TYPES = new Set<string>([
  'hello',
  'hello_ack',
  'hb',
  'hb_ack',
  'cmd',
  'res',
  'io',
  'file',
  'ack',
  'screen',
  'pivot',
  'bye',
  'err',
]);

export interface Frame {
  v: number;
  t: FrameType;
  sid?: string;
  seq: number;
  ts?: number;
  n?: string;
  ct?: string;
  meta?: Record<string, unknown>;
}

export class FrameError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'FrameError';
    this.code = code;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeFrame(f: Frame): string {
  const out: Record<string, unknown> = { v: PROTO_V, t: f.t, seq: f.seq };
  if (f.sid !== undefined) out['sid'] = f.sid;
  if (f.ts !== undefined) out['ts'] = f.ts;
  if (f.n !== undefined) out['n'] = f.n;
  if (f.ct !== undefined) out['ct'] = f.ct;
  if (f.meta !== undefined) out['meta'] = f.meta;
  return JSON.stringify(out);
}

export function decodeFrame(input: string | ArrayBuffer | Uint8Array, maxBytes = LIMITS.maxFrameCt + 4096): Frame {
  let text: string;
  if (typeof input === 'string') {
    text = input;
    if (text.length > maxBytes) throw new FrameError('E_TOO_LARGE', 'frame too large');
  } else {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.byteLength > maxBytes) throw new FrameError('E_TOO_LARGE', 'frame too large');
    text = dec.decode(bytes);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FrameError('E_FORMAT', 'invalid json');
  }
  if (typeof raw !== 'object' || raw === null) throw new FrameError('E_FORMAT', 'frame must be an object');

  const o = raw as Record<string, unknown>;
  if (o['v'] !== PROTO_V) throw new FrameError('E_VERSION', 'unsupported protocol version');
  const t = o['t'];
  if (typeof t !== 'string' || !FRAME_TYPES.has(t)) throw new FrameError('E_FORMAT', 'unknown frame type');
  const seq = o['seq'];
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) throw new FrameError('E_FORMAT', 'bad seq');

  const frame: Frame = { v: PROTO_V, t: t as FrameType, seq };
  if (typeof o['sid'] === 'string') frame.sid = o['sid'];
  if (typeof o['ts'] === 'number') frame.ts = o['ts'];
  if (typeof o['n'] === 'string') frame.n = o['n'];
  if (typeof o['ct'] === 'string') {
    if (o['ct'].length > Math.ceil(LIMITS.maxFrameCt / 3) * 4) {
      throw new FrameError('E_TOO_LARGE', 'ciphertext too large');
    }
    frame.ct = o['ct'];
  }
  if (o['meta'] !== undefined) {
    if (typeof o['meta'] !== 'object' || o['meta'] === null) throw new FrameError('E_FORMAT', 'bad meta');
    frame.meta = o['meta'] as Record<string, unknown>;
  }
  return frame;
}

/** 心跳固定串：DO 用 `setWebSocketAutoResponse` 匹配它，完全不唤醒对象。 */
export const PING_TEXT = '{"v":1,"t":"hb","seq":0}';
export const PONG_TEXT = '{"v":1,"t":"hb_ack","seq":0}';

/**
 * 滑动窗口去重：容忍乱序，拒绝重复与过旧。
 * `highest` 是高水位，`seen` 记录窗口内已见过的 seq。
 */
export class SeqWindow {
  private highest = 0;
  private readonly seen = new Set<number>();
  private readonly size: number;

  constructor(size = LIMITS.seqWindow) {
    this.size = size;
  }

  /** 返回 true 表示"新帧，可以处理"；false 表示重复/过旧，应丢弃。 */
  check(seq: number): boolean {
    if (!Number.isInteger(seq) || seq <= 0) return false;
    if (seq <= this.highest - this.size) return false; // 过旧（超出窗口）
    if (this.seen.has(seq)) return false; // 重复
    this.seen.add(seq);
    if (seq > this.highest) this.highest = seq;
    this.trim();
    return true;
  }

  get highWater(): number {
    return this.highest;
  }

  private trim(): void {
    const floor = this.highest - this.size;
    if (floor <= 0) return;
    for (const s of this.seen) {
      if (s <= floor) this.seen.delete(s);
    }
  }
}

/** hello 帧的 meta 形状（服务端用）。 */
export interface HelloMeta {
  pub?: string;
  caps?: string[];
  host?: string;
  user?: string;
  os?: string;
  arch?: string;
  pid?: number;
  ip?: string;
  fp?: string;
}

export function parseHelloMeta(meta: Record<string, unknown> | undefined): HelloMeta {
  if (!meta) return {};
  const out: HelloMeta = {};
  if (typeof meta['pub'] === 'string') out.pub = meta['pub'];
  if (Array.isArray(meta['caps'])) out.caps = meta['caps'].filter((x): x is string => typeof x === 'string').slice(0, 32);
  for (const k of ['host', 'user', 'os', 'arch', 'ip', 'fp'] as const) {
    const v = meta[k];
    if (typeof v === 'string') out[k] = v.slice(0, 512);
  }
  if (typeof meta['pid'] === 'number') out.pid = meta['pid'];
  return out;
}
