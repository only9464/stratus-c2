# 01 · Cloudflare 平台能力与配额调研（免费额度口径）

> 调研时间：2026-11
> 口径：**Workers Free 计划**（单账号、单域名、不购买任何付费项），所有数字以 Cloudflare 官方文档为准，逐条附来源。
> 用途：这份文档是 [02-architecture](../02-architecture/01-system-architecture.md) 的**硬约束来源**——凡是这里写"不可行"的，架构里必须有替代路径，不允许"假设能行"。

---

## 0. 结论速览（先看这 8 条，它们决定了整个框架的形状）

| # | 事实 | 对 C2 设计的直接后果 |
|---|---|---|
| 1 | Workers Free **10 ms CPU / 请求**、**100,000 请求/天** | 禁止在请求路径上做重计算（密码哈希、压缩、大 JSON 解析）；心跳频率必须按"请求预算"反推 |
| 2 | Worker **不能监听入站 TCP/UDP**，只能被动接 HTTP(S)/WebSocket | 所有植入体只能"主动连出"到一个 HTTPS 端点；不存在 TCP 监听器 |
| 3 | `connect()`（出站 TCP）**禁止连 Cloudflare IP、localhost、内网私有地址** | **Worker 无法直接访问靶标内网**；内网穿透只能由植入体做代理端，Worker 只做转发 |
| 4 | Durable Objects **免费可用**，但只有 SQLite 后端；闲置可 **hibernation**，休眠期间**不计 duration** | WS 长连的实时通道在经济上可行——这是整套设计的地基 |
| 5 | KV 免费 **1,000 写/天**（且同 key 1 写/秒） | **KV 绝不能当任务队列**；它只能放配置、一次性令牌、特性开关 |
| 6 | D1 免费 **5 GB 总存储 / 500 MB 单库 / 5M 行读 / 100k 行写（每天）**，单次调用最多 **50 条查询** | 会话与任务账本放 D1；一个请求内要 `batch()` 而不是循环查 |
| 7 | R2 免费 **10 GB-month、Class A 100 万/月、Class B 1000 万/月、出口免费** | 载荷、文件、结果外置走 R2；大文件必须分片（单次上传 ≤ 100 MB 入口、5 GiB 单对象 R2 上限） |
| 8 | Queues 免费 **10,000 操作/天**，消息 ≤ 128 KB，保留 24 h | 只能做"结果归档/通知"这类低频异步，不能做每帧投递 |

一句话：**这不是"把 VShell 搬到云上"，而是"在 10 ms CPU + 无入站 TCP + 无内网可达"的夹缝里重新设计一遍 C2 的通信模型。**

---

## 1. Workers Free 计划指标

来源：[Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)（页面 Last updated 2026-10-29）

| 项目 | Free | Paid | 备注 |
|---|---|---|---|
| 请求数 | **100,000 / 天**（UTC 0 点重置） | 无限（计费） | 超限返回 **Error 1027**；路由可配 `fail open`（绕过 Worker）或 `fail closed`（直接 1027） |
| CPU 时间/请求 | **10 ms** | 5 min（默认 30 s） | 超限 → Error 1102 `Worker exceeded resource limits`；**等待 I/O 不计入 CPU** |
| CPU 时间/Cron | 10 ms | 30 s（间隔 < 1h）/ 15 min | 免费计划的 Cron 只够做"轻量巡检" |
| 内存/isolate | 128 MB | 128 MB | 流式处理大响应，别整体 buffer |
| 子请求 | **50 / 请求** | 10,000（可提到 10M） | fetch、KV、R2、D1、Queues、`connect()` 全算 |
| 同时在途连接 | 6 / 请求 | 6 | 只在"等响应头"阶段计数 |
| Worker 数量 | 100 / 账号 | 500 | 我们只用 2 个 |
| Worker 体积 | 64 MiB（未压缩） | 64 MiB | 前端静态资源不算进 bundle |
| 启动时间 | 1 s | 1 s | 全局作用域里别做重活 |
| 环境变量 | 64 个 / Worker，单个 ≤ 5 KB | 128 个 | 密钥用 `wrangler secret`，别塞 JSON |
| Cron Triggers | **5 个 / 账号** | 250 | Cron 在免费计划**可用** |
| 静态资源 | 20,000 文件 / 版本，单文件 ≤ 25 MiB | 100,000 | 控制台 SPA 直接由 console worker 托管，不需要 Pages |
| 请求 body | **100 MB**（取决于域名所在套餐，Free = 100 MB） | 同 | 超限 413；分片上传要远小于这个值 |
| 响应 body | 无强制限制 | — | CDN 缓存上限 512 MB（Free） |
| 时长（HTTP） | **无硬上限**，客户端连着就一直算 | — | 但运行时更新有 **20 分钟 grace**，之后连接会被断 |
| `waitUntil` 延长 | 响应后最多 30 s | — | 后台收尾用 |
| 日志 | 256 KB / 请求 | — | 别把结果打进日志 |

**工程含义**

- 免费计划下"一个请求 10 ms CPU"意味着：**每请求只能做 O(1) 的加解密 + 1~2 次 D1 查询**。AES-GCM 解 16 KB ≈ 0.1 ms 量级，安全；PBKDF2 10 万次迭代 ≈ 数十毫秒，**直接超限**。
- HTTP 通道的心跳预算是硬账：`100,000 / 86,400 ≈ 1.16 次/秒`。**30 秒心跳只能养 ~30 台**（还要留出操作与结果回传的额度）。所以主通道必须是 WebSocket，不能是轮询。

---

## 2. 运行时能力边界（对 C2 最关键的几条）

来源：[TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)、[WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/)、[Runtime APIs 索引](https://developers.cloudflare.com/workers/runtime-apis/)

| 能力 | 结论 | 依据 / 细节 |
|---|---|---|
| 监听入站 TCP | **不可行** | Worker 只响应 HTTP(S)；入站 TCP 仅支持"从另一个 Worker 经 service binding 转发过来"（`connect()` handler），公网无入口 |
| 监听 UDP | **不可行** | 运行时无 UDP API |
| 出站 TCP `connect()` | 可用，但**受限** | 禁止：Cloudflare 自家 IP 段、`localhost`、私有网络地址；禁止 25 端口；套接字不能在全局作用域创建；每个 socket 占用"同时连接"名额；DO 内的 socket 会让 DO 保活最多 15 min 并计 duration |
| 权威 DNS | **不可行** | Workers 不能做域名权威服务器；DNS 隐蔽信道只能"借"Cloudflare DNS（用 API 写 TXT）+ 公共 DoH 解析器读 |
| 常驻进程 / 定时器 | 不可行 | 没有 `setInterval` 常驻；用 **DO alarm**（最小粒度按秒，计 1 次请求 + 1 行写）或 **Cron Triggers**（5 个/账号） |
| 持久文件系统 | 不可行 | 只有 D1 / KV / R2 / DO SQLite |
| `eval` / `new Function` | 不可行 | 运行时禁用动态代码；需要动态逻辑就用 WebAssembly（但 for C2 无意义） |
| Node.js 兼容 | 部分 | `nodejs_compat` 提供 `node:buffer`、`node:crypto`(部分)、`node:stream` 等；不要依赖原生模块 |
| WebCrypto | 可用，算法以 Workers 文档为准 | `crypto.subtle` 提供 AES-GCM、HMAC、HKDF、PBKDF2、ECDSA/ECDH(P-256/P-384)、SHA-2 系列；**X25519 / Ed25519 / ChaCha20-Poly1305 的支持随兼容日期变化，不要假设可用**（本项目加密选型因此固定在 P-256 + HKDF-SHA256 + AES-256-GCM，见 [04-crypto-design](../02-architecture/03-crypto-design.md)） |
| 全局可变状态 | **不可依赖** | isolate 随时销毁；跨请求状态只能进 D1/KV/DO，或用 DO 的 SQLite |
| `waitUntil` 后生命周期 | ≤ 30 s | 用于"响应已发出但还要写审计/归档" |

**这四条是设计的地基：**无入站 TCP → 只能 HTTPS/WSS 拉取式；禁止内网地址 → 内网只能由植入体做代理；无常驻进程 → 用 DO alarm 替代守护线程；10 ms CPU → 加密必须"每帧独立、无状态、无 KDF 重活"。

---

## 3. WebSocket

来源：[Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/)、[DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)

| 项目 | 值 |
|---|---|
| Worker 侧是否可终结 WS | 可以（`new WebSocketPair()`），但**要跨连接协调/存状态就必须进 DO** |
| 单条消息上限 | **32 MiB**（Worker 与 DO 一致）；超限自动 `1009 Message is too large` |
| 连接时长 | 跟随请求生命周期（HTTP 无硬上限），但运行时更新有 20 min grace；崩溃/过载会更早断 |
| 自动 ping/pong | 运行时**自动回 pong**，且**不打断 hibernation**，不进 `webSocketMessage` |
| 二进制默认类型 | 兼容日期 ≥ 2026-03-17 时 `binaryType` 默认 `blob`；DO hibernation 的 `webSocketMessage` **永远给 `ArrayBuffer`** |
| Close 行为 | 兼容日期 ≥ 2026-04-07 自动回 Close 帧；代理场景用 `accept({ allowHalfOpen: true })` |
| 批量建议 | 官方明确建议**把小消息打包成一个帧**，减少内核↔JS 上下文切换 |

**对 C2 的含义**：一条 WS 帧可以装下整个"任务批次"，植入体侧应做 **50–100 ms 的批量聚合**；实时 shell 的按键回显按"每帧一字符"会非常浪费（每次都是一次 DO 请求计费），必须合批。

---

## 4. Durable Objects（本设计的中枢）

来源：[DO Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)、[DO Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

### 4.1 免费额度

| 维度 | Free | 说明 |
|---|---|---|
| 请求 | **100,000 / 天** | 含 HTTP 请求、RPC 会话、**WebSocket 消息**、alarm 调用 |
| Duration | **13,000 GB-s / 天** | 按 128 MB 固定内存折算：`13,000 / 0.128 ≈ 101,562 s ≈ 28.2 小时/天` 的"活跃对象时间" |
| SQLite 行读 | 5,000,000 / 天 | 与 D1 同价 |
| SQLite 行写 | 100,000 / 天 | `setAlarm()` 也算 1 行写 |
| 存储 | 5 GB / 账号；**单对象 1 GB**（Free） | 10 GB/对象是 Paid |
| DO 类数量 | 100 / 账号 | 我们只用 2~3 个类 |
| 单对象吞吐 | 软上限 1,000 req/s | 单线程 |

**计费细节（决定成本模型）**

- **WebSocket 消息按 20:1 折算**计入请求数（100 条入站消息 ≈ 5 次请求计费）；出站消息与协议 ping **不收费**。
- `state.setWebSocketAutoResponse()` 处理的自动应答**不计 duration**。
- **hibernation 期间不计 duration**；只有"活跃执行事件"或"无法休眠的空闲"才计费。
- **开放出站 WS 不会休眠**（最多保活 15 min），只有"DO 作为 WS 服务端 + hibernation API"才免费。
- 每个 `setAlarm` = 1 行写；alarm 每次触发 = 1 次请求。

### 4.2 限制

| 项目 | 值 |
|---|---|
| 单条 WS 消息 | 32 MiB（仅接收侧受限） |
| SQL 语句长度 | 100 KB |
| 单行/BLOB/字符串 | 2 MB |
| 表列数 | 100 |
| 绑定参数 | 100 / 查询 |
| `LIKE`/`GLOB` 模式 | 50 字节 |
| `serializeAttachment` | ≤ 16,384 字节 |
| 出站 HTTP body | 100 MiB |
| 单次请求 CPU | 默认 30 s，可配置到 5 min（Paid 才有意义） |

**工程含义**：一个会话一个 DO 是可行的（免费 100k 请求/天、对象数量不限、单对象 1 GB 足够存"未确认任务 + 去重窗口"）。**不要把文件内容写进 DO SQLite**（单行 2 MB），文件走 R2。

---

## 5. Workers KV

来源：[KV Limits](https://developers.cloudflare.com/kv/platform/limits/)

| 项目 | Free | 备注 |
|---|---|---|
| 读 | 100,000 / 天 | 批量读算 1 次外部调用 |
| 写（不同 key） | **1,000 / 天** | 硬伤 |
| 写（同一 key） | **1 / 秒** | 并发写会被限 |
| 存储 | 1 GB / 账号 | — |
| 单 value | 25 MiB | — |
| key | 512 B；metadata 1024 B | — |
| `cacheTtl` 最小 | 30 s | 想要"立刻可见"就做不到 |
| 单次调用操作数 | 1,000 | 与子请求同源 |

**结论（写进架构约束）**：KV 的写额度比请求额度低两个数量级，**任何"每次心跳写一次 KV"的设计都会在第 1,000 次心跳后死掉**。KV 在本项目里的角色被严格限定为：① 一次性下载令牌（写少读多）；② 引导配置与公钥缓存（几乎不变）；③ 特性开关。

---

## 6. D1

来源：[D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)、[D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)

| 项目 | Free | 备注 |
|---|---|---|
| 数据库数 | 10 / 账号 | 够用 |
| 单库大小 | **500 MB** | 关键上限；结果大文本必须外置到 R2 |
| 账号总存储 | 5 GB | — |
| 行读 / 天 | 5,000,000 | 索引命中的 `SELECT` < 1 ms |
| 行写 / 天 | 100,000 | 写一条 = 1 行；`batch()` 内每条各算 |
| 单次调用查询数 | **50**（Free） | 付费 1,000；`db.batch()` 只算 1 次查询额度 |
| 单条 SQL | 100 KB | — |
| 单行 / BLOB | 2 MB | 文件内容别进 D1 |
| 单查询执行 | 30 s | 大 UPDATE/DELETE 必须分批 |
| 查询结果 | 50 MB | 2026-11-04 起生效 |
| 并发模型 | **单库单写者**，串行执行 | 高频写会排队，队列满则 `overloaded` |
| Time Travel | 7 天（Free） | 误删可回滚，演练里很有用 |
| FTS5 | 支持（D1 内置 SQLite） | 结果检索可用，但注意写入放大 |

**工程含义**：D1 是"账本"，不是"消息队列"。**每台植入体每次上线只写 1~3 行**；任务状态迁移用 `UPDATE ... WHERE status='queued'` 做原子领取；100 会话 × 每会话 100 任务 ≈ 2~3 万行写，仍在 10 万/天以内，但**一次批量下发 200 台 × 5 个任务就会吃掉 1,000 行写**，因此批量操作要合并成 `batch()` 且限制单批条数。

---

## 7. R2

来源：[R2 Limits](https://developers.cloudflare.com/r2/platform/limits/)、[R2 Pricing](https://developers.cloudflare.com/r2/pricing/)

| 项目 | Free | 备注 |
|---|---|---|
| 存储 | **10 GB-month / 月** | — |
| Class A（写/列举/建分片） | 1,000,000 / 月 | 分片上传每片算 1 次 |
| Class B（读/head） | 10,000,000 / 月 | — |
| 出口流量 | **免费** | 这是选 R2 而不是 S3 的核心理由 |
| 单对象 | 5 TiB（单次上传 5 GiB，分片 4.995 TiB） | — |
| 分片数 | 10,000 / 对象 | 分片大小 ≥ 5 MiB（除最后一片） |
| 同 key 并发写 | 1 / 秒 | 分片写不同 key 不受限 |
| 元数据 | 8 KB / 对象 | 可放 sha256、分块表 |

**工程含义**：文件传输的"落地"就在 R2。**上传路径**：implant → gateway worker（≤100 MB/请求）→ R2 `put`（Class A）。**下载路径**：operator → console worker → R2 `get`（Class B）。**分片策略**：4 MiB/片，避免触到单请求 100 MB 与 DO 的 100 MiB 出站限制；断点续传用"已传分片清单"（D1 记录）。

---

## 8. Queues

来源：[Queues Limits](https://developers.cloudflare.com/queues/platform/limits/)、[Queues Pricing](https://developers.cloudflare.com/queues/platform/pricing/)

| 项目 | Free |
|---|---|
| 标准操作 | **10,000 / 天**（1 条消息 ≈ 写+读+删 = 3 次操作） |
| 队列数 | 10,000 |
| 消息大小 | 128 KB |
| 批量 | 消费 100 条/批；`sendBatch` 100 条或 256 KB |
| 保留期 | **24 h（不可配）** |
| 延迟投递 | ≤ 24 h |
| 消费者并发 | 250（push） |
| 消费者时长 | 15 min / 次 |

**工程含义**：10,000 操作/天 ÷ 3 ≈ **3,300 条消息/天**。只够做"任务完成通知、大文件归档、日报生成"。**不能用它承载每帧投递**。它在本项目里是"可选加速器"，不是主链路——主链路必须能在没有 Queues 的情况下工作。

---

## 9. 其他免费能力（逐条判定）

| 能力 | 免费可用性 | 对 C2 的用途 | 结论 |
|---|---|---|---|
| Custom Domain / `workers.dev` 子域 | 可用（100 个自定义域/zone） | 植入体回连域名 | ✅ 必用 |
| Wildcard DNS + `*/*` 路由 | 可用（Route 1000 条/zone） | `x1.cdn.example.com` 轮换落地域名 | ✅ 用得到 |
| Cron Triggers | 5 个/账号 | 死会话清理、配额日报、KV 配置刷新 | ✅ 用 1~2 个 |
| Workers Static Assets | 20,000 文件 | 控制台 SPA | ✅ 用（不额外起 Pages） |
| Cloudflare Access | 免费版有用户数上限（当前档位 50 用户，按 Zero Trust 面板为准） | 管理端前置零信任登录，省掉 Worker 侧口令校验的 CPU | ✅ 强烈建议（架构里的 `AUTH_MODE=access`） |
| Turnstile | 免费 | 防扫描器爆破管理端登录 | 🟡 可选 |
| Workers Analytics Engine / Logs | Logs 保留期短 | 运行指标 | 🟡 只做粗粒度 |
| Cloudflare Tunnel | 需要 `cloudflared` **常驻**在某台机器 | 用它做 C2 入口 = 需要一台自己的机器 | ❌ 违背"零自建服务器"前提 |
| Cache API | 可用（50 次调用/请求） | 缓存静态响应 | 🟡 与 KV 用途重叠，不必要 |
| Rate Limiting 规则 | 免费版功能受限 | 限制植入体端点被爆破 | 🟡 用 Worker 内部计数器替代 |
| WAF 托管规则 | 免费版为基础规则集 | 可能误伤自己的 C2 流量 | ⚠️ 需在演练前确认不拦 `POST /v1/*` |
| 代理非标准端口 | Cloudflare 只代理有限端口集（80/443/8080/8443/2052/2053/2082/2083/2086/2087/2095/2096） | 只能落在这些端口上 | ⚠️ 设计默认 443/8443 |

---

## 10. 「C2 关键能力 → Cloudflare 可行性」判定表

| 能力 | 判定 | 做法 | 代价 / 限制 |
|---|---|---|---|
| 植入体入站持久连接 | ✅ | HTTPS/WSS 到 gateway worker → DO | 只能是"植入体主动连出" |
| 双向实时通道（交互 shell） | ✅ | DO + WebSocket **hibernation** 双端 | 消息要合批，否则 DO 请求额度先死 |
| 命令队列（可靠投递） | ✅ | D1 `tasks` + DO 内存态 + 植入体 ACK | D1 单库单写者，高频下发要合并 |
| 断线重连补发 | ✅ | 单调 `seq` + 服务端 `ack_seq` + DO 去重窗口 | 需要植入体实现"至少一次"幂等 |
| 大文件上传/下载 | 🟡 | 4 MiB 分片 → R2；D1 记分片清单 | 免费 R2 10 GB-month；单库 500 MB 逼着结果外置 |
| 多操作员协作 | ✅ | 同一 session 的 DO 广播给多个 operator WS | DO 单线程，广播要限速 |
| 审计日志 | ✅ | D1 `audit_log`（写入前先算好，别在请求里做格式转换） | 行写额度有限，审计要批量落 |
| 定时任务（死会话清理） | ✅ | DO `alarm` 或 Cron（5 个/账号） | 每次 alarm = 1 请求 + 1 行写 |
| 内网穿透 / 反向代理 | 🟡 | **只能植入体侧做代理**（SOCKS5/端口转发在靶标上监听），Worker 仅转发字节流；操作员本机需要 `stc2 proxy` 客户端 | `connect()` 禁止私有地址，Worker 永远不可能直连内网 |
| DNS 隐蔽信道 | 🟡（控制面） | 用 Cloudflare DNS API 写 TXT（console worker 发），植入体用 DoH（如 `1.1.1.1/dns-query`）读 | 带宽极低、CF API 有速率限制（1,200 请求/5 min）、TTL 与缓存会拖慢；只做兜底 |
| TCP 隧道（原始端口转发） | ❌ | Worker 无入站 TCP | 只能"应用层隧道"（HTTP/WS 里封装） |
| UDP / KCP / QUIC 通道 | ❌ | 运行时无 UDP | 别设计 |
| SOCKS5 服务端跑在 Worker 上 | ❌ | 私有地址被禁 | 只能跑在植入体上 |
| 屏幕流（高频图像） | 🟡 | 帧落 R2 + 控制面只发"新帧可用"通知 | DO 请求/带宽都会被帧率打爆；建议 1–2 fps |
| 编译载荷（服务端构建） | ❌ | Workers 无工具链、无子进程 | 载荷由操作员**本地编译**，服务端只发配置 + 托管二进制 |
| 与 VShell 协议互通 | ❌ | 无授权、无必要 | 明确不做 |

---

## 11. 配额预算：一次 100 会话、24 小时的演练

假设：100 台植入体在线 24 h，主通道 WS，心跳 60 s，人均每小时 3 条命令、每条命令 2 KB 结果；
文件回传按**高压场景**取 "每天 500 次、平均 50 MB"（≈25 GB/天）。按 10 MB 算则 R2 只占 5 GB-month，不会撞线。

| 项目 | 用量估算 | 免费额度 | 余量 |
|---|---|---|---|
| Workers 请求 | WS 建连 100 次 + 少量 HTTP 兜底 ≈ **< 1,000** | 100,000/天 | 充裕（**前提：不走轮询**） |
| DO 请求 | WS 消息：100 台 × 1,440 心跳 = 144,000 条 → 按 20:1 ≈ **7,200** 计费请求；命令/结果 ≈ 300 条消息 ≈ 15 | 100,000/天 | 充裕 |
| DO duration | 有 hibernation，空闲 ≈ 0；按"每天每台活跃 1 分钟"算 ≈ 100 × 60 s × 0.128 GB ≈ **768 GB-s** | 13,000 GB-s/天 | 充裕（**前提：用 hibernation API；用 `accept()` 会 24 h 全程计费 → 100 × 86,400 × 0.128 = 1.1M GB-s，直接爆**） |
| D1 行写 | 会话上线 100 + 任务 300×2 + 结果 300×2 + 审计 600 ≈ **2,400** | 100,000/天 | 充裕 |
| D1 行读 | 列表页 + 会话页轮询 ≈ **20,000** | 5,000,000/天 | 充裕 |
| KV 写 | 一次性下载令牌 100 + 配置 10 ≈ **110** | 1,000/天 | 紧（**禁止在心跳路径写 KV**） |
| KV 读 | 配置缓存 1,000 次 ≈ **1,000** | 100,000/天 | 充裕 |
| R2 Class A | 文件分片 5 × 10 MB / 4 MiB ≈ 15 片/次 × 500 次 ≈ **7,500**；载荷 50 | 1,000,000/月 | 充裕 |
| R2 Class B | 操作员下载 500 次 ≈ **2,000** | 10,000,000/月 | 充裕 |
| R2 存储 | 50 MB 文件 × 500 + 结果外置 ≈ **25 GB-month** | **10 GB-month** | ⚠️ **瓶颈在这里**：需要 TTL 清理（7 天）或压缩 |
| Queues | 归档通知 1,000 条 ≈ 3,000 操作 | 10,000/天 | 一般（可选） |

**结论**

1. **免费额度对"100 会话、控制面为主"的演练是够的**，真正的瓶颈按顺序是：**R2 存储（10 GB-month）→ KV 写（1,000/天）→ DO duration（若不用 hibernation）→ Workers 请求（若走轮询）**。
2. 一旦把通道退回 **HTTP 轮询**：100 台 × 30 s 心跳 = 288,000 请求/天 > 100,000，**必然 1027**。所以"WS 优先、HTTP 兜底"不是优化项，是**可行性前提**。
3. 一次"跑满 24 小时 + 传 25 GB 文件"的演练会超 R2 免费额度 → 设计里必须有 **文件 TTL + 结果外置后自动清理**，并在控制台显式显示配额水位。

---

## 12. 来源清单

- Workers Limits：https://developers.cloudflare.com/workers/platform/limits/
- Workers TCP sockets（`connect()` 限制）：https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
- Workers WebSockets：https://developers.cloudflare.com/workers/runtime-apis/websockets/
- Durable Objects Limits：https://developers.cloudflare.com/durable-objects/platform/limits/
- Durable Objects Pricing（免费额度、hibernation 计费、20:1）：https://developers.cloudflare.com/durable-objects/platform/pricing/
- Durable Objects WebSockets（hibernation API、附件 16 KB、批量建议）：https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Workers KV Limits：https://developers.cloudflare.com/kv/platform/limits/
- D1 Limits：https://developers.cloudflare.com/d1/platform/limits/
- D1 Pricing：https://developers.cloudflare.com/d1/platform/pricing/
- R2 Limits：https://developers.cloudflare.com/r2/platform/limits/
- R2 Pricing（免费 10 GB-month、Class A/B）：https://developers.cloudflare.com/r2/pricing/
- Queues Limits：https://developers.cloudflare.com/queues/platform/limits/
- Queues Pricing（免费 10,000 操作/天）：https://developers.cloudflare.com/queues/platform/pricing/
- Queues 上架免费计划的公告：https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/

> 数字随平台演进而变。本项目在 `packages/shared/src/limits.ts` 里维护了一份可执行副本，`scripts/check-quota.ts` 用它做预算自检——**文档与代码任何一方改动都要同步**。
