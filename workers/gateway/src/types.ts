/** edge worker 的绑定与环境。`wrangler types` 生成的类型也长这样，这里手写一份便于开源阅读。 */
export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  TOKENS: KVNamespace;
  CONFIG: KVNamespace;
  SESSION: DurableObjectNamespace;
  HUB: DurableObjectNamespace;

  AUTH_SECRET: string;
  ENV_NAME: string;
  META_MODE?: string;
  EDGE_DECOY?: string;
  SESSION_TIMEOUT_SEC?: string;
  CF_DNS_TOKEN?: string;
}

export interface SessionRow {
  id: string;
  payload_id: string;
  implant_pub: string | null;
  status: string;
  owner_key_id: string | null;
  meta_mode: string | null;
}
