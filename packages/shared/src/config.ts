/**
 * 运行期配置（由 register 下发、由 D1 settings 覆盖）。
 * 注意：这里是"客户端可见"的配置，敏感值（PSK/私钥）永远不进这个结构。
 */

export type MetaMode = 'plain' | 'sealed';
export type TransportPref = 'ws' | 'http' | 'r2' | 'doh';

export interface RuntimeConfig {
  hb: number;
  jitter: number;
  transport: TransportPref[];
  meta_mode: MetaMode;
  max_frame: number;
  chunk: number;
  next: number;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  hb: 60,
  jitter: 0.2,
  transport: ['ws', 'http'],
  meta_mode: 'plain',
  max_frame: 1 << 20,
  chunk: 4 << 20,
  next: 300,
};

/** 服务端默认策略（可被 D1 settings 覆盖）。 */
export interface ServerPolicy {
  metaMode: MetaMode;
  hbSeconds: number;
  sessionTimeoutSeconds: number;
  retentionDays: {
    results: number;
    files: number;
    screens: number;
    audit: number;
  };
  maxTasksPerBulk: number;
  maxOperatorsPerSession: number;
}

export const DEFAULT_POLICY: ServerPolicy = {
  metaMode: 'plain',
  hbSeconds: 60,
  sessionTimeoutSeconds: 240,
  retentionDays: { results: 30, files: 30, screens: 7, audit: 90 },
  maxTasksPerBulk: 100,
  maxOperatorsPerSession: 8,
};

export function mergeConfig(partial: Partial<RuntimeConfig> | null | undefined): RuntimeConfig {
  return { ...DEFAULT_RUNTIME_CONFIG, ...(partial ?? {}) };
}
