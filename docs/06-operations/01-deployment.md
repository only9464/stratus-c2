# 06-01 · 部署手册（一个 Cloudflare 账号，零自建服务器）

> 前置：一个 Cloudflare 账号（Free 计划）+ 一个已托管到 Cloudflare 的域名（zone 状态 Active）。
> 全程只有 `wrangler` 命令与控制台点击，**不需要任何 VPS、端口映射、反向代理**。
> 预计耗时：首次 20–30 分钟。

---

## 0. 架构与将创建的资源

| 资源 | 名字 | 说明 |
|---|---|---|
| Worker | `stc2-edge` | 植入体入口（`c2.example.com`） |
| Worker | `stc2-console` | 控制台 + API（`ops.example.com`） |
| D1 | `stc2-core` | 账本（免费 500 MB） |
| KV | `stc2-tokens` | 一次性下载令牌 |
| KV | `stc2-config` | 引导配置 / 公钥缓存 |
| R2 | `stc2` | 载荷 / 文件 / 结果 / 屏幕帧 |
| DO 类 | `SessionDO`, `HubDO` | 在 `stc2-edge` 里定义 |
| Queue（可选） | `stc2-jobs` | 归档/通知 |
| Cron | 2 个 | 清理 + 配额日报 |

---

## 1. 准备

```bash
# 1) 工具
node -v            # ≥ 20
corepack enable && corepack prepare pnpm@latest --activate
npm i -g wrangler  # 或 npx wrangler

# 2) 登录
wrangler login

# 3) 克隆 + 安装
git clone <你的仓库> stratus-c2 && cd stratus-c2
pnpm install
pnpm build          # 构建 shared + web + workers
```

确认账号与 zone：

```bash
wrangler whoami
wrangler zones list        # 记下 zone_id 与域名
```

---

## 2. 创建存储

```bash
# D1
wrangler d1 create stc2-core
# → 输出 database_id，填进两个 wrangler.jsonc 的 d1_databases[0].database_id

# KV
wrangler kv namespace create TOKENS
wrangler kv namespace create CONFIG
# → 各输出 id，填进 kv_namespaces

# R2
wrangler r2 bucket create stc2
```

> 免费计划每个账号 **10 个 D1 库、1,000 个 KV namespace、100,000 个 bucket**，这里只各用 1 个。

---

## 3. 配置

两个 Worker 的 `wrangler.jsonc` 里需要替换的占位符：

| 占位符 | 说明 |
|---|---|
| `<D1_ID>` | 上一步的 D1 `database_id` |
| `<KV_TOKENS_ID>` / `<KV_CONFIG_ID>` | KV namespace id |
| `<ZONE>` / `<EDGE_HOST>` / `<CONSOLE_HOST>` | 例如 `example.com` / `c2.example.com` / `ops.example.com` |
| `<ENV>` | `prod` / `lab`（R2 前缀与页面标识） |

> 建议把这三个 host 写进 `packages/shared/src/config.ts` 的默认值，避免前端硬编码。

---

## 4. 密钥

**永远不要**把密钥写进 `wrangler.jsonc`（会被提交）。用 `wrangler secret put`：

```bash
# edge
wrangler secret put AUTH_SECRET --config workers/gateway/wrangler.jsonc
#   → 32 字节随机：openssl rand -base64 32

# console
wrangler secret put ADMIN_TOKEN --config workers/console/wrangler.jsonc     # AUTH_MODE=token 时必填
wrangler secret put AUTH_SECRET --config workers/console/wrangler.jsonc     # 与 edge 相同（互验 token 时用）
wrangler secret put CF_DNS_TOKEN --config workers/console/wrangler.jsonc    # 可选：DoH 通道
```

`CF_DNS_TOKEN` 的权限要**最小化**：`Zone → DNS → Edit`，且 Resource 限定到那一个 zone。

本地开发用 `.dev.vars`（已在 `.gitignore` 里）：

```ini
AUTH_SECRET=dev-only-not-for-prod
ADMIN_TOKEN=dev-token
AUTH_MODE=dev
```

---

## 5. 数据库迁移

```bash
# 远端
wrangler d1 migrations apply stc2-core --remote

# 本地（wrangler dev 用）
wrangler d1 migrations apply stc2-core --local
```

校验：

```bash
wrangler d1 execute stc2-core --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

应看到 `audit_log / file_chunks / files / notes / operator_keys / operators / payloads / pivot_rules / quota_daily / screens / sessions / settings / task_results / tasks`。

---

## 6. 部署

顺序很重要：**先 edge（定义 DO 类），再 console（绑定 edge 的 DO）**。

```bash
pnpm --filter @stratus/gateway deploy     # 或 wrangler deploy -c workers/gateway/wrangler.jsonc
pnpm --filter @stratus/console deploy     # 或 wrangler deploy -c workers/console/wrangler.jsonc
```

`wrangler.jsonc` 里的 `routes` 会自动创建 DNS 记录（橙云）：

```jsonc
"routes": [{ "pattern": "c2.example.com/*", "zone_name": "example.com" }]
```

> 若域名下有冲突记录，先在 DNS 面板删掉同名 A/AAAA/CNAME 再部署。

---

## 7. 加固管理端（强烈建议）

1. Cloudflare Dashboard → **Zero Trust → Access → Applications → Add** → Self-hosted
2. Application domain：`ops.example.com`
3. Policy：`Allow` + `Emails ending in @yourteam.com`（或指定邮箱列表）
4. 会话时长 8 h；开启 **One-time PIN** 或接 IdP
5. 部署后在 `wrangler.jsonc` 设 `AUTH_MODE=access`，并（可选）开 `access-strict` 验签

同时确认 **WAF 不拦自家路径**：

- Security → WAF → Custom rules：对 `c2.example.com/v1/*` 放行（跳过托管规则与 Bot Fight Mode）。
- 关闭 `c2.example.com` 的 **Under Attack Mode**（会插 JS 挑战，植入体过不去）。
- 缓存规则：`/v1/*`、`/d/*` 一律 **Bypass cache**。

---

## 8. 验证（5 分钟冒烟）

```bash
# 1) edge 存活
curl -s -o /dev/null -w '%{http_code}\n' https://c2.example.com/health      # 期望 200

# 2) 未匹配路径是诱饵 404（不暴露 Worker）
curl -sI https://c2.example.com/whatever | head -5

# 3) 注册失败路径（无 PSK）
curl -s -X POST https://c2.example.com/v1/register -H 'content-type: application/json' \
  -d '{"v":1,"psk_id":"AAAAAAAA","ts":0,"nc":"x","h":"x","pub":"x","fp":"x"}'   # 期望 400/401，且错误体统一

# 4) 控制台健康
curl -s https://ops.example.com/api/v1/health                               # {"ok":true,...}

# 5) 前端能打开
curl -sI https://ops.example.com/ | head -3                                  # 200 + text/html
```

然后在控制台：**创建载荷 → 复制配置 → 本地编译参考植入体 → 运行 → 会话上线 → 下发 `sys.whoami`**。

---

## 9. 更新与回滚

```bash
# 更新代码
git pull && pnpm install && pnpm build
wrangler deploy -c workers/gateway/wrangler.jsonc
wrangler deploy -c workers/console/wrangler.jsonc

# 回滚 Worker（保留最近 10 个版本）
wrangler versions list -c workers/gateway/wrangler.jsonc
wrangler rollback <VERSION_ID> -c workers/gateway/wrangler.jsonc
```

数据库回滚（免费版 Time Travel 7 天）：

```bash
wrangler d1 time-travel restore stc2-core --timestamp 1763000000
```

---

## 10. 清理（演练结束）

```bash
wrangler delete -c workers/gateway/wrangler.jsonc
wrangler delete -c workers/console/wrangler.jsonc
wrangler r2 bucket delete stc2            # 先清空
wrangler kv namespace delete --namespace-id <ID>
wrangler d1 delete stc2-core
# 最后在 DNS 面板删掉 c2/ops 两条记录
```

> **R2 先清空**：`wrangler r2 object` 没有批量删，用控制台或 `scripts/purge-r2.ts`（按前缀列对象再删）。

---

## 11. 常见部署错误

| 错误 | 原因 | 处理 |
|---|---|---|
| `Error 10021 Script startup exceeded CPU time` | 全局作用域里做了重活（比如构建了巨大的 schema） | 把初始化移到请求内或构建期 |
| `Cannot use Durable Object binding ... migration` | console 先于 edge 部署 | 先 `deploy gateway` |
| `Error 1027` 每天 | 当日请求额度用完 | 查 `/api/v1/quota`，降级通道频率 |
| `1016 origin DNS error` | 路由的 host 没有橙云记录 | 检查 DNS 记录是否 Proxied |
| `1102 Worker exceeded resource limits` | 单请求 CPU 超 10 ms | 见 [排错](./04-troubleshooting.md) |
| Access 一直 302 | 策略没匹配到邮箱 | 改 Policy 或加 `Bypass` 给服务账号 |
| 前端 404（刷新后） | `not_found_handling` 没设 `single-page-application` | 改 `wrangler.jsonc` |
