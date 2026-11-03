# 安全策略

## 报告漏洞

请**不要**开 public issue。发邮件到 `security@example.com`（开源时替换为真实邮箱），并包含：

- 影响版本 / commit
- 复现步骤（最小化）
- 影响面（能否导致：解密任务、伪造会话、越权、SSRF、配额耗尽）
- 你的修复建议（可选）

72 小时内响应；确认后 30 天内出修复或缓解措施，并在 `CHANGELOG.md` 中记录（不披露可利用细节直到用户升级）。

## 本项目关心的威胁（按严重度）

| 等级 | 威胁 | 现状 |
|---|---|---|
| Critical | 服务端能解出任务/结果明文 | 设计上不可能（密钥不经服务端）；出现即视为 P0 |
| Critical | 未授权者可伪造操作员任务 | 需要操作员私钥；AAD 绑定 sid/ctr/rid |
| High | 未授权者可注册会话（拿到载荷样本后） | 已知且记录在威胁模型：PSK 在样本里，可吊销 |
| High | 会话劫持（用别人的 sid/token） | token = HMAC(K_sess, sid‖pub‖iat)；需要 PSK |
| High | 路径穿越 / 任意文件读写 | 服务端无文件系统；R2 key 由服务端拼接并校验 sid 归属 |
| Medium | 重放（重复下发同一条命令） | transport seq 去重 + rid 去重 + ctr 单调 |
| Medium | 配额耗尽（攻击者刷端点） | 注册限速、body 上限、单帧上限；**这是免费额度的固有风险** |
| Medium | 管理端被爆破 | 默认 token 模式 + 建议套 Cloudflare Access |
| Low | 元数据泄露（大小/时序/主机名） | `META_MODE=sealed` 可减少；默认 `plain` 是明确的取舍 |

## 部署方必须做的事

1. `ADMIN_TOKEN` 用 32 字节随机值（`openssl rand -base64 32`），**不要**用默认值。
2. 生产环境 `AUTH_MODE` 设为 `access`（Cloudflare Access 前置）或强 token。
3. `c2.example.com` 的 WAF 放行 `/v1/*`，关闭 Bot Fight Mode / Under Attack Mode（会拦截植入体）。
4. 不要在 `wrangler.jsonc` 里写任何密钥（会被提交）；用 `wrangler secret put`。
5. 演练结束按 [清理步骤](./docs/06-operations/01-deployment.md#10-清理演练结束) 拆干净。

## 已知不做防护的点（明确写下来）

- **流量分析**：包大小、时序、连接频率都没有隐藏。
- **平台方可见性**：Cloudflare 能在网络层看到连接元数据。
- **账号被盗**：攻击者能改 Worker 代码、删数据、观察元数据；**但不能解密历史流量**（密钥不在服务端）。
- **客户端安全**：植入体被逆向 = PSK 泄露；这是所有 C2 的共同问题。
