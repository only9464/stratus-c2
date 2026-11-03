import type { Context } from 'hono';
import type { AppEnv } from '../types';

export function apiError(c: Context<AppEnv>, status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 503, code: string, message: string, details?: unknown) {
  return c.json(
    {
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
        request_id: c.get('requestId') ?? 'req_unknown',
      },
    },
    status,
  );
}

/** 审计是"尽力而为 + 异步"，不阻塞响应。**永不记录命令明文**。 */
export function audit(
  c: Context<AppEnv>,
  args: { action: string; target?: string; targetKind?: string; meta?: Record<string, unknown> },
): void {
  const op = c.get('operator');
  const now = Math.floor(Date.now() / 1000);
  const stmt = c.env.DB.prepare(
    `INSERT INTO audit_log (id, ts, actor_type, actor_id, action, target, request_id, ip, meta)
     VALUES (?, ?, 'operator', ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    now,
    op?.id ?? 'unknown',
    args.action,
    args.target ?? '',
    c.get('requestId') ?? '',
    c.req.header('cf-connecting-ip') ?? '',
    JSON.stringify({ ...(args.meta ?? {}), kind: args.targetKind ?? '' }),
  );
  c.executionCtx.waitUntil(stmt.run().catch(() => undefined));
}

export function pagination(url: URL, defaultSize = 50, maxSize = 200) {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const size = Math.min(maxSize, Math.max(1, Number(url.searchParams.get('page_size') ?? String(defaultSize)) || defaultSize));
  return { page, size, offset: (page - 1) * size };
}

export function sortClause(raw: string | null, allowed: string[], fallback: string): string {
  const col = allowed.includes(raw ?? '') ? (raw as string) : fallback;
  return col;
}
