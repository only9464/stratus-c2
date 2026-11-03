import test from 'node:test';
import assert from 'node:assert/strict';

import { fromB64u, toB64u, randomBytes, concatBytes } from '../src/b64.ts';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  buildAad,
  deriveKReg,
  deriveKSess,
  deriveSessionKeys,
  deriveSharedZ,
  exportPubRaw,
  fingerprint,
  generateEcdhKeyPair,
  hkdf,
  hmacSha256,
  importAesKey,
  makeNonce,
  registerHmac,
  sessionToken,
  sha256,
  timingSafeEqual,
  verifySessionToken,
} from '../src/crypto.ts';
import { DIR } from '../src/constants.ts';

test('base64url 往返（含各种长度与边界）', () => {
  for (const len of [0, 1, 2, 3, 4, 5, 16, 31, 32, 65, 255]) {
    const bytes = randomBytes(len);
    const rt = fromB64u(toB64u(bytes));
    assert.equal(rt.length, len);
    assert.deepEqual(Array.from(rt), Array.from(bytes));
  }
  // 不应出现 URL 不安全字符或 padding
  const s = toB64u(randomBytes(64));
  assert.ok(!/[+/=]/.test(s), 'must be base64url without padding');
});

test('HKDF 域分隔：不同 info 得到不同密钥', async () => {
  const ikm = randomBytes(32);
  const a = await hkdf(ikm, undefined, 'stc2/v1/cmd');
  const b = await hkdf(ikm, undefined, 'stc2/v1/io');
  const a2 = await hkdf(ikm, undefined, 'stc2/v1/cmd');
  assert.equal(a.length, 32);
  assert.deepEqual(Array.from(a), Array.from(a2), 'deterministic');
  assert.notDeepEqual(Array.from(a), Array.from(b), 'domain separated');
});

test('HMAC 恒定时间比较', async () => {
  const key = randomBytes(32);
  const m = new Uint8Array([1, 2, 3]);
  const sig = await hmacSha256(key, m);
  const sig2 = await hmacSha256(key, m);
  assert.ok(timingSafeEqual(sig, sig2));
  const bad = new Uint8Array(sig);
  bad[0] ^= 0xff;
  assert.ok(!timingSafeEqual(sig, bad));
  assert.ok(!timingSafeEqual(sig, sig.slice(0, 16)));
});

test('AES-256-GCM：往返 + 篡改检测 + AAD 绑定', async () => {
  const key = await importAesKey(randomBytes(32));
  const nonce = randomBytes(12);
  const sid = randomBytes(16);
  const rid = randomBytes(8);
  const aad = buildAad(DIR.opToImplant, sid, 7, rid);
  const pt = new TextEncoder().encode('{"k":"shell.exec","a":{"cmd":"whoami"}}');

  const ct = await aesGcmEncrypt(key, nonce, pt, aad);
  const back = await aesGcmDecrypt(key, nonce, ct, aad);
  assert.deepEqual(Array.from(back), Array.from(pt));

  // 篡改密文
  const tampered = new Uint8Array(ct);
  tampered[3] ^= 0x01;
  await assert.rejects(() => aesGcmDecrypt(key, nonce, tampered, aad));

  // 换 seq（AAD 变化）必须失败
  const otherAad = buildAad(DIR.opToImplant, sid, 8, rid);
  await assert.rejects(() => aesGcmDecrypt(key, nonce, ct, otherAad));

  // 换方向必须失败
  const wrongDir = buildAad(DIR.implantToOp, sid, 7, rid);
  await assert.rejects(() => aesGcmDecrypt(key, nonce, ct, wrongDir));
});

test('nonce 由 4B 前缀 + 8B 计数器组成', () => {
  const prefix = new Uint8Array([1, 2, 3, 4]);
  const n = makeNonce(prefix, 0x0001020304050607);
  assert.equal(n.length, 12);
  assert.deepEqual(Array.from(n.slice(0, 4)), [1, 2, 3, 4]);
  assert.deepEqual(Array.from(n.slice(4)), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.throws(() => makeNonce(new Uint8Array(3), 1));
});

test('ECDH P-256：两端算出同一个 Z，且密钥可派生', async () => {
  const alice = await generateEcdhKeyPair();
  const bob = await generateEcdhKeyPair();
  const alicePub = await exportPubRaw(alice.publicKey);
  const bobPub = await exportPubRaw(bob.publicKey);
  assert.equal(alicePub.length, 65);
  assert.equal(alicePub[0], 0x04);

  const z1 = await deriveSharedZ(alice.privateKey, bobPub);
  const z2 = await deriveSharedZ(bob.privateKey, alicePub);
  assert.equal(z1.length, 32);
  assert.deepEqual(Array.from(z1), Array.from(z2));

  const sid = randomBytes(16);
  const k1 = await deriveSessionKeys(z1, sid);
  const k2 = await deriveSessionKeys(z2, sid);
  assert.deepEqual(Array.from(k1.raws.cmd), Array.from(k2.raws.cmd));

  // 不同会话（不同 sid）派生不同密钥
  const k3 = await deriveSessionKeys(z1, randomBytes(16));
  assert.notDeepEqual(Array.from(k1.raws.cmd), Array.from(k3.raws.cmd));
});

test('Z 相同但公钥不同时指纹不同', async () => {
  const a = await generateEcdhKeyPair();
  const b = await generateEcdhKeyPair();
  const fa = await fingerprint(await exportPubRaw(a.publicKey));
  const fb = await fingerprint(await exportPubRaw(b.publicKey));
  assert.match(fa, /^[0-9a-f]{16}$/);
  assert.notEqual(fa, fb);
});

test('注册 HMAC 与 session token 的验证路径', async () => {
  const psk = randomBytes(32);
  const kReg = await deriveKReg(psk);
  const kSess = await deriveKSess(psk);
  assert.notDeepEqual(Array.from(kReg), Array.from(kSess));

  const h = await registerHmac(kReg, 'psk_1', 1763000000, 'nonce_abc');
  assert.equal(h.length, 32);

  const sid = randomBytes(16);
  const kp = await generateEcdhKeyPair();
  const pub = await exportPubRaw(kp.publicKey);
  const tok = await sessionToken(kSess, sid, pub, 1763000000);
  assert.ok(await verifySessionToken(kSess, sid, pub, 1763000000, tok));
  assert.ok(!(await verifySessionToken(kSess, sid, pub, 1763000001, tok)), 'issued_at is bound');
  assert.ok(!(await verifySessionToken(kSess, randomBytes(16), pub, 1763000000, tok)), 'sid is bound');
});

test('AAD 构造的长度与分隔', async () => {
  const sid = randomBytes(16);
  const rid = randomBytes(8);
  const aad = buildAad(DIR.implantToOp, sid, 1, rid);
  // "stc2/v1"(7) + dir(1) + sid(16) + seq(8) + rid(8)
  assert.equal(aad.length, 40);
  assert.equal(new TextDecoder().decode(aad.slice(0, 7)), 'stc2/v1');
  assert.equal(aad[7], 1);
  assert.throws(() => buildAad(DIR.implantToOp, new Uint8Array(15), 1, rid));
});

test('sha256 与拼接工具', async () => {
  const h = await sha256(new Uint8Array([0x61]));
  assert.equal(
    Array.from(h)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(''),
    'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
  );
  const c = concatBytes(new Uint8Array([1]), new Uint8Array([2, 3]));
  assert.deepEqual(Array.from(c), [1, 2, 3]);
});
