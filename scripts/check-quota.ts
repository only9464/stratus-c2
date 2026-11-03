#!/usr/bin/env node
/**
 * 配额自检：把"一次演练要花多少免费额度"算出来，并给出水位。
 *
 *   node scripts/check-quota.ts                # 默认场景
 *   node scripts/check-quota.ts 200 24 60      # sessions hours heartbeatSec
 *
 * 依赖 Node ≥ 22 的原生 TS 类型擦除（本项目实测 Node 24 可用）。
 * 与 docs/01-research/01-cloudflare-platform-limits.md §11 的口径一致。
 */

import { estimateUsage, evaluateBudget } from '../packages/shared/src/index.ts';

const [sessions = '100', hours = '24', hb = '60'] = process.argv.slice(2);

const budget = estimateUsage({
  sessions: Number(sessions),
  hours: Number(hours),
  heartbeatSec: Number(hb),
  messagesPerSessionHour: 3,
  avgResultBytes: 2048,
  filesPerDay: 500,
  fileMb: 50,
});

const verdicts = evaluateBudget(budget);

const pad = (s: string, n: number) => s.padEnd(n, ' ');
console.log(`\n场景：${sessions} 会话 / ${hours}h / ${hb}s 心跳\n`);
console.log(pad('指标', 18), pad('用量', 14), pad('额度', 14), '水位');
for (const v of verdicts) {
  const mark = v.level === 'crit' ? '❌' : v.level === 'warn' ? '⚠️ ' : '✅';
  console.log(pad(v.key, 18), pad(String(v.used), 14), pad(String(v.limit), 14), `${mark} ${(v.ratio * 100).toFixed(1)}%`);
}

const crit = verdicts.filter((v) => v.level === 'crit');
if (crit.length) {
  console.log(`\n会撞线的指标：${crit.map((c) => c.key).join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('\n全部在免费额度内。');
}
