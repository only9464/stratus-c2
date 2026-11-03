/**
 * stc2-console —— 操作员平面。
 *
 *   /api/v1/*   → Hono REST（鉴权 + 审计 + Drizzle/D1）
 *   /api/v1/ws  → HubDO（会话列表实时事件）
 *   /api/v1/ws/session/:id → SessionDO（终端/文件流，role=operator）
 *   其余         → Static Assets（Vue SPA）
 */

import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { attachOperator, requireRole } from './middleware/auth';
import { api } from './routes/api';
import { apiError } from './lib/http';
import type { AppEnv } from './types';

const app = new Hono<AppEnv>();

app.use('*', secureHeaders());
// 注意：不开 CORS。SPA 与 API 同源部署；跨域会破坏"同源 + 无 cookie"的安全模型。
// 如果确实需要跨域（例如本地 5173 调试），用 Vite 的 server.proxy，而不是放开 CORS。

/* 公开：健康检查与 OpenAPI */
app.get('/api/v1/health', (c) => c.json({ ok: true, version: '0.1.0', env: c.env.ENV_NAME }));

/* 鉴权 */
app.use('/api/v1/*', attachOperator);

/* REST */
app.route('/api/v1', api);

/* 实时：Hub（会话事件） */
app.get('/api/v1/ws', requireRole('viewer'), async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return c.text('expected websocket', 426);
  const stub = c.env.HUB.get(c.env.HUB.idFromName('hub'));
  return stub.fetch('https://hub/ws', {
    headers: { upgrade: 'websocket', 'x-stc2-operator': c.get('operator').id },
  });
});

/* 实时：附着到某个会话（终端/文件流） */
app.get('/api/v1/ws/session/:id', requireRole('operator'), async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return c.text('expected websocket', 426);
  const sid = c.req.param('id');
  const stub = c.env.SESSION.get(c.env.SESSION.idFromName(sid));
  return stub.fetch(`https://do/ws?role=operator`, {
    headers: { upgrade: 'websocket', 'x-stc2-operator': c.get('operator').id },
  });
});

app.all('/api/*', (c) => apiError(c, 404, 'E_NOT_FOUND', 'no such endpoint'));

/* 静态资源（SPA） */
app.get('*', async (c) => {
  if (!c.env.ASSETS) return c.text('frontend not built: run `pnpm build`', 503);
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((err, c) => {
  console.error('console_error', err instanceof Error ? err.stack : String(err));
  return apiError(c, 500, 'E_INTERNAL', 'internal error');
});

export default app;
