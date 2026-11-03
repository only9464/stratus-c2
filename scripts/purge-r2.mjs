#!/usr/bin/env node
/**
 * 按 key 清单删除 R2 对象（演练收尾用）。
 *
 *   node scripts/purge-r2.mjs --bucket stc2 --list keys.txt [--dry-run]
 *
 * `keys.txt` 每行一个对象 key（可从 R2 控制台导出，或用下面的命令生成）：
 *   npx wrangler r2 object list stc2 --prefix "prod/sessions/" --json > objects.json
 *   node -e "const o=require('./objects.json');console.log(o.map(x=>x.key).join('\n'))" > keys.txt
 *
 * 之所以不直接调 S3 API：那需要额外的 access key / secret 与 SigV4 实现；
 * 收尾场景用 wrangler 逐个删最省事，且不会把凭据留在脚本里。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const bucket = arg('bucket', 'stc2');
const listPath = arg('list');
const dryRun = argv.includes('--dry-run');

if (!listPath) {
  console.error('usage: node scripts/purge-r2.mjs --bucket stc2 --list keys.txt [--dry-run]');
  process.exit(2);
}

const keys = readFileSync(listPath, 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);

if (!keys.length) {
  console.log('nothing to delete');
  process.exit(0);
}

console.log(`bucket=${bucket} keys=${keys.length} dry_run=${dryRun}`);

let ok = 0;
let failed = 0;
for (const key of keys) {
  if (dryRun) {
    console.log(`would delete ${key}`);
    ok++;
    continue;
  }
  try {
    execFileSync('npx', ['wrangler', 'r2', 'object', 'delete', `${bucket}/${key}`], {
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
    ok++;
  } catch {
    failed++;
    console.error(`failed: ${key}`);
  }
}

console.log(`done: ok=${ok} failed=${failed}`);
process.exitCode = failed ? 1 : 0;
