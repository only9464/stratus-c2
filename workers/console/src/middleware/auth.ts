import { createMiddleware } from 'hono/factory';
import { roleAtLeast, timingSafeEqual, utf8, type Role } from '@stratus/shared';
import type { AppEnv, OperatorCtx } from '../types';

function sameSecret(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ab = utf8(a);
  const bb = utf8(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * 认证中间件：三种模式（见 docs/03-protocol/06-auth-and-rbac.md）
 *   dev    —— 本地开发，不校验（生产必须改掉）
 *   token  —— Bearer ADMIN_TOKEN（默认，最省 CPU）
 *   access —— 依赖 Cloudflare Access 前置注入的 header
 */
export const attachOperator = createMiddleware<AppEnv>(async (c, next) => {
  const mode = (c.env.AUTH_MODE ?? 'token').toLowerCase();
  const requestId = `req_${crypto.randomUUID().slice(0, 8)}`;

  let op: OperatorCtx | null = null;

  if (mode === 'dev') {
    op = { id: 'op_dev', email: 'dev@localhost', role: 'admin' };
  } else if (mode === 'access') {
    const email = c.req.header('cf-access-authenticated-user-email');
    if (!email) {
      return c.json({ error: { code: 'E_UNAUTH', message: 'missing access identity', request_id: requestId } }, 401);
    }
    const row = await c.env.DB.prepare('SELECT id, role, disabled FROM operators WHERE username = ? LIMIT 1')
      .bind(email)
      .first<{ id: string; role: string; disabled: number }>();
    if (row?.disabled) {
      return c.json({ error: { code: 'E_FORBIDDEN', message: 'account disabled', request_id: requestId } }, 403);
    }
    const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM operators').first<{ n: number }>();
    const role = (row?.role as Role | undefined) ?? ((count?.n ?? 0) === 0 ? 'admin' : 'viewer');
    op = { id: row?.id ?? email, email, role };
  } else {
    const header = c.req.header('authorization') ?? '';
    const token = header.replace(/^Bearer\s+/i, '');
    if (!sameSecret(token, c.env.ADMIN_TOKEN ?? '')) {
      return c.json({ error: { code: 'E_UNAUTH', message: 'invalid token', request_id: requestId } }, 401);
    }
    op = { id: 'op_admin', email: 'admin@local', role: 'admin' };
  }

  c.set('operator', op);
  c.set('requestId', requestId);
  await next();
});

export function requireRole(min: Role) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const op = c.get('operator');
    if (!op || !roleAtLeast(op.role, min)) {
      return c.json(
        { error: { code: 'E_FORBIDDEN', message: `requires ${min}`, request_id: c.get('requestId') } },
        403,
      );
    }
    await next();
  });
}

export function unauthorized(c: { json: (b: unknown, s: 401) => Response }, msg = 'unauthorized'): Response {
  return c.json({ error: { code: 'E_UNAUTH', message: msg } }, 401);
}
