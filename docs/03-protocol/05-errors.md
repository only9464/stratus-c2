# 03-05 · 错误码与重试策略

> 三层错误要分清：**平台层**（Cloudflare 的 1027/1102）、**L1 传输层**（`E_*`）、**L2 业务层**（密文里的 `ok:false`）。
> 服务端只能看到前两层；第三层由浏览器解密后展示。

---

## 1. 平台层（Cloudflare 直接返回）

| 现象 | 含义 | 植入体该做什么 | 运维该做什么 |
|---|---|---|---|
| **1027** | 日请求额度用完（免费 100k/天） | 间隔 ×3，等到 UTC 0 点重置；**不要重试风暴** | 查 `/api/v1/quota`；把 HTTP 通道换成 WS |
| **1102 / `Worker exceeded resource limits`** | CPU 超 10 ms | 退避重试（可能是某一帧特别大） | 查是不是某条路径在请求里做了重活 |
| **1016** | 源站 DNS 错误 | 停止 | 检查 `c2.example.com` 是否有橙云记录 |
| **413** | body 超过 100 MB | 改分片 | — |
| **429** | 平台限流 | 读 `Retry-After` | — |
| **1035 / 520~525** | Cloudflare 侧配置或源站问题 | 停止 | 检查路由/证书/Worker 是否被删 |
| **403 + JS 挑战** | WAF / Under Attack Mode 拦了 | 无法通过（植入体不会执行 JS） | 关掉 `c2.example.com` 的 Managed Challenge，放行 `/v1/*` |

---

## 2. L1 传输层（我们自己返回）

统一错误体（edge 与 console 一致）：

```json
{ "error": { "code": "E_AUTH", "message": "unauthorized", "request_id": "req_ab12cd34" } }
```

| code | HTTP | 触发 | 重试？ |
|---|---|---|---|
| `E_FORMAT` | 400 | JSON 非法 / 字段缺失 / 类型错 | ❌ 重试无意义，改代码 |
| `E_VERSION` | 400 | `v != 1` | ❌ |
| `E_CLOCK_SKEW` | 400 | `|now - ts| > 300` | ✅ 校正时间后重试 |
| `E_AUTH` | 401 | token 无效 / HMAC 不匹配 / PSK 不存在（统一不区分） | ⚠️ 先重新注册；仍失败则停止 |
| `E_REVOKED` | 403 | 载荷被吊销/过期 | ❌ **停止**，清内存密钥 |
| `E_NOT_FOUND` | 404 | 会话/分片/令牌不存在 | ❌ |
| `E_TOO_LARGE` | 413 | 单帧 > 1 MiB / 片 > 8 MiB / beacon > 256 KB | ❌ 改分片 |
| `E_RATE` | 429 | 注册频率超限（同 IP 5 次/分钟） | ✅ 退避（带 `Retry-After`） |
| `E_CONFLICT` | 409 | 状态不允许（缺 `confirm=1`、未上传二进制就生成链接） | ❌ |
| `E_VALIDATION` | 400 | 控制台参数不合法（`details` 给字段） | ❌ |
| `E_FORBIDDEN` | 403 | 角色不足 | ❌ |
| `E_SCHEMA` | 503 | D1 schema 版本不匹配 | ❌ 去跑迁移 |
| `E_INTERNAL` | 500 | 未预期错误（带 `request_id`，无堆栈） | ✅ 最多 3 次，然后上报 |
| `E_OFFLINE` | WS 帧 | 目标会话不在线（operator 帧无处可投） | ✅ 等上线 |
| `E_IMPLANT_OFFLINE` | WS 帧 | 植入体断开（推给操作员） | — |

### 重试矩阵（客户端实现照这个来）

```
400 / 403(REVOKED) / 409 / 413 / 503  → 不重试
401                                   → 重新注册一次；再 401 就停
429 / 500 / 网络错误                    → 指数退避：5s → 15s → 45s → 120s → 300s（上限 30min），±20% 抖动
1027                                  → 间隔 ×3，最多等到 UTC 0 点
```

---

## 3. L2 业务层（密文内）

服务端看不到，浏览器解密后展示：

```json
{ "k": "shell.exec", "rid": "...", "ok": false, "err": "expired", "exit": -1, "out": "" }
```

| `err` | 含义 |
|---|---|
| `expired` | 任务超过 `ttl`（植入体丢弃，未执行） |
| `unsupported` | 该植入体没实现这个任务类型（**不要**把它当失败重投） |
| `denied` | 植入体侧的本地策略拒绝（例如破坏性动作未确认） |
| `exec_failed` | 执行失败（附 `exit` 与 stderr） |
| 其它 | 植入体自定义，原样透传 |

---

## 4. WebSocket 关闭码

| code | 谁发的 | 含义 | 处理 |
|---|---|---|---|
| 1000 | 任意 | 正常关闭 | 重连（如果还需要） |
| 1001 | CF 运行时更新 | 服务端要走新版本（20 分钟 grace 结束） | 立刻重连 |
| 1006 | 网络 | 异常断开（无 close 帧） | 退避重连 |
| 1008 | 服务端 | 帧非法 / 重放 / 认证失败 | **停止**（不要重连风暴） |
| 1009 | 运行时 | 消息 > 32 MiB | 改分片 |
| 1011 | 服务端 | 内部错误 | 退避重连 |
| 4000–4999 | 我们 | 保留 | — |

---

## 5. 排查用的三个 ID

| ID | 从哪拿 | 用途 |
|---|---|---|
| `request_id` | 响应体 / 响应头 | 在 `wrangler tail` 里 grep |
| `sid` | 会话 ID | 在 DO 日志与 D1 里定位 |
| `tid` | 任务 ID | 串起"下发 → 投递 → 结果" |

排查脚本：

```bash
# 实时看 edge 的日志（需要已登录 wrangler）
npx wrangler tail stc2-edge --format pretty

# 看某个会话的 DO 状态（通过 console 的调试端点，需 admin）
curl -s https://ops.example.com/api/v1/sessions/$SID -H "authorization: Bearer $TOKEN" | jq

# 查某个任务是否落库
npx wrangler d1 execute stc2-core --remote \
  --command "SELECT id,status,attempts,created_at,completed_at FROM tasks WHERE id='$TID';"
```
