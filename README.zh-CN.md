# Stratus · 纯 Cloudflare 的 C2 框架（层云）

> 一个**不需要任何自有服务器**的 C2 框架：服务端只用一个 Cloudflare 账号上的免费服务
> （Workers / Durable Objects / D1 / KV / R2 / Queues / Cron），一个已托管到 Cloudflare 的域名即可开跑。
>
> **仅用于授权红队演练、渗透测试与安全研究。** 未授权使用属违法行为，与本项目无关。

[English](./README.md) | **简体中文**

---

## 这是什么

Stratus 把 C2 的"服务端"整个搬到 Cloudflare 边缘：

| 传统 C2 | Stratus |
|---|---|
| 一台 VPS（要备案、要买、会被封） | **0 台服务器**：两个 Worker + CF 存储 |
| 常驻进程、内存里存会话 | 无常驻进程：**每会话一个 Durable Object**（空闲自动休眠） |
| 自己写监听器协议 | 只有 HTTPS/WSS 入站（**平台没有 TCP/UDP 入站**） |
| 服务端能看所有明文 | **端到端加密**：CF 侧只看到密文与元数据 |
| 轮询心跳，机器一多就打满 | **WS + hibernation**：空闲 0 计费，100 台在线也只吃几个请求 |

它不是一个"能打穿内网"的框架——平台限制决定了它**做不到**（`connect()` 禁止连私有地址、
Worker 不能监听端口）。**内网能力放在植入体侧**，云端只做转发。这一点在设计文档里反复写死了。

## 功能状态（说实话，不打勾不算）

| 模块 | 状态 | 说明 |
|---|---|---|
| edge worker：注册 / WS / HTTP beacon / 文件分片 / 载荷下载 / 诱饵 | ✅ 已实现 | `workers/gateway` |
| console worker：会话/任务/结果/载荷/公钥/审计/统计/配额 | ✅ 已实现 | `workers/console` + Hono + Drizzle |
| SessionDO：hibernation、任务队列、去重、结果落库、alarm 清理 | ✅ 已实现 | 每会话一个对象 |
| HubDO：注册 nonce 去重、会话在线索引、操作员扇出 | ✅ 已实现 | — |
| E2E 加密（P-256 + HKDF + AES-GCM，浏览器侧加密） | ✅ 已实现 | `packages/shared`，18 个单测 |
| D1 schema + 迁移（Drizzle ORM） | ✅ 已实现 | `packages/db` + `db/migrations` |
| 控制台 UI（Vue3 + shadcn 风格 + Element Plus） | ✅ 可用 | 会话/任务/载荷/密钥/审计/配额/设置 |
| 参考植入体（Go，HTTP beacon） | ✅ 可编译可上线 | `clients/go` |
| WS 主通道的植入体实现 | 🟡 协议已定、参考实现待补 | 帧格式与 DO 侧已完成 |
| 交互式 PTY / 屏幕流 / 键鼠 | 🟡 协议预留（`io` / `screen` 帧） | 未实现 |
| SOCKS5 pivot | 🟡 设计完成（植入体侧代理 + 操作员本机客户端） | 未实现 |
| DNS/DoH 兜底通道 | 🟡 设计完成 | 未实现（需要 CF DNS API token） |
| 开发/测试/构建 | ✅ `pnpm typecheck` / `test` / `build` 全绿 | CI 见 `.github/workflows/ci.yml` |

## 架构（30 秒版）

```
植入体(任意语言) ──HTTPS/WSS──▶ stc2-edge (Worker) ──▶ SessionDO (每会话一个)
                                                            │  密文原样转发
操作员(浏览器) ───HTTPS/WSS──▶ stc2-console (Worker) ───────┘
                                  │
                                  ├── D1   账本（会话/任务/结果索引/审计）
                                  ├── KV   一次性令牌 / 配置
                                  ├── R2   载荷 / 文件分片 / 大结果
                                  └── Cron 清理 + 配额日报
```

完整设计（含时序图、威胁模型、配额推导）见 [docs/02-architecture](docs/02-architecture/01-system-architecture.md)。

## 快速开始

```bash
# 0) 前置：Node ≥ 20、pnpm、一个托管在 CF 的域名、wrangler 登录
pnpm i && pnpm build

# 1) 创建资源（D1 / KV / R2），把 id 填进两个 wrangler.jsonc
wrangler d1 create stc2-core
wrangler kv namespace create TOKENS
wrangler kv namespace create CONFIG
wrangler r2 bucket create stc2

# 2) 迁移 + 密钥
wrangler d1 migrations apply stc2-core --remote
wrangler secret put ADMIN_TOKEN -c workers/console/wrangler.jsonc

# 3) 部署（先 edge，再 console —— DO 类定义在 edge）
pnpm deploy:edge && pnpm deploy:console

# 4) 打开 https://ops.example.com → 生成操作员密钥 → 创建载荷 → 本地编译植入体
cd clients/go && go build -ldflags "-X main.cfgEndpoint=... -X main.cfgPskId=... ..." -o beacon .
```

逐步说明（含 Cloudflare Access 加固、WAF 放行、排错）见 [部署手册](docs/06-operations/01-deployment.md)。

## 目录

```
stratus-c2/
├── workers/gateway/      # edge：植入体平面（注册/WS/beacon/文件/下载/诱饵）
├── workers/console/      # console：管理平面（Hono REST + SPA 托管）
├── packages/shared/      # 协议帧、密码学、配额常量（前后端共用）
├── packages/db/          # Drizzle schema + D1 客户端
├── apps/web/             # Vue3 + Vite + Element Plus 控制台
├── clients/go/           # 参考植入体（纯标准库）
├── db/migrations/        # D1 迁移（drizzle-kit 生成）
└── docs/                 # 调研 / 架构 / 协议 / 客户端 / 前端 / 运维
```

## 文档索引

| 文档 | 内容 |
|---|---|
| [01 · Cloudflare 平台限额](docs/01-research/01-cloudflare-platform-limits.md) | 免费额度逐条核实（带官方链接）+ 100 会话配额预算 |
| [02 · VShell 功能矩阵](docs/01-research/02-vshell-feature-matrix.md) | VShell 能力清单 × 纯 CF 可行性判定 |
| [03 · 本地三仓分析](docs/01-research/03-local-repo-analysis.md) | Rshell / Rshell-web / ToShell 的架构与可借鉴点 |
| [05 · 前端技术栈](docs/01-research/04-frontend-stack.md) | shadcn-vue × Element Plus 混用的坑与选型 |
| [06 · Prior art](docs/01-research/05-prior-art.md) | CF 上做 C2/隧道的既有实践与红线 |
| [02-01 · 总体架构](docs/02-architecture/01-system-architecture.md) | 为什么是两个 Worker、每会话一个 DO、数据放哪 |
| [02-03 · 数据模型](docs/02-architecture/02-data-model.md) | D1/DO/KV/R2 的表结构与读写纪律 |
| [02-04 · 密码学](docs/02-architecture/03-crypto-design.md) | 密钥层级、AAD、威胁模型、校验清单 |
| [02-05 · 通道](docs/02-architecture/04-transport-channels.md) | WS hibernation / 轮询 / R2 死信箱 / DoH |
| [03-01 · 信封格式](docs/03-protocol/01-envelope.md) | L1/L2 双层帧、去重、合批 |
| [03-02 · 植入体 API](docs/03-protocol/02-client-ingress-api.md) | 注册/WS/beacon/文件/下载 |
| [03-03 · 管理 API](docs/03-protocol/03-admin-api.md) | 控制台 REST + WS |
| [03-04 · 任务目录](docs/03-protocol/04-task-catalog.md) | 任务类型、状态机、破坏性分级 |
| [03-06 · 认证与授权](docs/03-protocol/06-auth-and-rbac.md) | Access/token、角色、密钥生命周期 |
| [04-01 · 植入体规范](docs/04-client/01-implant-spec.md) | **语言无关**实现指南（含各语言原语对照） |
| [05-01 · 前端设计](docs/05-frontend/01-design-system.md) | 主题桥接、组件清单、WS 客户端、体积预算 |
| [06-01 · 部署](docs/06-operations/01-deployment.md) | 从零到上线 + 回滚 + 清理 |
| [06-02 · 配额与成本](docs/06-operations/02-quota-and-cost.md) | 免费额度怎么算、什么时候会撞线 |
| [06-03 · Runbook](docs/06-operations/03-runbook.md) | 演练中会遇到的事故与处置 |
| [06-04 · 排错](docs/06-operations/04-troubleshooting.md) | 1102/1027/1016 与常见坑 |

## 安全模型（三句话）

1. **服务端零知识**：任务与结果在浏览器/植入体侧 AES-256-GCM 加密，Cloudflare 与我们自己的 Worker 都拿不到明文；只看到 sid、序号、大小、时序。
2. **密钥不进服务端**：操作员私钥在浏览器 IndexedDB（`CryptoKey`，不可导出）；植入体的 ephemeral 私钥每次启动重生成。
3. **代价要认**：私钥丢了 → 历史结果永久不可读；载荷 PSK 被逆向 → 别人能冒充该载荷注册新会话（但不能解你的历史流量）。

详见 [密码学设计](docs/02-architecture/03-crypto-design.md) 与 [威胁模型](docs/02-architecture/05-threat-model.md)。

## 平台红线（别踩）

- **不要**用 Worker 做通用代理/VPN（Self-Serve 条款 §2.2.1(j) 明确禁止，实测会被 abuse 封号）；
- **不要**把这里当"内网扫描器"：Worker 连不到内网，扫描只能在植入体侧做；
- **不要**在免费额度上跑轮询心跳（100 台 × 30s = 288k 请求/天 > 100k）；
- 演练结束**记得删 Worker / R2 / D1 / DNS 记录**（[清理步骤](docs/06-operations/01-deployment.md#10-清理演练结束)）。

## 许可证与致谢

[MIT](./LICENSE)。设计上参考了 [VShell](https://github.com/veo/vshell) 的公开讨论（仅吸收设计思想，
未复制其代码/协议常量/前端资源），以及本地两个 MIT 项目 [Rshell](https://github.com/Rubby2001/Rshell---A-Cross-Platform-C2)、
[ToShell](https://github.com/iQingshan/Toshell) 的工程取舍，详见 [THIRD-PARTY-NOTICES](./THIRD-PARTY-NOTICES.md)。

## 状态

`0.1.0` — 协议与控制面完整、参考植入体可上线、WS 主通道的植入体实现待补。
路线图见 [ROADMAP.md](./ROADMAP.md)。
