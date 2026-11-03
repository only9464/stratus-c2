/**
 * 密码学原语（WebCrypto）。服务端、浏览器、以及任何实现了同名算法的植入体都应得到相同结果。
 *
 * 选型说明见 docs/02-architecture/04-crypto-design.md：
 *   ECDH P-256 + HKDF-SHA256 + AES-256-GCM，三端（Workers / 浏览器 / Go / .NET）都稳定可用。
 *
 * 实现说明：`shared` 同时被 Workers（@cloudflare/workers-types）和浏览器（lib.dom）编译，
 * 两套 `SubtleCrypto` 类型对 `BufferSource`/`EcdhKeyDeriveParams` 的定义不一致
 * （Workers 用 `$public`，DOM 用 `public`）。这里用一个本地 facade 把差异收敛在一处，
 * 业务代码不再接触环境相关的类型。
 */

import { KDF_INFO, AAD_PREFIX, DIR, type KeyDomain } from './constants.ts';
import { concatBytes, fromB64u, toB64u, toHex, u64be, utf8 } from './b64.ts';

const enc = new TextEncoder();

interface SubtleFacade {
  digest(alg: string, data: Uint8Array): Promise<ArrayBuffer>;
  importKey(format: string, keyData: Uint8Array, alg: unknown, extractable: boolean, usages: string[]): Promise<CryptoKey>;
  exportKey(format: string, key: CryptoKey): Promise<ArrayBuffer>;
  sign(alg: unknown, key: CryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
  verify(alg: unknown, key: CryptoKey, sig: Uint8Array, data: Uint8Array): Promise<boolean>;
  deriveBits(alg: unknown, key: CryptoKey, length: number): Promise<ArrayBuffer>;
  encrypt(alg: unknown, key: CryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(alg: unknown, key: CryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
  generateKey(alg: unknown, extractable: boolean, usages: string[]): Promise<CryptoKeyPair>;
}

const subtle = crypto.subtle as unknown as SubtleFacade;

/* ───────────────────────────── 基础 ───────────────────────────── */

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest('SHA-256', data));
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, data));
}

export async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array | undefined,
  info: string,
  lengthBytes = 32,
): Promise<Uint8Array> {
  const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt ?? new Uint8Array(0), info: enc.encode(info) },
    base,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

/** 恒定时间比较（长度不等直接 false，但仍遍历较长的以模糊长度差异）。 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/* ───────────────────────────── AEAD ───────────────────────────── */

export async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function aesGcmEncrypt(
  key: CryptoKey,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, plaintext);
  return new Uint8Array(ct);
}

export async function aesGcmDecrypt(
  key: CryptoKey,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, ciphertext);
  return new Uint8Array(pt);
}

/* ───────────────────────────── ECDH P-256 ───────────────────────────── */

export async function generateEcdhKeyPair(extractable = false): Promise<CryptoKeyPair> {
  return subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, extractable, ['deriveBits']);
}

/** 导出未压缩公钥点（65 字节：0x04 || X || Y）。 */
export async function exportPubRaw(key: CryptoKey): Promise<Uint8Array> {
  const spki = new Uint8Array(await subtle.exportKey('spki', key));
  return spki.slice(spki.length - 65);
}

export async function importPubRaw(raw: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

/** 计算共享秘密 Z（32 字节）。 */
export async function deriveSharedZ(privateKey: CryptoKey, peerPubRaw: Uint8Array): Promise<Uint8Array> {
  const peer = await importPubRaw(peerPubRaw);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  return new Uint8Array(bits);
}

/** 公钥指纹：SHA256(pub)[:8] 的 hex（16 个字符）。 */
export async function fingerprint(pubRaw: Uint8Array): Promise<string> {
  const h = await sha256(pubRaw);
  return toHex(h.slice(0, 8));
}

/* ───────────────────────────── 会话密钥 ───────────────────────────── */

export interface SessionKeys {
  cmd: CryptoKey;
  io: CryptoKey;
  file: CryptoKey;
  /** 原始字节，便于需要时导出（例如 CLI 调试），默认不暴露给业务代码。 */
  raws: Record<KeyDomain, Uint8Array>;
}

/**
 * 由共享秘密派生三条会话密钥。
 * salt 用 sid，确保"同一对密钥在不同会话里派生出不同密钥"。
 */
export async function deriveSessionKeys(z: Uint8Array, sid: Uint8Array): Promise<SessionKeys> {
  const raws = {
    reg: await hkdf(z, sid, KDF_INFO.reg),
    sess: await hkdf(z, sid, KDF_INFO.sess),
    cmd: await hkdf(z, sid, KDF_INFO.cmd),
    io: await hkdf(z, sid, KDF_INFO.io),
    file: await hkdf(z, sid, KDF_INFO.file),
  };
  return {
    cmd: await importAesKey(raws.cmd),
    io: await importAesKey(raws.io),
    file: await importAesKey(raws.file),
    raws,
  };
}

export function keyForDomain(keys: SessionKeys, domain: KeyDomain): CryptoKey {
  switch (domain) {
    case 'cmd':
      return keys.cmd;
    case 'io':
      return keys.io;
    case 'file':
      return keys.file;
    default:
      throw new Error(`domain ${domain} is not an AEAD domain`);
  }
}

/* ───────────────────────────── L1 认证 ───────────────────────────── */

/** K_reg = HKDF(psk, info="stc2/v1/reg")；服务端只存这个，不存 psk。 */
export async function deriveKReg(psk: Uint8Array): Promise<Uint8Array> {
  return hkdf(psk, undefined, KDF_INFO.reg);
}

export async function deriveKSess(psk: Uint8Array): Promise<Uint8Array> {
  return hkdf(psk, undefined, KDF_INFO.sess);
}

/** 注册用的 HMAC：HMAC(K_reg, psk_id || "." || ts || "." || nc)。 */
export async function registerHmac(
  kReg: Uint8Array,
  pskId: string,
  ts: number,
  ncB64u: string,
): Promise<Uint8Array> {
  return hmacSha256(kReg, utf8(`${pskId}.${ts}.${ncB64u}`));
}

/** session_token = b64u(HMAC(K_sess, sid || pub || issued_at))。 */
export async function sessionToken(
  kSess: Uint8Array,
  sid: Uint8Array,
  implantPubRaw: Uint8Array,
  issuedAt: number,
): Promise<string> {
  const msg = concatBytes(sid, implantPubRaw, utf8(String(issuedAt)));
  return toB64u(await hmacSha256(kSess, msg));
}

export async function verifySessionToken(
  kSess: Uint8Array,
  sid: Uint8Array,
  implantPubRaw: Uint8Array,
  issuedAt: number,
  token: string,
): Promise<boolean> {
  const expected = await sessionToken(kSess, sid, implantPubRaw, issuedAt);
  return timingSafeEqual(fromB64u(expected), fromB64u(token));
}

/* ───────────────────────────── nonce / AAD ───────────────────────────── */

/** nonce = 4 字节前缀 || 8 字节计数器（大端）。 */
export function makeNonce(prefix: Uint8Array, counter: number): Uint8Array {
  if (prefix.length !== 4) throw new Error('nonce prefix must be 4 bytes');
  return concatBytes(prefix, u64be(counter));
}

/**
 * AAD = "stc2/v1" || dir || sid(16) || ctr(8) || rid(8)。
 *
 * `ctr` 是**发送方**选取的、每会话每方向单调递增的计数器，同时用作 GCM nonce 的后 8 字节。
 * 它故意不依赖传输层的 `seq`——否则发送方要先向服务端"预订"序号才能加密，
 * 而服务端零知识要求"加密必须在发送方本地一次完成"。
 */
export function buildAad(
  dir: (typeof DIR)[keyof typeof DIR],
  sid: Uint8Array,
  ctr: number,
  rid: Uint8Array,
): Uint8Array {
  if (sid.length !== 16) throw new Error('sid must be 16 bytes');
  if (rid.length !== 8) throw new Error('rid must be 8 bytes');
  return concatBytes(utf8(AAD_PREFIX), new Uint8Array([dir]), sid, u64be(ctr), rid);
}

/* ───────────────────────────── 便捷封装 ───────────────────────────── */

export async function encryptJson(
  key: CryptoKey,
  nonce: Uint8Array,
  value: unknown,
  aad: Uint8Array,
): Promise<string> {
  const ct = await aesGcmEncrypt(key, nonce, enc.encode(JSON.stringify(value)), aad);
  return toB64u(ct);
}

export async function decryptJson<T>(
  key: CryptoKey,
  nonce: Uint8Array,
  ctB64u: string,
  aad: Uint8Array,
): Promise<T> {
  const pt = await aesGcmDecrypt(key, nonce, fromB64u(ctB64u), aad);
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}
