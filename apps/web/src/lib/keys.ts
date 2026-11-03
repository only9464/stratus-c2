/**
 * 操作员密钥：生成 / 持久化（IndexedDB）/ 登记公钥 / 计算指纹。
 *
 * 私钥是 `CryptoKey` 对象，直接结构化克隆进 IndexedDB —— 明文字节从不暴露给 JS。
 * 代价：浏览器清站点数据 = 密钥丢失 = 历史结果永久不可读（文档里已明示）。
 */

import { exportPubRaw, fingerprint, generateEcdhKeyPair } from '@stratus/shared';
import { api } from './api';

const DB_NAME = 'stratus';
const STORE = 'keys';
const CURRENT = 'current';

export interface StoredKey {
  keyId: string;
  fp: string;
  priv: CryptoKey;
  pub: CryptoKey;
  createdAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(value: StoredKey): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, CURRENT);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadKey(): Promise<StoredKey | null> {
  const db = await openDb();
  const value = await new Promise<StoredKey | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(CURRENT);
    req.onsuccess = () => resolve((req.result as StoredKey | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return value;
}

export async function clearKey(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(CURRENT);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  localStorage.removeItem('stc2.ridmap');
  localStorage.removeItem('stc2.ctr');
}

/** 生成新密钥对并存本地（extractable=false：私钥不可导出为明文）。 */
export async function generateKey(): Promise<StoredKey> {
  const pair = await generateEcdhKeyPair(false);
  const raw = await exportPubRaw(pair.publicKey);
  const fp = await fingerprint(raw);
  const keyId = `k_${fp}`;
  const stored: StoredKey = {
    keyId,
    fp,
    priv: pair.privateKey,
    pub: pair.publicKey,
    createdAt: Math.floor(Date.now() / 1000),
  };
  await put(stored);
  return stored;
}

/** 把当前公钥登记到服务端（团队默认 key = 最近登记且未吊销的那把）。 */
export async function registerKey(key: StoredKey): Promise<void> {
  const raw = await exportPubRaw(key.pub);
  await api.post('/api/v1/keys', {
    keyId: key.keyId,
    pub: toB64(raw),
    fp: key.fp,
  });
}

function toB64(bytes: Uint8Array): string {
  // 与 @stratus/shared 的 toB64u 等价，这里手写一次避免循环依赖
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += alphabet[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += alphabet[b2 & 63];
  }
  return out;
}
