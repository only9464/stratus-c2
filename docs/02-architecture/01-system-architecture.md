# 02-01 · 总体架构

> 本文是整套设计的骨架：**为什么是这两个 Worker、为什么每个会话一个 DO、数据放在哪、一次点击到一次回显经过哪些跳**。
> 所有"不可行/必须绕过"的判断来源见 [01-cloudflare-platform-limits](../01-research/01-cloudflare-platform-limits.md)。

---

## 1. 设计目标与硬约束

### 目标

| # | 目标 | 验收方式 |
|---|---|---|
| G1 | **零自有服务器**：只需要一个 Cloudflare 账号 + 一个托管在 CF 的域名 | 部署脚本只调 `wrangler deploy`，不出现任何 VPS/端口/反向代理 |
| G2 | **植入体语言无关**：协议用文档定义，任何语言都能实现 | 提供协议规范 + Go/.NET 参考实现 + 一组 curl/websocat 用例 |
| G3 | **服务端零知识**：CF 侧（含我们自己的 Worker）拿不到任务/结果的明文 | 抓包与 D1 dump 只能看到 `ct`、`nonce`、`seq` |
| G4 | **免费额度内可运营**：100 会话量级 | [配额预算](../01-research/01-cloudflare-platform-limits.md#11-配额预算一次-100-会话24-小时的演练) 全项不越线 |
| G5 | **可开源**：目录清晰、文档齐全、`git clone && pnpm i && wrangler deploy` 能跑 | CI 里跑 typecheck + build + 单测 |

### 硬约束（直接从平台推导）

| 约束 | 后果 |
|---|---|
| 无入站 TCP/UDP，`connect()` 禁私有地址 | 只能是"植入体连出 + Worker 转发"；内网能力放在植入体侧 |
| 10 ms CPU / 请求 | 每请求只做常数级工作：1 次 AEAD、1~2 次 D1 |
| KV 写 1,000/天 | 禁止把任何"每心跳写一次"的东西放 KV |
| DO 有 hibernation 才免费 | 长连必须用 `acceptWebSocket()`，不能用 `accept()` |
| D1 单库单写者、500 MB | 账本放 D1、内容放 R2 |
| 静态前端由 Worker Assets 托管 | 不额外部署 Pages，控制台与 API 同一个 Worker |

---

## 2. 组件总览

```
                         ┌───────────────────────── Cloudflare (单账号) ─────────────────────────┐
                         │                                                                       │
   植入体 (任意语言)      │   ┌──────────────────────┐        ┌──────────────────────────────┐   │
   ──────────────        │   │  stc2-edge (Worker)  │        │  stc2-console (Worker)       │   │
   WSS/HTTPS  ───────────┼──▶│  /v1/register        │        │  /api/v1/*   (Hono REST)     │   │
   (只连出)               │   │  /v1/beacon          │        │  /assets/*   (Vue SPA)       │   │
                         │   │  /v1/ws/beacon  ─────┼──┐     │  /doc        (OpenAPI)       │   │
                         │   │  /v1/file/*          │  │     └───────────┬──────────────────┘   │
                         │   │  /d/:token (载荷)     │  │                 │ service binding      │
                         │   └──────────┬───────────┘  │                 │ + DO 绑定            │
                         │              │              │                 │                      │
                         │              ▼              ▼                 ▼                      │
                         │   ┌────────────────────────────────────────────────────────────┐      │
                         │   │ Durable Objects                                            │      │
                         │   │  SessionDO  (每会话一个：implant WS + N 个 operator WS)     │      │
                         │   │  HubDO      (单例：在线会话索引、操作员在线状态、全局限流)    │      │
                         │   └────────────────────────────────────────────────────────────┘      │
                         │                                                                       │
                         │   D1 (账本)      KV (令牌/配置)      R2 (载荷/文件/结果)   Queues (可选) │
                         │   Cron (清理/日报)                    Workers Static Assets (SPA)      │
                         └───────────────────────────────────────────────────────────────────────┘
                                                    ▲
                                                    │ HTTPS (浏览器)
                                          操作员 (Vue3 控制台)
                                                    │
                                          可选：stc2 proxy (本机 loopback SOCKS5)
```

### 2.1 为什么是**两个** Worker（而不是一个）

| 理由 | 说明 |
|---|---|
| **暴露面隔离** | edge 是"全世界都能打"的端点；console 只给操作员，可以套 Cloudflare Access。合成一个 Worker 后，任何给植入体的路由都同时是管理面的入口 |
| **配额隔离** | Workers Free 的 100k 请求/天是**账号级**，但错误与限流是**按 Worker** 观测的；拆开后"植入体流量洪峰"不会污染控制台的错误面板 |
| **独立发布** | 改前端不需要重新部署植入体端点；改协议不碰前端 |
| **独立域名** | `c2.example.com`（可能被分析与封禁）与 `ops.example.com`（长期稳定）解耦，前者可轮换 |
| **权限最小化** | edge 只需要 D1(写结果)/R2(写文件)/KV(读令牌)/SESSION DO；console 需要全量读 + 任务写。分开后 edge 被攻破也改不了操作员与设置 |

> 代价：跨 Worker 的 DO 访问要走 **service binding**（`fetch()` 到同 zone 的另一个 Worker 会失败，必须用 service binding 或 Custom Domain）。

### 2.2 为什么是"每会话一个 DO"

| 备选 | 问题 |
|---|---|
| 单例 DO 管全部会话 | 单线程 1,000 req/s 软上限；一台机器的高频 shell 会卡住所有人；单对象 1 GB 存储上限成全局瓶颈 |
| 无 DO，纯 D1 轮询 | 实时性退化为心跳间隔；请求额度立刻打爆（见配额文档 §11） |
| 每会话一个 DO ✅ | 天然分片；hibernation 免费；状态（未确认任务、去重窗口、seq）就在对象里，不需要额外的锁；一个会话炸了不影响别人 |

**DO 里放什么**：`pending_tasks`（未 ACK）、`dedupe`（最近 256 个 seq/tid）、`last_seen`、`implant_pub`、`caps`、`op_counters`。**不放**：文件内容、结果正文（这些进 D1/R2）。

### 2.3 为什么 edge 也要 `SESSION` 绑定

DO 类只能在**定义它的 Worker** 里做迁移（migrations），但**可以被其它 Worker 绑定**（`script_name` 指向定义方）。所以：

```jsonc
// workers/console/wrangler.jsonc
"durable_objects": {
  "bindings": [
    { "name": "SESSION", "class_name": "SessionDO", "script_name": "stc2-edge" },
    { "name": "HUB",     "class_name": "HubDO",     "script_name": "stc2-edge" }
  ]
}
```

控制台要下发任务、要挂 operator WS，都得直接和 `SessionDO` 说话——走 DO RPC 比"console → service binding → edge → DO"少一跳、少一次计费。

---

## 3. 两条平面（plane）

### 3.1 植入体平面（edge）

| 端点 | 方法 | 用途 | 认证 |
|---|---|---|---|
| `/v1/register` | POST | 首次上线：交换会话、拿配置 | `payload_psk` + 时间窗 + 可选 nonce 挑战 |
| `/v1/ws/beacon` | GET (Upgrade) | **主通道**：双向帧 | `session_token` + 每帧 `seq` |
| `/v1/beacon` | POST | 兜底轮询：带一批上行帧，带回一批下行帧 | 同上 |
| `/v1/file/:tid` | PUT/POST | 分片上传（→ R2） | 同上 + 分片号/总片数 |
| `/v1/file/:tid/:idx` | GET | 分片下载 | 同上 |
| `/d/:token` | GET | 载荷一次性下载（→ R2） | 一次性令牌（KV） |
| `/health` | GET | 空 200（探活，不泄露版本） | 无 |
| 其它任意路径 | * | **诱饵响应**（伪装成 CDN/静态站点 404） | 无 |

> 设计要点：**edge 不暴露任何"读数据"的接口**。植入体只能"交结果"，不能"查任务列表"，避免把 C2 变成可枚举的数据库。

### 3.2 操作员平面（console）

```
POST   /api/v1/auth/login          # token 模式；access 模式下由 CF Access 前置
GET    /api/v1/me
GET    /api/v1/sessions            # 列表（分页/筛选/排序）
GET    /api/v1/sessions/:id        # 详情（含 caps、最近任务）
POST   /api/v1/sessions/:id/tasks  # 下发任务（E2E 加密后交给 DO）
DELETE /api/v1/sessions/:id        # 标记 dead + 下发 self-destruct
GET    /api/v1/tasks               # 全局任务流水
GET    /api/v1/results/:id         # 结果（大结果给 R2 句柄）
WS     /api/v1/ws                  # 操作员实时通道（HubDO）
WS     /api/v1/ws/session/:id      # 附着到某个 SessionDO（终端/文件流）
POST   /api/v1/payloads            # 登记载荷 + 上传二进制到 R2
GET    /api/v1/payloads            # 列表（含一次性下载链接）
POST   /api/v1/keys                # 登记操作员公钥（P-256）
GET    /api/v1/audit               # 审计
GET    /api/v1/stats               # 仪表盘
GET    /api/v1/quota               # 配额水位（免费额度自检）
GET    /doc                        # OpenAPI (Scalar)
```

> 所有写操作都要：**角色校验（路由元数据）→ 审计（异步批量落）→ 返回 `request_id`**。

---

## 4. 一次"下发命令 → 看到回显"的完整路径

```
操作员浏览器          console worker            SessionDO              edge worker        植入体
     │                     │                       │                       │                │
  1  │ POST /tasks ───────▶│  鉴权/授权/审计        │                       │                │
     │  {kind:"shell.exec"}│  用操作员私钥 E2E 加密  │                       │                │
     │                     │  （在浏览器里做）        │                       │                │
  2  │                     │ RPC enqueueTask ─────▶│  写 pending_tasks      │                │
     │                     │                       │  (SQLite)             │                │
  3  │                     │                       │  implant WS 在线？ ────┼── frame ──────▶│ 解密→执行
     │                     │                       │  否 → 等下线重连后补发  │                │
  4  │                     │                       │◀──── result frame ────┼────────────────│
     │                     │                       │  去重(seq/tid)→广播     │                │
  5  │◀── WS push ─────────│◀── DO 广播 ───────────│                       │                │
     │  密文原样转发，浏览器解密│                       │                       │                │
  6  │                     │  异步：D1 落 tasks/results 元数据 + R2 落大结果          │                │
```

**关键点**

1. **加密在浏览器**：`console worker` 只看到 `{tid, nonce, ct}`。它不知道 `kind`，也不知道命令内容。所以"审计日志里写命令明文"是做不到的——审计只记"谁在什么时候给哪个会话下发了一条 N 字节的任务"。
2. **DO 是唯一的路由点**：所有帧都过 `SessionDO`，它负责"在线直投 / 离线入队 / 去重 / 广播给多个操作员"。
3. **D1 只是账本**：用于列表、筛选、报表、重启后恢复；**实时性不依赖 D1**。
4. **回显路径不经过 console worker 的业务逻辑**：WS 帧从 DO 直接透传到浏览器（`ct` 不解密、不改写），避免多一次 CPU 与一次计费。

---

## 5. 数据放置

| 数据 | 位置 | 理由 |
|---|---|---|
| 会话元数据（host/用户/OS/内网 IP/caps/最后在线） | **D1** `sessions` | 要排序、筛选、分页 |
| 会话实时状态（未 ACK 任务、seq 窗口、在线连接） | **DO** SQLite + 内存 | 每帧都要读写，D1 扛不住 |
| 任务元数据（谁下的、何时、状态、大小） | **D1** `tasks` | 审计与报表 |
| 任务/结果**正文** | **R2**（>4 KB）或 D1 内联（≤4 KB） | D1 单行 2 MB、单库 500 MB |
| 载荷二进制 | **R2** | 单对象可到 5 TiB；出口免费 |
| 一次性下载令牌 | **KV**（TTL） | 写少读多，正好匹配 KV 的额度形状 |
| 引导配置 / 公钥缓存 | **KV** + D1 `settings` | 读多写极少 |
| 屏幕帧 | **R2** + D1 索引 | 高频大对象 |
| 审计 | **D1** `audit_log` | 需要查询与导出 |
| 操作员私钥 | **浏览器 IndexedDB（non-extractable）** | 服务端永不接触 |
| 配额水位 | **D1** `quota_daily`（Cron 汇总） | 每天写一次 |

**命名约定（R2）**：`{env}/sessions/{sid}/files/{transferId}/{chunk:05d}`、`{env}/sessions/{sid}/results/{taskId}.bin`、`{env}/payloads/{payloadId}/{filename}`、`{env}/screens/{sid}/{ts}.jpg`。全部以 `{env}` 前缀隔离，方便一次性清空演练环境。

---

## 6. 通道策略（主 / 备 / 兜底）

| 优先级 | 通道 | 触发条件 | 代价 |
|---|---|---|---|
| P0 | **WSS 长连**（DO hibernation） | 默认 | 空闲≈0；消息 20:1 计费 |
| P1 | **HTTPS 批量轮询** | WS 被中间设备阻断 | 请求额度随"台数 × 频率"线性增长 |
| P2 | **R2 死信箱** | 只能出站 HTTPS 且不能长连 | 需要轮询 R2（Class B） |
| P3 | **DNS/DoH TXT** | 极端受限（只允许 DNS） | 带宽极低、CF API 限速、只做控制面 |

> 通道选择是**植入体配置项**，服务端不强制。所有通道共用同一套 L1 信封与 L2 密文，只换承载方式——这是"通道注册表"的落地方式。

---

## 7. 部署拓扑

```
example.com (zone, Cloudflare 托管)
├── c2.example.com      → Route → stc2-edge     (橙云代理，禁止缓存 /v1/*)
│   └── 仅供植入体：register / ws / beacon / file / d
├── ops.example.com     → Route → stc2-console  (橙云代理 + Cloudflare Access 策略)
│   └── 仅供操作员：SPA + /api/v1/*
└── (可选) 其它子域      → 同一 edge worker，做域名轮换
```

资源清单（一个账号内）：

| 资源 | 数量 | 免费额度 | 备注 |
|---|---|---|---|
| Workers | 2 | 100 | 付费版可再拆分 |
| D1 | 1（`stc2-core`） | 10 | 单库上限 500 MB（免费）→ 必须做结果外置 |
| KV | 2（`TOKENS`, `CONFIG`） | 1,000 | 用途严格限定 |
| R2 | 1 bucket（`stc2`） | — | 前缀隔离环境 |
| DO 类 | 2（`SessionDO`, `HubDO`） | 100 | SQLite 后端 |
| Queue | 1（可选 `stc2-jobs`） | 10,000 | 归档/通知，可选 |
| Cron | 2 | 5 | 清理 + 日报 |

---

## 8. 请求预算（每类请求的 CPU 与 IO 上限）

| 请求 | CPU 预算 | D1 查询 | DO 调用 | R2 |
|---|---|---|---|---|
| `POST /v1/register` | ≤ 3 ms（1 次 HMAC + 1 次 AEAD） | 1 写 + 1 读 | 1 | — |
| `GET /v1/ws/beacon` | ≤ 2 ms（验签 + 转发） | 0 | 1 | — |
| WS 单帧（心跳） | ≤ 0.5 ms | 0 | 0（对象内） | — |
| WS 单帧（结果） | ≤ 1 ms | 1 写（异步 batch） | 0 | 视大小 |
| `POST /api/v1/sessions/:id/tasks` | ≤ 3 ms | 1 写 | 1 | — |
| 控制台列表 | ≤ 5 ms（分页 50 条） | 1 读 | 0 | — |
| 文件分片 | ≤ 5 ms（流式） | 1 写 | 0 | 1 写 |

> 任何超过 5 ms 的功能（比如"服务端解密后搜索"）在设计上就不允许——这也是"零知识"带来的额外红利：**不让服务端碰明文，顺便保住了 CPU 预算**。

---

## 9. 与 VShell 的差异（一句话版）

| 维度 | VShell | Stratus |
|---|---|---|
| 服务端形态 | 单个常驻进程 | 两个 Worker + 无状态存储 |
| 通信 | 轮询为主 | WS + hibernation 为主 |
| 密钥 | per-listener 盐 | per-session ECDH，服务端零知识 |
| 内网 | 服务端建隧道 | 植入体做代理 + 操作员本地客户端 |
| 载荷 | 服务端编译 | 本地编译，云端只发配置 |
| 授权 | license 门控 | MIT 全功能 |

---

## 10. 已知取舍（写在这里，避免以后被当成 bug）

1. **实时 shell 的延迟下限 ≈ 心跳间隔/2**（默认 60 s 心跳，但 WS 在线时是即时的；只有离线补发才受心跳影响）。
2. **屏幕流不是视频**：最高 2 fps，且帧走 R2，控制台按"有新帧"拉取。
3. **DNS 通道只做控制面**，不能传文件（TXT 记录 ~255 字节/条，且被 DNS 缓存拖慢）。
4. **无法做真正的 TCP 反向隧道**（平台限制），"pivot" 一律是应用层封装。
5. **免费额度下不能跑"大规模扫描"**：一次 1,000 台的端口扫描结果回传就会吃掉 DO 请求额度；扫描应在植入体侧完成并把结果压缩后一次性回传。
