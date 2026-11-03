# 03-01 · 信封格式（L1 传输层 / L2 端到端层）

> 一句话：**L1 给服务器看（路由 + 认证 + 序号），L2 只给两端看（任务与结果）**。
> 所有通道（WS/HTTP/R2/DoH）共用同一套信封，只有"怎么搬"不同。

---

## 1. 编码约定

| 项 | 规则 |
|---|---|
| 文本编码 | UTF-8；JSON 不做空白压缩以外的转换 |
| 二进制字段 | **base64url 无填充**（`-`/`_`，去掉 `=`） |
| 整数 | JSON number，安全整数范围内；超过 2^53 用十进制字符串 |
| 时间 | unix 秒（`ts`），毫秒仅用于 R2 键名 |
| 字节序 | AAD 里的整数为 **大端** |
| 大小上限 | 单帧 `ct` ≤ **1 MiB**（超出的数据走文件通道） |

---

## 2. L1 信封（服务端可解析）

### 2.1 通用结构

```jsonc
{
  "v": 1,
  "t": "hello",                  // 帧类型，见 §2.2
  "sid": "AAAA...",              // b64u(16B)，会话 ID
  "seq": 1,                      // 该方向单调递增，从 1 开始
  "ts": 1763000000,              // unix 秒
  "n":  "AAAAAAAAAAAAAAAA",      // b64u(12B)，GCM nonce（密文帧必带）
  "ct": "AAAAAAAA...",           // b64u，L2 密文（密文帧必带）
  "meta": { }                    // 路由用的最小元数据
}
```

### 2.2 帧类型

| `t` | 方向 | 用途 | 带 `ct` | `meta` 字段 |
|---|---|---|---|---|
| `hello` | ↑ | 会话建立/重建，上报身份与公钥 | 否 | `pub, caps, host, user, os, arch, pid, ip, fp` |
| `hello_ack` | ↓ | 服务端确认，下发配置 | 否 | `next, sid_ok, srv_ts` |
| `hb` | ↑ | 心跳（**固定字节串**，走自动应答） | 否 | — |
| `hb_ack` | ↓ | 心跳应答 | 否 | — |
| `cmd` | ↓ | 下发任务（密文） | **是** | `tid, cat, exp` |
| `res` | ↑ | 任务结果（密文） | **是** | `tid, rid, sz, done` |
| `io` | ↔ | 交互流（终端 stdin/stdout、键鼠） | **是** | `ch, sz` |
| `ack` | ↑ | 确认收到 `tid`（不再重发） | 否 | `tid` |
| `file` | ↓ | 文件传输指令（开始/分片/结束） | **是** | `xf, idx, tot` |
| `screen` | ↑ | 屏幕帧通知（帧本体在 R2） | 否 | `key, w, h, sz` |
| `pivot` | ↓ | 代理规则（socks5/portfwd） | **是** | `rule, action` |
| `bye` | ↔ | 主动下线/自毁确认 | 否 | `reason` |
| `err` | ↓ | 服务端错误（仅 L1 层，不含业务语义） | 否 | `code, msg` |

### 2.3 `hello` 的 `meta`

```jsonc
"meta": {
  "pub": "BAA...",            // b64u(65B) 未压缩 P-256 点（implant_eph_pub）
  "caps": ["shell","file","screen","pivot"],
  "host": "DESKTOP-7F2K",     // META_MODE=sealed 时省略
  "user": "alice",
  "os": "windows", "arch": "amd64", "pid": 4212,
  "ip": "10.1.2.33",          // 目标看到的本机地址（内网）
  "fp": "9f2c1a7b3d4e5f60"    // SHA256(pub) 前 8 字节 hex
}
```

> `META_MODE`（`plain` | `sealed`）：`sealed` 时 `host/user/os/arch/pid/ip` 全部移入 L2，控制台列表在浏览器解密前显示 `unknown`。默认 `plain`——因为多操作员协作与会话列表离不开这些字段，这一点在 [威胁模型](../02-architecture/03-crypto-design.md#1-威胁模型先说清楚防谁) 里已明示。

### 2.4 序号与去重

- 每个方向独立计数：`seq_in`（implant→server）、`seq_out`（server→implant）。
- 接收方维护 `highest_seq` 与最近 256 个已见 seq 的位图；`seq <= highest_seq - 256` 或重复 → 丢弃 + 计数。
- `seq` 参与 AAD，**改一个数字就解密失败**。

---

## 3. L2 载荷（端到端加密，服务端不可解）

### 3.1 外层

```jsonc
{
  "k": "shell.exec",        // 任务类型（见 04-task-catalog）
  "a": { ... },             // 类型相关参数
  "rid": "AAAAAAA",         // b64u(8B) 请求 ID
  "ts": 1763000000,
  "ttl": 60                 // 任务有效期（秒），过期由植入体丢弃
}
```

### 3.2 加密

```
Z    = ECDH(priv, peer_pub)                       // P-256，32B
K    = HKDF-SHA256(Z, salt = sid, info = "stc2/v1/" + domain)   // domain: cmd|io|file
AAD  = "stc2/v1" || dir(1B) || sid(16B) || seq(8B BE) || rid(8B)
N    = nonce_prefix(4B) || counter(8B BE)
ct   = AES-256-GCM(K, N, plaintext, AAD)
```

- `domain` 与帧类型绑定：`cmd/res` → `cmd`；`io` → `io`；`file` → `file`。**跨域复用密钥会失败**（info 不同）。
- `dir`：`0x00` = 操作员→植入体，`0x01` = 植入体→操作员。
- `nonce_prefix` 在 `hello`/`hello_ack` 里各给一个（随机 4B），之后计数器单调递增。

### 3.3 结果封装

```jsonc
// res 帧的 L2 明文
{
  "k": "shell.exec",
  "rid": "AAAAAAA",
  "ok": true,
  "out": "uid=0(root) gid=0(root)\n",   // ≤ 64 KB 内联；更大则 out_ref
  "out_ref": { "r2": "prod/sessions/.../results/xxx.bin", "sz": 1048576, "sha256": "..." },
  "err": null,
  "exit": 0,
  "trunc": false
}
```

> 注意：`out_ref` 里的 R2 路径**出现在密文里**，服务端并不知道"这个路径对应哪个任务"——直到它自己把 `res` 帧的 `meta.tid` 与 `task_results` 关联（这是服务端本来就有的元数据，不构成额外泄露）。

---

## 4. 完整交互示例（注册 → 心跳 → 下发 → 结果）

```
① 注册
→ POST /v1/register
  { "v":1, "psk_id":"CgXk...", "ts":1763000000, "nc":"AAA...",
    "h":"HMAC(K_reg, psk_id||ts||nc)", "pub":"BAA...", "fp":"9f2c..." }

← 200
  { "v":1, "sid":"AAAA...", "tok":"ZZZ...", "srv_ts":1763000001,
    "op_pub":"BAA...", "op_fp":"9f2c1a7b3d4e5f60", "key_id":"...",
    "next":300, "cfg":{ "hb":60, "transport":["ws","http"], "meta_mode":"plain" } }
```

```
② WS 上线
→ GET /v1/ws/beacon  (Upgrade, Authorization: Bearer ZZZ...)
← 101

→ {"v":1,"t":"hello","sid":"AAAA...","seq":1,"ts":...,
   "meta":{"pub":"BAA...","caps":["shell","file"],"host":"DESKTOP-7F2K","os":"windows"}}
← {"v":1,"t":"hello_ack","sid":"AAAA...","seq":1,"meta":{"next":300,"srv_ts":...}}
```

```
③ 心跳（固定串，走 DO 自动应答，不计 duration）
→ {"v":1,"t":"hb","sid":"AAAA...","seq":2}
← {"v":1,"t":"hb_ack","sid":"AAAA...","seq":1}
```

```
④ 下发任务（操作员浏览器加密后经 console → DO → WS）
← {"v":1,"t":"cmd","sid":"AAAA...","seq":2,"n":"AAAA...","ct":"AAAA...",
   "meta":{"tid":"TTTT...","cat":"exec","exp":1763000060}}

⑤ 结果
→ {"v":1,"t":"res","sid":"AAAA...","seq":3,"n":"BBBB...","ct":"BBBB...",
   "meta":{"tid":"TTTT...","rid":"RRRR...","sz":36,"done":true}}
→ {"v":1,"t":"ack","sid":"AAAA...","seq":4,"meta":{"tid":"TTTT..."}}
```

---

## 5. 错误处理

| 场景 | 服务端行为 | 客户端行为 |
|---|---|---|
| `seq` 重复/过旧 | 丢弃 + `X-STC2-Dup: 1` 计数 | 无需处理（幂等） |
| `ts` 漂移 > 300 s（仅注册） | 400 `E_CLOCK_SKEW` | 校正本地时间后重试 |
| 会话令牌无效 | 401 `E_AUTH` | 重新注册（若 PSK 仍有效） |
| PSK 被吊销 | 403 `E_REVOKED` | **停止**，清内存密钥，退出 |
| 帧过大 | 413 `E_TOO_LARGE` | 切分或改走文件通道 |
| DO 过载 | 429 `Retry-After` | 退避 |
| Cloudflare 1027（日额度） | 平台直接返回 | 间隔 ×3，30 min 后重试 |

---

## 6. 帧大小与合批

| 内容 | 建议 | 理由 |
|---|---|---|
| 心跳 | 固定 60 s，固定字节串 | 走自动应答，零成本 |
| 终端输出 | 累积 50–100 ms 或 4 KB 再发 | 每帧一次 DO 请求，合批直接省钱 |
| 命令结果 | 一次一个 `res` 帧 | 便于状态机 |
| 大结果 | > 64 KB 落 R2，`res` 只带引用 | D1/R2 分工 |
| 屏幕帧 | 只发 `screen` 通知（R2 引用） | 图像不进 DO |

---

## 7. 与其它通道的映射

| 通道 | 承载方式 |
|---|---|
| WSS | 一条消息 = 一个 L1 信封（JSON 文本帧） |
| HTTP | `POST /v1/beacon` 的 `up[]` / `down[]` 数组元素 |
| R2 | 一个对象 = 一个信封（`application/json`） |
| DoH | TXT 记录内容 = 信封的紧凑形式（去空白 + 分包），仅 `cmd` 且 ≤ 200 B |

**紧凑形式**（DoH 专用）：字段名压到 1 字符（`v/t/s/q/n/c/m`），并限制 `ct` ≤ 120 B（装不下就拒绝并回 `err`）。

---

## 8. 兼容性

- `v` 字段是硬版本号；服务端只处理 `v == 1`，其它返回 `400 E_VERSION`。
- 新增**帧类型**不需要升版本（未知类型按"忽略并计数"处理，不要断连）。
- 新增**字段**必须可选，缺省有默认值。
- 删除字段 = 升 `v` + 至少一个大版本的双写期。
