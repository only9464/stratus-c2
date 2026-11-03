# 00 · 一页纸

## 它是什么

一个**服务端完全跑在 Cloudflare 免费额度上**的 C2 框架：

- **edge worker**（`c2.example.com`）：植入体唯一能连的入口，只做认证、转发、存分片。
- **console worker**（`ops.example.com`）：操作员控制台 + REST API，托管 Vue SPA。
- **SessionDO**：每个会话一个 Durable Object，用 WebSocket hibernation 承载实时通道，空闲不计费。
- **D1 / KV / R2 / Cron**：账本、一次性令牌、文件与载荷、清理与日报。

## 它不是什么

| 不是 | 原因 |
|---|---|
| 通用代理 / VPN / 翻墙节点 | 违反 Cloudflare 条款，实测封号；本项目不含此类代码 |
| 内网扫描器 | Worker 的 `connect()` 禁止连私有地址，摸不到靶标内网 |
| "能打穿一切"的 C2 | 只有 HTTPS/WSS 入站；没有 TCP/UDP 监听，没有 DNS 权威 |
| VShell 的复刻 | 协议、帧格式、加密方案全部独立设计；只吸收公开讨论中的设计思想 |
| 免杀工具 | 项目只管协议与控制面；载荷工程（免杀/加载器/持久化）属于使用者范畴 |

## 三个数字

| 数字 | 含义 |
|---|---|
| **10 ms** | 免费计划每请求 CPU 上限 → 决定了"每请求只做常数级工作" |
| **100,000/天** | Workers 请求上限 → 决定了"必须 WS，不能轮询" |
| **13,000 GB-s/天** | DO duration 上限 → 配 hibernation 可支撑约 28 小时"活跃对象时间/天" |

## 三条设计红线

1. **服务端零知识**：L2 密文的密钥只存在于操作员浏览器与植入体之间；Cloudflare 与我们自己的 Worker 都解不开。
2. **fail-closed**：未知通道/未知任务/缺绑定/schema 不匹配 → 报错，不回退。
3. **不假装**：做不到的能力（UDP、域前置、TCP 隧道、服务端编译）在文档与 UI 里都明确标注，不提供"点了没反应"的按钮。

## 五分钟上手

```bash
pnpm i && pnpm build
wrangler d1 create stc2-core && wrangler kv namespace create TOKENS && wrangler kv namespace create CONFIG
wrangler r2 bucket create stc2
wrangler d1 migrations apply stc2-core --remote
wrangler secret put ADMIN_TOKEN -c workers/console/wrangler.jsonc
pnpm deploy:edge && pnpm deploy:console
```

→ 打开 `https://ops.example.com` → 生成操作员密钥 → 创建载荷 → 编译 `clients/go` → 会话上线。

细节：[部署手册](./06-operations/01-deployment.md)。
