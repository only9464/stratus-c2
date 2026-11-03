# 06-04 · 排错

> 按"你看到的错误"索引。每条给：**症状 → 根因 → 修法**。

---

## A. 部署期

### A1 `Error 10021: Script startup exceeded CPU time limit`

**根因**：全局作用域里做了重活（构建大 schema、解析大 JSON、实例化重型库）。

**修法**：把初始化移到请求内，或在构建期生成常量。
本项目已把 `drizzle(schema)` 做成"每次请求创建"（`createDb(env.DB)`），不要在模块顶层建。

### A2 `Cannot apply Durable Object migration ... class not found`

**根因**：先部署了 console（它 `script_name: stc2-edge` 引用了 DO），但 edge 还没部署。

**修法**：`pnpm deploy:edge` 之后再 `pnpm deploy:console`。

### A3 `wrangler` 报 `database_id` 格式错

**根因**：`wrangler.jsonc` 里还是 `<D1_ID>` 占位符。

**修法**：`wrangler d1 create stc2-core` 输出的 UUID 填进 **两个** worker 的配置。

### A4 前端 404（刷新后）/ 白屏

**根因**：`assets.directory` 指向空目录，或 `not_found_handling` 没设 SPA。

**修法**：`pnpm build` 后再 `deploy:console`；确认 `apps/web/dist/index.html` 存在。

### A5 `Ignored build scripts: esbuild, workerd`

**根因**：pnpm 10 默认不跑依赖的 postinstall。

**修法**：`pnpm-workspace.yaml` 里已有 `onlyBuiltDependencies`；若仍被忽略，`pnpm approve-builds` 手动允许。

---

## B. 运行期（平台层）

### B1 `Error 1027`（每天）

**根因**：日请求额度用完。

**诊断**：`/api/v1/quota` 或 Cloudflare Dashboard → Workers → Metrics。

**修法**（按收益排序）：

1. 确认主通道是 WS，不是轮询（100 台 30 s 轮询 = 288k/天，必然爆）；
2. HTTP 兜底的 `next` 拉到 900 s；
3. 关掉没用的植入体；
4. 等 UTC 0 点。**不要**写重试循环，会把额度在 1 分钟内再打满一次。

### B2 `Error 1102: Worker exceeded resource limits`

**根因**：单请求 CPU > 10 ms（或内存 > 128 MB）。

**常见触发点**：

| 触发 | 为什么 | 修法 |
|---|---|---|
| 在 Worker 里做 PBKDF2/bcrypt | 迭代次数 × 哈希 = 几十毫秒 | 用 Access 或 token；上 Paid |
| 一次解析很大的 JSON | 1 MB JSON ≈ 数毫秒 | 限制 body；改分片 |
| 在请求里压缩/解压大响应 | zlib 是 CPU 密集 | 交给 R2/浏览器 |
| 循环里 `await D1` | 不是 CPU，但会撞 50 查询/调用上限 | 用 `db.batch()` |

**诊断**：`npx wrangler tail` 的 `cpuTime` 字段；或在本地 `wrangler dev` 用 DevTools profile。

### B3 `1016 origin DNS error`

**根因**：路由指向的 host 没有橙云 DNS 记录。

**修法**：DNS 面板给 `c2.example.com` / `ops.example.com` 建 Proxied 记录（或删掉冲突的 A 记录让 wrangler 自动建）。

### B4 403 + HTML 挑战页（植入体收到一坨 JS）

**根因**：WAF 托管规则 / Bot Fight Mode / Under Attack Mode 在拦。

**修法**：给 `c2.example.com` 建 WAF 自定义规则：`http.request.uri.path starts_with "/v1/"` → Skip → 所有托管规则与 Bot Fight；关闭 Under Attack Mode。

### B5 WebSocket 连上就断（1006）

**根因**（按概率）：

1. 客户端在 `Upgrade` 之外还发了 body；
2. `Authorization` 头没带（401 后 CF 会直接断）；
3. 运行时更新（20 分钟 grace）——看 `wrangler tail` 是否有 `deployment`；
4. 中间设备掐长连（企业代理）。

**修法**：先 `websocat -H "Authorization: Bearer $TOK" wss://c2.example.com/v1/ws/beacon` 复现；
能连就是客户端问题；不能连就是配置问题。

---

## C. 运行期（业务层）

### C1 注册 401，但 PSK 看着没错

**排查顺序**：

1. `ts` 是否用了**秒**（不是毫秒）；
2. `h` 的拼接是不是 `psk_id + "." + ts + "." + nc`（点号不能少）；
3. `nc` 是否 **base64url 无填充**（`+`/`/`/`=` 都会让 HMAC 不一致）；
4. `psk` 解码前的字符串是否被 trim 过（不要 trim 中间）；
5. 服务端 `k_reg` 是否来自**同一个 psk**（`SELECT k_reg FROM payloads WHERE psk_id=?`，用 `HKDF` 复算一遍对比）。

### C2 注册成功，但 `op_pub` 是 `null`

**根因**：还没登记操作员公钥。

**修法**：控制台 `/keys` → 生成并登记；然后**重新注册**（植入体每次启动都会重新注册）。

### C3 任务下发返回 409

**原因**：`cat` 属于破坏性分类但没带 `confirm: true`（`pivot` / `module`）。

**修法**：请求体加 `"confirm": true`；前端会弹二次确认。

### C4 结果一直是 404（`result not ready`）

**原因**：

1. 植入体没回（看 `tasks.status`）；
2. 回了但 `meta.tid` 丢了（服务端挂不上）；
3. 结果 > 4 KB 写 R2 失败（R2 不可用）。

**修法**：查 `task_results` 有没有行；没有就看 DO 日志里 `res` 帧的 `meta`。

### C5 解密失败（`OperationError`）

| 原因 | 检查 |
|---|---|
| 用了另一把操作员密钥 | `sessions.owner_key_id` vs 本地 `key_id` |
| `sid` 不一致 | 会话重建过（sid 变了），旧密钥派生的 key 自然不对 |
| `nonce`/`rid` 缺失 | `task_results` 这两列是否为空（老数据） |
| AAD 方向写反 | 结果必须是 `dir=0x01` |

---

## D. 本地开发

| 现象 | 修法 |
|---|---|
| `wrangler dev` 起不来，报 D1 不存在 | 先 `wrangler d1 migrations apply stc2-core --local` |
| 前端 5173 打开但 API 401 | `.dev.vars` 里 `AUTH_MODE=dev`，且 Vite 代理指向 8788 |
| `wrangler dev` 改了代码不生效 | DO 有状态：`--persist-to` 换目录，或删 `.wrangler/state` |
| WS 本地连不上 | Vite 代理要 `ws: true`（已配）；地址用 `ws://127.0.0.1:5173/api/v1/ws` |
| 迁移文件冲突 | 重新 `pnpm --filter @stratus/db generate`，不要手改已提交的迁移 |

---

## E. 一句话排查口诀

> **1027 看频率，1102 看 CPU，1016 看 DNS，403 看 WAF，1006 看鉴权，404 看 tid，解密失败看 key。**
