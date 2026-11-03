# 03-03 · 管理端 API（console worker）

> 基址：`https://ops.example.com`
> 风格：REST + JSON；写操作返回 `request_id`；错误统一 `{error:{code,message,request_id}}`。
> 认证：`AUTH_MODE=access`（Cloudflare Access 前置）或 `AUTH_MODE=token`（`Authorization: Bearer <token>`）。
> 授权：路由元数据（`role: admin|operator|viewer`），**不是**路径前缀匹配。

---

## 0. 约定

| 项 | 规则 |
|---|---|
| 分页 | `?page=1&page_size=50&sort=last_seen&order=desc&q=keyword` → `{items:[], total, page, page_size}` |
| 幂等 | `POST` 支持 `Idempotency-Key` 头（同 key 24 h 内返回同一结果） |
| 时间 | 全部 unix 秒 |
| 大小 | 单请求体 ≤ 1 MB（文件上传走 multipart，单独限制） |
| 审计 | 所有 `POST/PUT/PATCH/DELETE` 落 `audit_log`（异步，不阻塞响应） |
| 限流 | 每操作员 60 次/分钟（DO 计数器），超限 429 |

---

## 1. 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/auth/login` | `{username, password}` → `{token, expires_at}`（仅 `AUTH_MODE=token`） |
| POST | `/api/v1/auth/logout` | 吊销当前 token |
| GET | `/api/v1/me` | 当前身份、角色、可用密钥 |

`AUTH_MODE=access` 时 `/auth/*` 返回 404（登录交给 Cloudflare Access）。

---

## 2. 会话

### `GET /api/v1/sessions`

```
?status=online|offline|dead|quarantined
&os=windows
&tag=customerA
&q=DESKTOP
&page=1&page_size=50&sort=last_seen&order=desc
```

```jsonc
{
  "items": [
    {
      "id": "AAAA...", "host": "DESKTOP-7F2K", "username": "alice",
      "os": "windows", "arch": "amd64", "internal_ip": "10.1.2.33",
      "external_ip": "203.0.113.9", "country": "CN",
      "caps": ["shell","file"],
      "status": "online", "last_seen": 1763000100,
      "task_stats": { "queued": 0, "running": 1, "done": 42 },
      "tags": ["customerA"], "note": "财务部"
    }
  ],
  "total": 12, "page": 1, "page_size": 50
}
```

> **一条 SQL 出全部字段**（`LEFT JOIN` 聚合任务计数），不要 N+1。见数据模型 §7。

### `GET /api/v1/sessions/:id`

返回会话详情 + `implant_pub`（浏览器用它算 ECDH）+ 最近 20 条任务。

### `DELETE /api/v1/sessions/:id`

标记 `dead`，并向植入体下发 `bye{reason:"kill"}`（若在线）。**不可撤销**，需 `?confirm=1`。

### `POST /api/v1/sessions/:id/tags`

```jsonc
{ "add": ["customerA"], "remove": ["test"] }
```

### `POST /api/v1/sessions/:id/tasks`

**核心接口**。请求体里的 `payload` 是**浏览器已经加密好的**密文，服务端不解析。

```jsonc
{
  "cat": "exec",                 // 粗分类（元数据）
  "ttl": 60,
  "rid": "RRRRRRRR",
  "n":   "AAAAAAAAAAAAAAAA",     // GCM nonce (b64u 12B)
  "ct":  "AAAAAAAA...",          // L2 密文 (b64u)
  "key_id": "K1..."              // 用哪把操作员密钥（默认团队 key）
}
```

```jsonc
// 202
{ "task_id": "TTTT...", "queued": true, "online": true, "request_id": "req_..." }
```

- `online=false` → 任务进 DO 的 `pending`，等重连补发。
- `cat` 只用于列表筛选；`METADATA_MODE=none` 时强制 `e2e`。
- **批量**：`POST /api/v1/tasks:bulk`，body `{ targets: [sid...], cat, ttl, n, ct }`（≤ 100），返回逐项结果。

### `GET /api/v1/tasks`

```
?session_id=&status=&cat=&since=&page=...
```

### `GET /api/v1/results/:task_id`

```jsonc
{
  "task_id": "TTTT...", "size": 36, "sha256": "...",
  "inline_ct": "AAAA...",                       // ≤ 4 KB
  "r2": { "key": "prod/.../results/TTTT.bin", "size": 1048576 },   // 或外置
  "created_at": 1763000100
}
```

浏览器拿到 `inline_ct` 或 R2 内容后自行解密。**服务端永远不知道结果内容。**

---

## 3. 实时通道

| 方法 | 路径 | 说明 |
|---|---|---|
| WS | `/api/v1/ws` | 连 `HubDO`：会话上线/下线、任务状态变化、通知 |
| WS | `/api/v1/ws/session/:id` | 连 `SessionDO`：终端 IO、该会话的任务/结果流 |

**帧格式**（服务端→浏览器）：

```jsonc
{ "t": "session.update", "sid": "...", "status": "online", "ts": 1763000100 }
{ "t": "task.update", "tid": "...", "sid": "...", "status": "done" }
{ "t": "io", "sid": "...", "n": "...", "ct": "...", "seq": 12 }
```

浏览器→服务端：

```jsonc
{ "t": "io", "sid": "...", "n": "...", "ct": "...", "seq": 12 }   // 终端输入
{ "t": "sub", "sid": "..." }                                       // 订阅某会话
```

> 每条 IO 帧都是**浏览器加密**的，服务端只转发。

---

## 4. 载荷

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/payloads` | 列表（名称、平台、大小、是否吊销） |
| POST | `/api/v1/payloads` | 创建载荷：生成 `psk_id` + `psk`（**明文只返回一次**）+ 生成的配置 |
| POST | `/api/v1/payloads/:id/binary` | 上传已编译的二进制（multipart，≤ 50 MB）→ R2 |
| POST | `/api/v1/payloads/:id/link` | 生成一次性下载链接（KV，10 min） |
| DELETE | `/api/v1/payloads/:id` | 吊销（撤销 `psk_id`，不影响已在线会话） |

创建响应：

```jsonc
{
  "id": "P1...",
  "psk_id": "CgXk9aQ2",
  "psk": "b64u(32B)",            // ⚠️ 只此一次返回，服务端只存派生 key
  "config": {
    "v": 1, "endpoint": "https://c2.example.com",
    "psk_id": "CgXk9aQ2", "psk": "b64u(32B)",
    "op_pub": "BAA...", "op_fp": "9f2c1a7b3d4e5f60",
    "hb": 60, "jitter": 0.2, "transport": ["ws","http"],
    "meta_mode": "plain"
  }
}
```

> 服务端**没有编译器**。这个接口只产出"配置 + 上传位"，二进制由操作员本地编译后 `POST /binary`。

---

## 5. 文件 / 屏幕

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/files?session_id=` | 传输列表 |
| GET | `/api/v1/files/:id` | 详情（分片进度） |
| POST | `/api/v1/files` | 创建传输（`direction=down` 时附 R2 对象） |
| GET | `/api/v1/files/:id/download` | 打包下载（流式 zip 或直接给分片 URL） |
| DELETE | `/api/v1/files/:id` | 删索引 + 删 R2 对象 |
| GET | `/api/v1/screens?session_id=` | 屏幕帧索引（给最新帧的签名 URL） |

---

## 6. 密钥 / 操作员 / 审计 / 统计

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | `/api/v1/keys` | viewer | 已登记公钥 |
| POST | `/api/v1/keys` | operator | 登记公钥（`key_id`/`pub`/`fp`），返回确认 |
| DELETE | `/api/v1/keys/:key_id` | admin | 吊销（历史任务仍可解，新任务不能用） |
| GET | `/api/v1/operators` | admin | 成员列表 |
| POST | `/api/v1/operators` | admin | 新建成员（`role`） |
| PATCH | `/api/v1/operators/:id` | admin | 改角色/禁用 |
| GET | `/api/v1/audit` | operator | `?action=&actor=&target=&since=&page=` |
| GET | `/api/v1/stats` | viewer | 仪表盘（会话数、任务数、成功率、最近 24 h 曲线） |
| GET | `/api/v1/quota` | admin | 配额水位（Workers/DO/D1/KV/R2） |
| GET | `/api/v1/health` | 无 | `{"ok":true,"schema":3,"version":"0.1.0"}` |

---

## 7. 错误码

| HTTP | code | 含义 |
|---|---|---|
| 400 | `E_VALIDATION` | 参数校验失败（`details` 给出字段） |
| 401 | `E_UNAUTH` | 未认证/令牌过期 |
| 403 | `E_FORBIDDEN` | 角色不足 |
| 404 | `E_NOT_FOUND` | 资源不存在 |
| 409 | `E_CONFLICT` | 幂等冲突/状态不允许 |
| 413 | `E_TOO_LARGE` | 体积超限 |
| 429 | `E_RATE` | 限流（带 `Retry-After`） |
| 500 | `E_INTERNAL` | 服务端错误（带 `request_id`，不含堆栈） |
| 503 | `E_SCHEMA` | 数据库版本不匹配（需执行迁移） |

响应体：

```jsonc
{ "error": { "code": "E_VALIDATION", "message": "cat is required", "details": {"cat":"required"}, "request_id": "req_abc" } }
```

---

## 8. 幂等与并发

- **下发任务**：`Idempotency-Key` 相同 → 返回同一 `task_id`（D1 `tasks` 上建唯一索引 `(operator_id, idem_key)`）。
- **批量**：逐项独立，部分失败不整体回滚；返回 `{ok:[], failed:[{sid,code}]}`。
- **删除会话**：天然幂等（置 dead 两次结果一致）。
- **并发编辑**：`PATCH` 用 `If-Match: <etag>`（D1 里加 `rev INTEGER`），冲突返回 412。

---

## 9. OpenAPI

完整机器可读定义在 [`openapi.yaml`](./openapi.yaml)，控制台 `/doc` 用 Scalar 渲染。
生成方式：`@hono/zod-openapi` 从 zod schema 生成，**schema 即代码**，避免文档与实现漂移。
