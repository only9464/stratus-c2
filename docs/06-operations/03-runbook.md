# 06-03 · Runbook（演练中出事了怎么办）

> 原则：**先保控制面，再保会话**。控制台打不开时，一切排查都变盲。

---

## 0. 三分钟体检（每次开打前）

```bash
# 1) edge 活着
curl -s -o /dev/null -w '%{http_code}\n' https://c2.example.com/health      # 200

# 2) 控制台活着
curl -s https://ops.example.com/api/v1/health | jq

# 3) 库是通的（schema 版本对不对）
curl -s https://ops.example.com/api/v1/me -H "authorization: Bearer $TOKEN" | jq

# 4) 最近有没有 1027/1102（tail 30 秒）
timeout 30 npx wrangler tail stc2-edge --format json | jq -c 'select(.outcome!="ok") | {outcome, scriptName, event}'
```

---

## 1. 会话不上线

| 现象 | 先查 | 常见原因 | 处置 |
|---|---|---|---|
| 植入体报 `register failed: 401` | 控制台载荷是否 revoked；时间是否偏差 > 5 min | PSK 不对 / 载荷被吊销 / 时钟偏移 | 重新生成载荷；校正时间 |
| `register failed: 403` | `payloads.expires_at` / `revoked_at` | 载荷过期 | 新建载荷 |
| 注册成功但很快掉线 | `wrangler tail` 里的 1008 | 帧格式不对 / seq 从 0 开始 | 修客户端；seq 必须从 1 开始 |
| 注册成功但控制台列表没有 | 有没有 `hello` 帧 | 客户端只注册没发 hello | 补 hello（见协议 §2.3） |
| 列表有但状态永远 offline | DO 的 `presence` 与 D1 是否一致 | 客户端没发 hb | 加心跳 |

---

## 2. 任务下发后没结果

```
① 任务是否落库：SELECT status FROM tasks WHERE id=?
      queued    → DO 没推（会话不在线 / WS 没建）
      dispatched→ 推了但植入体没 ACK（结果没回）→ 看植入体
      done      → 结果在 task_results（可能已外置 R2）
② DO 侧：curl https://ops.../api/v1/sessions/<sid> 看 state？ → 直接 tail DO 日志
③ 植入体侧：解密是否失败（AAD/rid/ctr）
```

| 症状 | 原因 | 处置 |
|---|---|---|
| `queued` 不动 | 会话离线 | 等重连；DO 会在重连后补发 |
| `dispatched` 不动 | 植入体收到但执行卡住 | 检查 `ttl`；任务超时后状态应转 `expired` |
| 结果解密失败 | 用了另一把操作员密钥 | 换回原密钥；或重新下发 |
| 结果为空 | 命令本身无输出 | 正常；看 `exit` |

---

## 3. 控制台打不开

| 现象 | 检查 |
|---|---|
| 302 到 Access 登录页，登录后又跳回 | Access 策略没匹配到你的邮箱域 |
| 502 | console worker 部署失败/被删：`npx wrangler deployments list -c workers/console/wrangler.jsonc` |
| 白屏 | 资源没上传：`pnpm build` 后重新 `deploy:console`（`assets` 目录为空会 404） |
| `/api/v1/health` 503 `E_SCHEMA` | 迁移没跑：`wrangler d1 migrations apply stc2-core --remote` |
| 401 一直 | `ADMIN_TOKEN` 没设或与浏览器里存的不一致 |

---

## 4. 额度告警

| 症状 | 立刻做 |
|---|---|
| 1027（日请求满） | ① 停掉非必要客户端；② 把 `next` 拉到 900 s；③ 等 UTC 0 点 |
| 1102（CPU 超限） | 找出最慢的路径：`wrangler tail` 看 `cpuTime`；把重活移到 DO 或挪出请求路径 |
| D1 `overloaded` | 降低批量写入频率；把审计改成攒批 |
| R2 写失败 | 存储满了（10 GB-month 是月度额度，但写入失败通常是账单/限额）；先删旧对象 |
| DO `overloaded` | 单会话被打爆（通常是屏幕流）；降低帧率或断开会话 |

---

## 5. 安全事件

| 事件 | 处置顺序 |
|---|---|
| 载荷样本泄露 | ① 控制台 `DELETE /api/v1/payloads/:id` 吊销；② 观察有没有陌生会话上线；③ 保留证据（audit） |
| 操作员密钥疑似泄露 | ① 吊销该 key（`DELETE /api/v1/keys/:keyId`）；② 生成新密钥；③ 旧任务仍可解（密文没变），新任务用新 key |
| Cloudflare 账号被盗 | ① 改密码 + 开 2FA；② 检查 Worker 代码有没有被改（`wrangler deployments list`）；③ 检查 `operator_keys` 有没有被换（`op_fp` 变了说明被动手） |
| 收到 abuse 邮件 | **立即停机**（删路由/Worker），不要争辩；排查是否被改造成代理用途 |
| 目标侧发现异常 | 按演练授权范围决定是否中止；清理植入体（`selfdestruct`） |

---

## 6. 收尾（每次演练都做）

```bash
# 1) 吊销载荷、标记所有会话 dead
# 2) 导出审计/结果（如需要）
# 3) 清 R2（按前缀）
node scripts/purge-r2.mjs --env prod --before 2026-11-01
# 4) 删资源
wrangler delete -c workers/console/wrangler.jsonc
wrangler delete -c workers/gateway/wrangler.jsonc
```

> 收尾检查表：Worker 删了没、R2 空了没、D1 删了没、DNS 记录删了没、Access 应用删了没、本地 `config.json`/载荷样本删了没。
