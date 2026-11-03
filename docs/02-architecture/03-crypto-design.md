# 02-03 · 密码学设计（服务端零知识）

> 目标：**Cloudflare 侧（包括我们自己的两个 Worker、DO、D1、R2、日志、支持工单）拿不到任务与结果的明文**。
> 手段：两层密钥——外层给"网关认证"，内层给"端到端加密"。两层密钥**互不派生**。

---

## 1. 威胁模型（先说清楚防谁）

| 角色 | 能力 | 我们要防到哪一步 |
|---|---|---|
| 被动网络观察者 | 看得到 TLS 内的密文、包大小、时序 | ✅ 内容不可读；元数据（大小/时序）不隐藏（明说不做流量整形） |
| Cloudflare（平台方） | 能读 Worker 内存、DO/D1/R2 内容、日志 | ✅ 内容不可读（零知识）；元数据可见 |
| Cloudflare 账号被盗 | 能改 Worker 代码、读全部存储、删数据 | 🟡 不能伪造任务（AEAD 密钥不在服务端），但能 DoS、删数据、观察元数据 |
| 网关被攻破（edge worker RCE） | 能拦截所有植入体流量 | 🟡 能拿到 L1 会话令牌与 PSK 派生材料 → 可冒充"服务端"给植入体发帧，**但不能伪造操作员签发的任务**（内层 AEAD 拦住） |
| 操作员设备被攻破 | 有私钥 | ❌ 无法防（等价于拿到操作员身份） |
| 恶意植入体 | 拿着别人的 PSK/会话 ID 想劫持 | ✅ 会话令牌 + `implant_pub` 绑定 + PSK 挑战 |
| 分析人员拿到载荷样本 | 能逆向出 PSK 与操作员公钥 | 🟡 可冒充该载荷注册新会话（所以 PSK 要 per-payload、可批量吊销）；**不能解密历史流量**（没有操作员私钥） |

**不做的事**（明确写下来，避免过度承诺）：流量整形/填充、抗流量分析、抗时间关联、抗 DNS 元数据关联。

---

## 2. 密钥层级

```
payload_psk (32B, 构建时随机)
   │  只用于 L1：向 edge 证明"我是这个载荷的合法实例"
   ├── HKDF(psk, "stc2/v1/reg")  → K_reg   (HMAC-SHA256 注册挑战)
   └── HKDF(psk, "stc2/v1/sess") → K_sess  (会话令牌的 HMAC key，绑定 sid)

operator_identity (P-256, 浏览器生成, 私钥 non-extractable)
   │  公钥：登记到 D1 + 写进载荷配置
   └── ECDH(op_priv, implant_eph_pub) = Z
         ├── HKDF(Z, salt=sid, info="stc2/v1/cmd")  → K_cmd   (任务/命令)
         ├── HKDF(Z, salt=sid, info="stc2/v1/io")   → K_io    (终端/交互流)
         └── HKDF(Z, salt=sid, info="stc2/v1/file") → K_file  (文件分片)

implant_ephemeral (P-256, 每次进程启动重新生成, 不落盘)
   └── 公钥随 hello 上报；私钥只在内存
```

**三条铁律**

1. `payload_psk` **绝不**用于加密任务内容——否则拿到载荷样本的人就能解密所有流量，且网关也顺带拿到了内容密钥。
2. `K_cmd/K_io/K_file` 只由 ECDH 派生，**服务端两侧都算不出来**（没有操作员私钥）。
3. 每个会话的 `Z` 不同（因为 `implant_eph` 每次重启都换），所以**换机/重启即换密钥**，历史上限泄露的影响面被限制在单次进程生命周期。

---

## 3. 算法选型与理由

| 用途 | 选择 | 理由 |
|---|---|---|
| 密钥协商 | **ECDH P-256** | 浏览器 WebCrypto、Workers WebCrypto、Go `crypto/ecdh`、.NET `ECDiffieHellman` 全都稳定支持；X25519 在各端支持度不一（Workers 侧随兼容日期变化），不作为默认 |
| KDF | **HKDF-SHA256** | 三端都有；输出定长、可域分离 |
| AEAD | **AES-256-GCM** | 三端硬件加速；Workers 与浏览器都原生支持；12 字节 nonce 语义清晰 |
| 认证（L1） | **HMAC-SHA256** | 恒定时间比较；不需要非对称 |
| 随机 | `crypto.getRandomValues` / `crypto/rand` / `RandomNumberGenerator` | 平台 CSPRNG |
| 哈希/指纹 | **SHA-256** | 公钥指纹 = `SHA256(pub_raw)` 前 8 字节 hex |

**不选 ChaCha20-Poly1305 的原因**：Workers 的 WebCrypto 是否暴露该算法随兼容性策略变化，不能作为"必须能用"的地基；AES-GCM 在 Cloudflare 与浏览器两端都是确定可用的。

---

## 4. L1 信封（服务端可见）

```jsonc
// 上行（implant → edge）
{
  "v": 1,                       // 协议版本
  "t": "hello|hb|res|io|file|ack|bye",
  "sid": "b64u(16B)",           // 会话 ID
  "seq": 1234,                  // 单调递增，每会话每方向独立
  "ts": 1763000000,             // unix 秒（允许 ±300 s 漂移）
  "n":  "b64u(12B)",            // GCM nonce（仅密文帧）
  "ct": "b64u(...)",            // 密文（L2）
  "meta": { "sz": 2048, "tid": "b64u(16B)", "k": "res|io|cmd" }
}
```

**认证**：`Authorization: Bearer <session_token>`，其中
`session_token = b64u( HMAC-SHA256(K_sess, sid || implant_pub || issued_at) )`，
`K_sess = HKDF(payload_psk, "stc2/v1/sess")`。

**为什么不用 JWT**：JWT 要解析+验签，属于额外 CPU；这里只需要"能验证且不透明"，HMAC 更省。

**重放防护**

- `seq` 单调递增，DO 维护"已见窗口"（最近 256 个 seq + 高水位），重复或过期直接丢弃并计数。
- `ts` 只用于注册阶段的新鲜性校验（±300 s）。
- GCM nonce 由"每方向计数器"生成，接收端拒绝重复 nonce；**同一密钥下 nonce 复用 = 灾难**，所以计数器是持久化的（DO SQLite）。

---

## 5. L2 载荷（服务端不可见）

```jsonc
// 明文（只在两端存在）
{
  "k": "shell.exec",            // 任务类型
  "a": { "cmd": "whoami", "cwd": "C:\\" },
  "rid": "b64u(8B)",            // 请求 ID（回显关联）
  "ttl": 60
}
```

- 加密：`AES-256-GCM(K_cmd, nonce, plaintext, aad)`
- `aad = "stc2/v1" || dir(1B: 0=op→implant, 1=implant→op) || sid(16B) || seq(8B big-endian) || rid(8B)`
- **AAD 把"帧"和"内容"绑死**：截获一帧改 `seq` 或挪到别的会话，解密直接失败。

> 这意味着**服务端无法重排/重放任务而不被发现**。它也意味着：**服务端不能压缩、不能搜索、不能改写密文**——所有"服务端智能"能力（比如"在服务端过滤结果")在设计上就放弃。

---

## 6. 握手时序

```
implant                                        edge                         operator(browser)
   │  POST /v1/register                          │                                  │
   │  {psk_id, nonce_c, hmac=HMAC(K_reg, nonce_c │                                  │
   │     || psk_id || ts), implant_pub, caps}    │                                  │
   │────────────────────────────────────────────▶│ 查 payloads(psk_id) 取盐/状态     │
   │                                             │ 校验 HMAC + ts 窗口               │
   │                                             │ 生成 sid，写 D1 sessions          │
   │◀── {sid, session_token, op_pub_fp, cfg,     │                                  │
   │     nonce_s}                                │                                  │
   │                                             │                                  │
   │  校验 op_pub_fp == 内置内置指纹（防网关换 key） │                                  │
   │  计算 Z = ECDH(eph_priv, op_pub)             │                                  │
   │  派生 K_cmd/K_io/K_file                      │                                  │
   │                                             │                                  │
   │  GET /v1/ws/beacon (Upgrade)                 │                                  │
   │────────────────────────────────────────────▶│──▶ SessionDO.acceptWebSocket()    │
   │◀────────────── hello_ack (L1) ──────────────│                                  │
   │                                             │◀─── WS /api/v1/ws/session/:id ───│
   │                                             │     （操作员附着，ECDH 同样算 Z）  │
```

**关键设计：`op_pub_fp` 校验。** 载荷里不只嵌公钥，还嵌**公钥指纹**；注册响应里的公钥必须匹配指纹，否则植入体直接退出。这挡住了"网关用自己的公钥替换操作员公钥"的中间人。

---

## 7. 密钥生命周期

| 事件 | 处理 |
|---|---|
| 植入体重启 | 新 `implant_eph` → 新 `Z` → 新 `K_*`；旧 sid 作废（新 sid） |
| 会话超过 24 h | 建议植入体主动重连（换密钥）；服务端不强制 |
| `payload_psk` 泄露 | 控制台"吊销载荷"→ 该 `psk_id` 的注册一律 403；已在线的会话不受影响（它们已经有自己的密钥） |
| 操作员换设备 | 生成新密钥对，登记为"新 key_id"；旧 key 保留只读（历史任务可解）或撤销（新任务不再用它） |
| 操作员密钥丢失 | **历史任务不可恢复**（这是零知识的代价）；服务端只留密文，操作员只能靠备份 |
| 备份 | 私钥导出为 `PKCS#8`，用 `PBKDF2-SHA256(600k) + AES-256-GCM` 包裹后存本地（浏览器侧实现"导出加密备份"） |

---

## 8. 多操作员

- 每个操作员有独立 `key_id`。
- **会话绑定"创建者"的 key**：`sessions.owner_key_id`。默认只有 owner 能下发任务；"协作者"角色可读不可写（权限在 console 层判定）。
- 要支持"多人同时操作同一会话"，两种模式：
  - **共享模式（默认）**：团队成员导入同一个操作员密钥（团队密钥），代价是无法区分"谁下的任务"（审计靠 console 的登录身份而非密钥）。
  - **委托模式（v2）**：每个协作者生成自己的密钥，任务里带 `signed_by`，植入体只认 `owner_key`（简单）或多 key 白名单（复杂）。
- v1 只做**共享模式**，并在文档里写明"审计里看到的是登录用户，不是密钥持有者"。

---

## 9. 校验清单（实现方必须逐条过）

- [ ] `payload_psk` 长度 = 32 B，随机来源是 CSPRNG，**不进日志、不进 Git**。
- [ ] 注册阶段校验 `ts` 漂移（±300 s），防重放。
- [ ] `nonce_c` 在 `psk_id` 维度上至少 24 h 内不复用（DO 记最近 64 个）。
- [ ] `session_token` 的 HMAC 比较用**恒定时间**比较（`crypto.subtle.verify` 或手写常量时间比较）。
- [ ] 每个 WS 帧先验 `seq`/`ts`/`sid`，再做任何事；失败直接 close(1008)。
- [ ] 单帧 `ct` 长度上限（默认 1 MiB；文件分片单独走 `PUT /v1/file`）。
- [ ] GCM nonce 计数器**持久化在 DO SQLite**，DO 重建后不归零。
- [ ] 解密失败不返回"为什么失败"（统一 400 + 计数）。
- [ ] 公钥指纹校验失败时植入体应**静默退出**（不回连、不打日志）。
- [ ] 私钥永不出现在任何 HTTP 响应、日志、D1 字段里。
- [ ] 控制台"复制命令"功能只复制**密文任务 ID**，不复制明文命令。

---

## 10. 测试向量（互操作）

`packages/shared/test/vectors.json` 里维护一组固定测试向量（P-256 公钥、Z、HKDF 输出、GCM 密文），任何语言的实现都应能复现。生成与校验方式：

```bash
pnpm --filter @stratus/shared test          # 读取 vectors.json，校验 HKDF/GCM 结果
node scripts/gen-vectors.mjs               # 重新生成（仅在算法变更时使用）
```

向量格式（片段）：

```jsonc
{
  "op_priv_pkcs8": "b64u(...)",   // 仅测试用，真实环境不落盘
  "op_pub_raw": "b64u(65B)",
  "implant_priv_pkcs8": "b64u(...)",
  "implant_pub_raw": "b64u(65B)",
  "z": "b64u(32B)",
  "sid": "b64u(16B)",
  "k_cmd": "b64u(32B)",
  "aad": "b64u(...)",
  "nonce": "b64u(12B)",
  "plaintext": "{\"k\":\"ping\"}",
  "ciphertext": "b64u(...)"
}
```

---

## 11. 明确不做的密码学工作

| 不做 | 原因 |
|---|---|
| 自定义密码算法 / 自研分组密码 | 无必要且风险高 |
| 服务端托管私钥（"方便"模式） | 破坏零知识目标；想要方便就用 `AUTH_MODE=token` + 关闭 E2E（配置项，默认关） |
| 前向安全的"棘轮" | v1 用"每次重启换密钥"已能覆盖大部分场景；棘轮会显著增加客户端复杂度 |
| 抗量子 | 超出范围；P-256 目前是工程最优解 |
| 隐写 / 流量填充 | 见威胁模型：不做流量分析对抗 |
