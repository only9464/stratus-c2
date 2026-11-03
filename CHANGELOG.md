# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/)，版本号用 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.1.0] — 2026-11

首个可运行版本。**目标不是功能齐全，而是把"纯 Cloudflare 的 C2 能不能成立"这件事验证到底。**

### 新增

**平台调研（docs/01-research）**

- Cloudflare 免费额度逐条核实（Workers/DO/D1/KV/R2/Queues，全部带官方链接），并给出 100 会话 24h 的配额预算。
- VShell 功能矩阵 × 纯 CF 可行性判定（✅/🟡/❌ 三档 + 替代方案）。
- 本地三个参考仓库（Rshell / Rshell-web / ToShell）的架构分析、24 条可借鉴设计、18 条反面教材。
- CF 上做 C2/隧道的 prior art 与平台红线（域前置直接 421、Tunnel 需要常驻主机、代理用途封号）。
- 前端选型（shadcn-vue × Element Plus 混用的 7 个坑与规避）。

**架构与协议（docs/02-03）**

- 两个 Worker 的平面隔离（植入体平面 / 操作员平面），跨 Worker 通过 service binding + DO `script_name` 共享 DO。
- 每会话一个 `SessionDO`：WS hibernation、任务队列、seq 去重、结果落库、alarm 清理。
- 双层信封：L1（服务端可见的路由/认证/序号）+ L2（服务端不可解的端到端密文）。
- 密码学：P-256 ECDH + HKDF-SHA256 + AES-256-GCM；AAD 绑定 `dir‖sid‖ctr‖rid`；公钥指纹校验防网关换 key。
- 通道分层：WS 主通道（hibernation，固定心跳走自动应答）、HTTP 批量轮询兜底、R2 死信箱、DoH TXT 兜底（仅控制面）。
- D1 schema（14 张表）+ Drizzle ORM + 迁移脚本。

**实现**

- `workers/gateway`：`/v1/register`、`/v1/ws/beacon`、`/v1/beacon`、`/v1/file/:tid/:idx`、`/d/:token`、诱饵 404。
- `workers/console`：会话/任务/结果/载荷/公钥/审计/统计/配额 + 两个 WS 入口 + SPA 托管。
- `packages/shared`：base64url、帧编解码、SeqWindow、HKDF/HMAC/AEAD/ECDH、配额估算、通道注册表（18 个单测）。
- `apps/web`：Vue 3 + Vite + Element Plus + Tailwind v4 + 本地 shadcn 风格组件；登录/概览/会话/会话详情/任务/载荷/密钥/审计/配额/设置。
- `clients/go`：纯标准库参考植入体（注册、ECDH、解密任务、执行、加密回传、退避）。

### 已知限制（如实记录）

- 参考植入体只实现 HTTP beacon；WS 主通道的客户端待补（协议与 DO 侧已完成）。
- 未实现 PTY、屏幕流、键鼠、文件分片（协议已预留 `io`/`file`/`screen` 帧）。
- 未实现 SOCKS5 pivot 与 DoH 通道（设计完成）。
- `AUTH_MODE=access` 采用"轻校验"（依赖 Access 已强制策略），未实现 JWKS 验签。
- 结果 > 4 KB 落 R2 后，控制台只展示"已外置"，尚未做前端分页回读。
- 免费额度下 R2 存储（10 GB-month）是最先撞线的一项，需要靠 TTL 清理控制。
