# 03-06 · 认证与授权

> 两块要分开看：**操作员怎么登录**（人）与**植入体怎么证明自己**（机器）。
> 两者的密钥体系**完全不共享**——植入体被逆向不会影响操作员账号，反之亦然。

---

## 1. 操作员认证：三种模式

`AUTH_MODE` 由 `wrangler secret` 或 D1 `settings` 配置，默认 `token`。

| 模式 | 适用 | 认证方式 | CPU 成本 | 说明 |
|---|---|---|---|---|
| `access` | **推荐**（公网部署） | Cloudflare Access 前置，Worker 读 `Cf-Access-Jwt-Assertion` | ≈ 0（Access 在边缘完成） | 免费版有用户数上限（当前 50），够小团队用 |
| `token` | 本机/内网/临时演练 | `Authorization: Bearer <ADMIN_TOKEN>`，恒定时间比较 | < 0.1 ms | **最简单、最稳**；适合单人或脚本 |
| `dev` | 本地 `wrangler dev` | 不校验 | 0 | 生产环境启动时直接拒绝（fail-closed） |

### 1.1 为什么默认不是"用户名 + 口令"

免费计划 **10 ms CPU**：`PBKDF2-SHA256` 迭代 60 万次 ≈ 数百毫秒，**必然 1102**。
替代方案：

- 用 `scrypt/argon2` → Workers 没有原生实现，纯 JS 更慢；
- 降迭代到 1 万次 → 安全性不可接受；
- **把认证推给 Cloudflare Access**（推荐）或**用高熵 token**（够用）。

因此：口令登录只在 `AUTH_MODE=token` **且** `PAYWALL_OK=1`（即你愿意上 Workers Paid）时开放，且必须配合 Turnstile。

### 1.2 Cloudflare Access 模式

```
浏览器 → ops.example.com → [Access 策略: email in team] → Worker
                                  ↓ 注入 Cf-Access-Jwt-Assertion
                          Worker 校验签名（或只校验存在 + 从 header 取 email）
```

Worker 侧两种严格度：

| 严格度 | 做法 | 适用 |
|---|---|---|
| `access-lax` | 只要求 header 存在且 `Cf-Access-Authenticated-User-Email` 非空（**依赖 CF 已强制策略**） | 默认；最省 CPU |
| `access-strict` | 拉 JWKS（KV 缓存 1 h）+ 验 `RS256` + 校验 `aud`/`iss`/`exp` | 安全要求高时；每请求 +2~3 ms |

> 生产建议：`access-lax` + Access 策略里限制邮箱域 + 开启 WARP/OTP。**别在 Worker 里重复实现一遍 SSO。**

---

## 2. 角色与权限

三角色，写死在代码里（`packages/shared/src/roles.ts`），不做自定义角色（v1）。

| 能力 | viewer | operator | admin |
|---|---|---|---|
| 看会话/任务/结果（**密文**） | ✅ | ✅ | ✅ |
| 解密查看（需持有操作员私钥） | 取决于是否给她密钥 | ✅ | ✅ |
| 下发任务 | ❌ | ✅ | ✅ |
| 删会话 / 下发自毁 | ❌ | ✅ | ✅ |
| 创建/吊销载荷 | ❌ | ❌ | ✅ |
| 管理公钥 / 操作员 | ❌ | 仅自己的 | ✅ |
| 看审计 | ❌ | ✅ | ✅ |
| 看配额 / 改设置 | ❌ | ❌ | ✅ |

**实现**：路由注册时声明 `meta: { role: 'operator' }`，中间件统一判定：

```ts
const route = app.post('/api/v1/sessions/:id/tasks', requireRole('operator'), handler);
```

**禁止**用路径前缀判定（`/api/v1/sessions/*` 会把 `DELETE` 也放进来——这是 VShell 的设计缺陷，不重复）。

---

## 3. 植入体认证

### 3.1 注册阶段（`payload_psk`）

```
K_reg  = HKDF-SHA256(psk, info="stc2/v1/reg")
h      = HMAC-SHA256(K_reg, psk_id || "." || ts || "." || nc)
```

服务端只存 `K_reg`（不是 `psk`）。校验点：

| 检查 | 失败返回 |
|---|---|
| `psk_id` 存在且未吊销 | 401 `E_AUTH`（统一错误体） |
| `|now - ts| ≤ 300` | 400 `E_CLOCK_SKEW` |
| `nc` 24 h 内未复用 | 401 `E_AUTH` |
| `h` 恒定时间比较通过 | 401 `E_AUTH` |
| 同 IP 注册频率 ≤ 5/分钟 | 429 `E_RATE` |

### 3.2 会话阶段（`session_token`）

```
K_sess        = HKDF-SHA256(psk, info="stc2/v1/sess")
token_payload = sid || implant_pub || issued_at
session_token = b64u(HMAC-SHA256(K_sess, token_payload))
```

- 无状态：服务端用 `sid` 查 `sessions`，重算 HMAC 比较即可，不需要存 token。
- 有效期：随会话；`sessions.status=dead` 即失效。
- 轮换：每次 `register` 生成新 `sid` → 新 token。

### 3.3 为什么不用 mTLS / 客户端证书

- Cloudflare 免费计划的 **mTLS** 需要 API Shield / Access 的付费能力（且客户端证书由 CF 签发，等于把身份绑在平台上）；
- 证书在植入体里落盘 = 又多一个"可被提取的长期凭据"；
- PSK + HMAC 已经能做到"可验证、可吊销、不落盘"。

---

## 4. 操作员密钥（E2E）

| 项 | 规则 |
|---|---|
| 生成 | 浏览器 `crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'}, false /* 不可导出 */, ['deriveBits'])` |
| 存储 | IndexedDB（`CryptoKey` 对象可直接结构化克隆存储，**私钥字节从不暴露给 JS**） |
| 公钥登记 | `POST /api/v1/keys`（导出 `spki` → 取最后 65 字节作为 `pub_raw`） |
| 指纹 | `SHA256(pub_raw)` 前 8 字节 hex，展示给用户核对 |
| 多设备 | 同一 `key_id` 可在多台设备导入（需先导出加密备份） |
| 备份 | `PKCS#8` 导出 → `PBKDF2-SHA256(600k)` + `AES-256-GCM` 包裹 → 下载 `.stc2key` |
| 注销 | `DELETE /api/v1/keys/:id` 只阻止新任务；历史密文仍可解（因为私钥在客户端） |

> **零知识的重要副产品**：`key` 丢了就是真丢了。控制台必须显式提示"没有导出备份 = 历史结果永久不可读"。

---

## 5. 会话与 CSRF

| 项 | 做法 |
|---|---|
| Cookie | `AUTH_MODE=token` 时不用 cookie（用 `Authorization` 头），天然免 CSRF |
| Access 模式 | CF 注入的是 header，不是我们发的 cookie；仍然要求 `X-Requested-With: stc2` 防止被跨站表单打 |
| CORS | 默认关闭（同源部署 SPA）；需要跨域时白名单精确到 origin，**不允许 `*` + credentials** |
| CSP | `default-src 'self'; connect-src 'self' wss://ops.example.com; img-src 'self' data: blob:` |
| 点击劫持 | `X-Frame-Options: DENY` |
| 缓存 | API 响应 `cache-control: no-store` |

---

## 6. 审计要求

每条写操作必须记录（**不含命令明文**）：

```jsonc
{ "actor_type":"operator", "actor_id":"op_123", "action":"task.create",
  "target":"sid_abc", "request_id":"req_x", "ip":"203.0.113.7",
  "meta": { "cat":"exec", "sz": 512, "key_id":"K1" } }
```

必须审计的动作：登录/登出、任务下发/取消、会话删除、载荷创建/吊销、密钥登记/吊销、操作员增删改、设置变更、配额阈值告警。

**不记**：任务明文、结果内容、私钥、PSK、token。

---

## 7. 失败与锁定

| 场景 | 处理 |
|---|---|
| token 错误 5 次/分钟（同 IP） | 429，指数退避 |
| Access 策略拒绝 | CF 直接 403，Worker 不参与 |
| 密钥指纹不匹配（植入体侧） | 静默退出（不重试、不打日志） |
| PSK 吊销 | 已在线会话继续（它们有独立密钥），新注册 403 |
| 数据库 schema 不匹配 | 503 `E_SCHEMA`，前端显示"请执行迁移" |
