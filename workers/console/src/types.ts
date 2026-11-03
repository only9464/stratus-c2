import type { Role } from '@stratus/shared';

export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  TOKENS: KVNamespace;
  CONFIG: KVNamespace;
  SESSION: DurableObjectNamespace;
  HUB: DurableObjectNamespace;
  ASSETS: Fetcher;

  ADMIN_TOKEN?: string;
  AUTH_SECRET?: string;
  AUTH_MODE?: string;
  ENV_NAME: string;
  EDGE_BASE?: string;
  CF_DNS_TOKEN?: string;
}

export interface OperatorCtx {
  id: string;
  email: string;
  role: Role;
}

export interface AppVars {
  operator: OperatorCtx;
  requestId: string;
}

export type AppEnv = { Bindings: Env; Variables: AppVars };
