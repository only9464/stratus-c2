import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeFrame, encodeFrame, FrameError, SeqWindow, PING_TEXT, parseHelloMeta } from '../src/frames.ts';
import { estimateUsage, evaluateBudget } from '../src/limits.ts';
import { availableChannels } from '../src/channels.ts';

test('帧编码只带必要字段，解码可还原', () => {
  const s = encodeFrame({ v: 1, t: 'hb', seq: 3 });
  assert.equal(s, '{"v":1,"t":"hb","seq":3}');

  const f = decodeFrame(s);
  assert.equal(f.t, 'hb');
  assert.equal(f.seq, 3);
  assert.equal(f.sid, undefined);
});

test('未知版本 / 未知类型 / 坏 seq 被拒绝', () => {
  assert.throws(() => decodeFrame('{"v":2,"t":"hb","seq":1}'), (e: unknown) => e instanceof FrameError && e.code === 'E_VERSION');
  assert.throws(() => decodeFrame('{"v":1,"t":"nope","seq":1}'), (e: unknown) => e instanceof FrameError && e.code === 'E_FORMAT');
  assert.throws(() => decodeFrame('{"v":1,"t":"hb","seq":-1}'), (e: unknown) => e instanceof FrameError);
  assert.throws(() => decodeFrame('not json'), (e: unknown) => e instanceof FrameError);
});

test('超大帧被拒绝（不进入解析）', () => {
  const big = '{"v":1,"t":"hb","seq":1,"meta":{"x":"' + 'a'.repeat(2000) + '"}}';
  assert.throws(() => decodeFrame(big, 1024), (e: unknown) => e instanceof FrameError && e.code === 'E_TOO_LARGE');
});

test('心跳固定串可用于 DO 自动应答', () => {
  const f = decodeFrame(PING_TEXT);
  assert.equal(f.t, 'hb');
  assert.equal(f.seq, 0);
});

test('SeqWindow：有序、乱序、重复、过旧', () => {
  const w = new SeqWindow(8);
  assert.equal(w.check(1), true);
  assert.equal(w.check(2), true);
  assert.equal(w.check(2), false, 'duplicate');
  assert.equal(w.check(4), true, 'gap tolerated');
  assert.equal(w.check(3), true, 'late but inside window');
  assert.equal(w.check(100), true);
  assert.equal(w.check(90), false, 'older than window');
  assert.equal(w.highWater, 100);
});

test('hello meta 解析会截断超长字段', () => {
  const m = parseHelloMeta({
    pub: 'BAA',
    caps: ['shell', 'file', 123 as unknown as string],
    host: 'h'.repeat(1000),
    pid: 42,
  });
  assert.equal(m.pub, 'BAA');
  assert.deepEqual(m.caps, ['shell', 'file']);
  assert.equal(m.host?.length, 512);
  assert.equal(m.pid, 42);
});

test('配额估算：100 会话 24h 不越线', () => {
  const b = estimateUsage({
    sessions: 100,
    hours: 24,
    heartbeatSec: 60,
    messagesPerSessionHour: 3,
    avgResultBytes: 2048,
    filesPerDay: 500,
    fileMb: 50,
  });
  const verdicts = evaluateBudget(b);
  const crit = verdicts.filter((v) => v.level === 'crit');
  // 500 次 x 50 MB = 25 GB/天 -> R2 存储（10 GB-month）必然先撞线（文档点名的瓶颈）
  assert.deepEqual(
    crit.map((v) => v.key),
    ['r2GbMonth'],
  );
  assert.ok(b.workersRequests < 100_000);
  assert.ok(b.doRequests < 100_000);
});

test('通道注册表：缺绑定时 fail-closed', () => {
  assert.deepEqual(
    availableChannels({ SESSION: {} }).map((c) => c.id),
    ['ws', 'http'],
  );
  assert.deepEqual(
    availableChannels({ SESSION: {}, CF_DNS_TOKEN: 'x' }).map((c) => c.id),
    ['ws', 'http', 'doh'],
  );
});
