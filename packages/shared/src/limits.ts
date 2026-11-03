/**
 * 免费额度常量与预算估算（与 docs/01-research/01-cloudflare-platform-limits.md 对应）。
 * 任何"要不要这么设计"的争论，先看这里的数字。
 */

export const QUOTA = {
  workers: { requestsPerDay: 100_000, cpuMs: 10, subrequests: 50, bodyBytes: 100 << 20 },
  kv: { readsPerDay: 100_000, writesPerDay: 1_000, sameKeyPerSec: 1, valueBytes: 25 << 20 },
  d1: {
    dbBytes: 500 << 20,
    rowsReadPerDay: 5_000_000,
    rowsWritePerDay: 100_000,
    queriesPerInvoke: 50,
    rowBytes: 2_000_000,
  },
  r2: {
    storageGbMonth: 10,
    classAPerMonth: 1_000_000,
    classBPerMonth: 10_000_000,
    singlePutBytes: 5 << 30,
    multipartPartBytes: 5 << 20,
  },
  do: {
    requestsPerDay: 100_000,
    gbSecondsPerDay: 13_000,
    rowsReadPerDay: 5_000_000,
    rowsWritePerDay: 100_000,
    storageBytes: 5 << 30,
    perObjectBytes: 1 << 30,
    wsMessageBytes: 32 << 20,
  },
  queue: { opsPerDay: 10_000, messageBytes: 128 << 10, retentionHours: 24 },
} as const;

/** DO duration 估算：128 MB 固定内存折算成"对象活跃秒数"。 */
export const DO_ACTIVE_SECONDS_PER_DAY = QUOTA.do.gbSecondsPerDay / 0.128;

export interface UsageEstimate {
  sessions: number;
  hours: number;
  heartbeatSec: number;
  messagesPerSessionHour: number;
  avgResultBytes: number;
  filesPerDay: number;
  fileMb: number;
}

export interface UsageBudget {
  workersRequests: number;
  doRequests: number;
  doGbSeconds: number;
  d1RowsRead: number;
  d1RowsWrite: number;
  kvWrites: number;
  r2ClassA: number;
  r2ClassB: number;
  r2GbMonth: number;
}

/**
 * 粗算一次演练的日用量。用于控制台"配额水位"页与 `scripts/check-quota.ts`。
 * 口径刻意保守（心跳只按 20:1 折算，不含自动应答的免费心跳）。
 */
export function estimateUsage(u: UsageEstimate): UsageBudget {
  const heartbeats = (3600 / u.heartbeatSec) * u.sessions * u.hours;
  const bizMessages = u.messagesPerSessionHour * u.sessions * u.hours;
  const wsMessages = heartbeats + bizMessages;

  const chunksPerFile = Math.ceil((u.fileMb * (1 << 20)) / (4 << 20));

  return {
    workersRequests: Math.ceil(u.sessions + 50 + u.filesPerDay),
    // WS 消息按 20:1 计入 DO 请求
    doRequests: Math.ceil(wsMessages / 20 + bizMessages / 10),
    // 假设每次唤醒 50 ms 活跃
    doGbSeconds: Number(((wsMessages / 20) * 0.05 * 0.128).toFixed(2)),
    d1RowsRead: Math.ceil(u.sessions * 30 + bizMessages * 2),
    d1RowsWrite: Math.ceil(u.sessions * 2 + bizMessages * 2 + u.filesPerDay * 4),
    kvWrites: Math.ceil(u.filesPerDay + 10),
    r2ClassA: Math.ceil(u.filesPerDay * chunksPerFile),
    r2ClassB: Math.ceil(u.filesPerDay * chunksPerFile * 2),
    r2GbMonth: Number(((u.filesPerDay * u.fileMb) / 1024).toFixed(2)),
  };
}

export interface QuotaVerdict {
  key: keyof UsageBudget;
  used: number;
  limit: number;
  ratio: number;
  level: 'ok' | 'warn' | 'crit';
}

export function evaluateBudget(b: UsageBudget): QuotaVerdict[] {
  const limits: Record<keyof UsageBudget, number> = {
    workersRequests: QUOTA.workers.requestsPerDay,
    doRequests: QUOTA.do.requestsPerDay,
    doGbSeconds: QUOTA.do.gbSecondsPerDay,
    d1RowsRead: QUOTA.d1.rowsReadPerDay,
    d1RowsWrite: QUOTA.d1.rowsWritePerDay,
    kvWrites: QUOTA.kv.writesPerDay,
    r2ClassA: Math.floor(QUOTA.r2.classAPerMonth / 30),
    r2ClassB: Math.floor(QUOTA.r2.classBPerMonth / 30),
    r2GbMonth: QUOTA.r2.storageGbMonth,
  };
  return (Object.keys(limits) as (keyof UsageBudget)[]).map((key) => {
    const used = b[key];
    const limit = limits[key];
    const ratio = limit === 0 ? 0 : used / limit;
    return {
      key,
      used,
      limit,
      ratio: Number(ratio.toFixed(3)),
      level: ratio >= 0.95 ? 'crit' : ratio >= 0.8 ? 'warn' : 'ok',
    };
  });
}
