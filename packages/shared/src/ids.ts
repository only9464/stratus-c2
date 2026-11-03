/**
 * ID 生成。全部为"无含义的随机字节"的 base64url，避免把时间/机器信息编码进 ID。
 */

import { randomBytes, toB64u } from './b64.ts';

/** 会话 ID：16 字节（128 bit）。 */
export function newSid(): string {
  return toB64u(randomBytes(16));
}

/** 请求 ID：8 字节。 */
export function newRid(): string {
  return toB64u(randomBytes(8));
}

/** 任务 ID：16 字节。 */
export function newTid(): string {
  return toB64u(randomBytes(16));
}

/** 载荷 PSK ID：8 字节。 */
export function newPskId(): string {
  return toB64u(randomBytes(8));
}

/** PSK 本体：32 字节。 */
export function newPsk(): string {
  return toB64u(randomBytes(32));
}

/** 一次性下载令牌：24 字节。 */
export function newDownloadToken(): string {
  return toB64u(randomBytes(24));
}

/** 通用短 ID（带前缀，便于日志里辨认）。 */
export function shortId(prefix: string): string {
  return `${prefix}_${toB64u(randomBytes(9))}`;
}
