# 03 · 三个本地仓库架构对比（Rshell / Rshell-web / Toshell）

> 调研时间：2026-11 ｜ 对象：`C2/Rshell`（Go C2 服务端）、`C2/Rshell-web`（Vue3 控制台）、`C2/Toshell`（Go Team Server + React 控制台 + 多平台植入端）
> 用途：为 stratus-c2（**Cloudflare Workers + D1 + R2 + Durable Objects**）的新框架设计提供借鉴与反例。平台硬约束一律以 [01-cloudflare-platform-limits](01-cloudflare-platform-limits.md) 为准——本文说"能照搬"处均已按那份文档的配额与能力边界校对。
> 读法：§1–§5 是事实（带可核对路径与行号），§6–§7 是判断，§8 是合规边界。

## 0. 一页速览

| 维度 | Rshell | Rshell-web | Toshell |
|---|---|---|---|
| 栈 | Go + Gin + xorm + SQLite | Vue 3.3 + Vite 4 + Element Plus + Pinia | Go + gorilla/mux + SQLite + React 18 + Zustand |
| 规模 | 约 90 个 .go | 24 个页面 + 12 个 store | 约 400 个 .go（含 200+ 单测）+ 60 个 tsx |
| 形态 | 单二进制：服务端 + 内嵌前端（`//go:embed dist`） | 独立 SPA，产物被 Rshell 内嵌 | 三体合一：Team Server + 控制台 + 植入端模板 |
| 传输 | WS / TCP / KCP / HTTP(S) / OSS 六种监听器 | HTTP + 一条交互式 WS | WS / TCP / HTTP 轮询 / MQTT + relay + 隧道 |
| 持久化 | SQLite 单文件 16 表，无迁移框架 | 无（token 在 localStorage） | SQLite(WAL) 6 主表 + 4 Agent 表 + tunnels，手写 `IF NOT EXISTS` 迁移 |
| 许可证 | MIT（Rubby2001, 2025） | MIT（Rubby2001, 2025） | MIT（iQingshan and ToShell contributors, 2026） |
| 对我们的价值 | 外壳化投递、内存加载可看 | 交互模式（xterm/文件树/表格）可看 | **主借鉴对象**：任务状态机、能力位、SSE 续传、结果外置、审计、限流、fail-closed |

**Rshell 是"能跑起来的最小可用 C2"，Toshell 是"已经踩过一遍生产事故的 C2"。** 协议与状态机照 Toshell 的思路重写，UI 交互借 Rshell-web 的成熟度，而两者的进程模型（单进程内存态 + 本地 SQLite）一个都不能继承。

## 1. 三个仓库的定位与目录骨架

### 1.1 Rshell（Go 服务端）

```
Rshell/
├── main.go          入口：初始化 → 建库 → 载入/生成密钥对 → 起 Gin（46 行）
├── pkg/
│   ├── api/           HTTP 处理器（client/listener/socks5/plugin/webdelivery/shellcode…）
│   │   ├── communication/  HTTP(S) 通道的 GET/POST（伪装腾讯搜索接口）
│   │   └── server/   六个监听器：tcp / kcp / websocket / http / forward-tcp / forward-ws
│   ├── command/      命令类型常量 + web 轮询命令队列 + 各结果队列
│   ├── connection/   tcp / kcp / websocket / oss 四套 client manager
│   ├── database/     xorm + SQLite，16 张表结构全在一个文件
│   ├── encrypt/      X25519 + AES-CFB + Base64（无 AEAD）
│   ├── godonut/      Donut 移植：PE → 位置无关 shellcode
│   ├── interactive/  交互式 shell 会话（浏览器 WS ↔ 植入端 PTY 泵）
│   ├── middlewares/  BasicAuth（页面）+ JWT（API，读 `Authorization2` 头）
│   ├── proxy/neoreg/ Neo-reGeorg 内存马隧道
│   ├── routers/      全部路由注册（单文件 184 行）
│   ├── sendcommand/  "命令串 → 二进制帧 → 按通道加密下发"唯一出口
│   └── webhooks/     企微/钉钉/TG/邮件上线通知
└── dist/             前端产物（被 go:embed 打进二进制）
```

职责归纳：**它不是框架，是一条流水线**——监听器收帧 → 各 connection 包 goroutine 解析 → 写库/入队 → Gin 把库里的东西呈现给前端。无 repository 层、无事件总线，`api` 包直接操作 `database.Engine`。

### 1.2 Rshell-web（Vue3 前端）

```
Rshell-web/src/
├── api/           按资源分目录的接口封装（clients 单文件 443 行 ≈ 50 个方法）
├── components/    ClientSideBar / TopNavBar / TagsView / WaterMark / Common/Tables（自研表格）
├── i18n/          vue-i18n：en + zh-CN，localStorage 记忆
├── router/        单文件路由表（155 行）
├── stores/        12 个 Pinia store（user/userpermiss/tags/sidebar/fileTree/shellcommand/taskinfo…）
├── utils/request/ axios 单例 + 拦截器 + 重试 + 全局 cancelToken
├── views/         24 个页面（见 §3.2）
└── main.ts        装配、v-permiss 指令、路由守卫
```

### 1.3 Toshell（Team Server + 控制台 + 植入端）

```
Toshell/
├── cmd/            server（主程序）/ implant(windows,linux) / cli / socks5proxy / toshell-mcp
├── internal/
│   ├── common/     ★ 内层"唯一真源"：protocol / crypto / features / avops / preview /
│   │               moduleabi / tunnel / transport / types / encoding / utils
│   ├── implant/    植入端运行时：config / crypto / executor / injection(6 种) / sysinfo / transport
│   ├── operator/   CLI 侧命令实现
│   └── server/     ★ api / auth / task / session / listener / database / mcp / ai /
│                   agentstore / builder / drivers / avdetect / intel / logging / plugin /
│                   modules / shellcode / tunnelstore / mimicry / webhook
├── pkg/            只有两个通用包：goroutine（协程池）/ rate（限流）
├── web/            React 18 控制台（18 页面 + 20 组件 + 6 store）
├── docs/           11 篇设计/审计文档（EVASION、PROTOCOL-HARDENING、AGENT-RESULT-OFFLOAD 等）
└── release/        预编译 upx、植入端模板、插件目录
```

核心特征是**"能被两层共用的真相放最内层"**（`features`/`avops`/`preview` 三个包的头注释都在论证这件事）——这是它比 Rshell 成熟最直接的证据。

## 2. Rshell 服务端架构

### 2.1 入口与启动流程（`main.go:19-45`，六步，无依赖注入）

```go
database.ConnectDateBase()                             // 1) SQLite at <exeDir>/database.db，Sync2 建表
encrypt.GenerateKeyPair()                              // 2) X25519 密钥对：库里有就复用，没有就生成入库
database.Engine.Update(&database.Clients{Online: "2"}) // 3) 把所有客户端打成离线
database.Engine.Update(&database.Listener{Status: 2})  // 4) 把所有监听器打成关闭
r := routers.NewRouter(embedFS, staticFs)              // 5) 装配路由（前端 embed）
r.Run("0.0.0.0:" + port)                               // 6) 默认 8089，-p 覆盖
```

第 3、4 步是**重启一致性收口**：重启时内存态全丢，于是把库里的在线/运行标记全清，保证界面不撒谎。代价是它假设自己是唯一实例（起两个进程互踩）——Workers 上无法复制（§7.1）。

### 2.2 监听器抽象（六协议，一个 type switch）

抽象只有三样东西，全在 `pkg/api/listener.go`：`PortManager{Servers map[string]*ServerInstance}`（`:30-33`，键是监听地址字符串）、`ServerInstance{Type,Address,Server interface{},StopChan,IsRunning,Stats}`（`:36-44`，`Server` 是 `interface{}`，运行时靠 type assertion 取回 `*http.Server`/`net.Listener`/`*kcp.Listener`）、`ServerStats{Connections,Requests,Errors}`（`:47-52`，只有计数，无延迟/字节）。

| type | 承载 | 端点 | 参数 |
|---|---|---|---|
| `websocket` | `http.Server` + gorilla | `/ws` | 读写超时 15s，MaxHeaderBytes 1MiB |
| `tcp` | `net.Listener` | 裸 TCP | KeepAlive 30s，`SetLinger(0)` |
| `kcp` | `kcp.Listener` | 裸 KCP | 窗口 1024/1024，`SetNoDelay(1,10,2,1)`，缓冲 4MiB，`ListenWithOptions(addr,nil,10,3)`（**不加密**，AES blockcrypt 被注释，`:428`） |
| `http` | `http.Server` | `/tencent/mcp/pc/pcsearch`(GET)、`/tencent/sensearch/collection/item/check`(POST) | 伪装腾讯搜索接口 |
| `https` | `http.Server` + tls | 同上 | 自签 RSA-2048，CN=`Rshell C2`，1 年（`:549-596`） |
| `oss` | 无 socket | 对象存储轮询 | 地址格式 `endpoint:AK:SK:bucket`（`:662-666`） |

评价：**有类型开关，没有接口抽象**。`startListener` 是 6 分支 switch（`:242-261`），`stopListener` 又一个 6 分支 switch + 各自 type assertion（`:278-297`）；新增协议要改 4 处（`isValidListenerType`、start、stop、`StopAllServers`）。这正是 Toshell 用 `TaskPusher`/`ShellController` 接口 + `listenerRouter` 修正的问题（§4.3）。

### 2.3 客户端 / 会话模型

四套**互不相通**的 client manager：WS（`connection/websocket/websocket.go:50-59`）、HTTP（`api/communication/get.go:40-49`）、TCP（`connection/tcp/tcp.go`）、KCP/OSS。串起来的是两个**包级全局 map**（`connection/connection.go:10-16`）：

```go
var MuClientListenerType sync.Mutex
var ClientListenerType = make(map[string]string)  // uid → websocket|tcp|kcp|web|oss
var HttpServer  = make(map[string]*http.Server)   // 与 PortManager 重复
var TCPServer / KCPServer / StopChan = ...
```

**会话身份**：`uid = MD5(metainfo)`，`metainfo` 前 32 字节是植入端 X25519 公钥（`websocket.go:386`、`get.go:443`）——**uid 由客户端自报公钥决定，服务端不复核**，任何人发 32 字节随机数就"注册"成新会话（§7.5）。首包 firstBlood 字段级结构（`websocket.go:379-400`、`get.go:439-461`）：

| 偏移 | 长度 | 字段 | 解析 |
|---|---|---|---|
| 0 | 32 | 植入端 X25519 公钥 | 原样存库，作后续加密对端公钥 |
| 32 | 4 | PID | BigEndian uint32 |
| 36 | 1 | flag | `>8` 用户名带 `*`（管理员），`>4` 表示 x64 |
| 37 | 4 | 本机 IP | **LittleEndian** uint32（与其它字段相反） |
| 41 | 余下 | OS 信息 | `hostname\tusername\tprocessname` |

`flag` 用一字节同时编码"架构 + 是否管理员"，且用 `>8`/`>4` 比较而非按位与——枚举复用字节的经典陷阱，不应复制。

### 2.4 任务模型（下发 / 回传 / 结果）

**下发**是"命令字符串 → 4 字节类型 + 裸参数"的巨型 if-else（`pkg/sendcommand/sendCommand.go:22-185`）：

```go
binary.BigEndian.PutUint32(cmdTypeBytes, uint32(command1.SHELL))  // sendCommand.go:29-33
byteToSend = append(cmdTypeBytes, []byte(cmd)...)
```

支持字面量：`shell` `cd` `sleep` `pause` `pwd` `exit` `kill` `mkdir` `drives` `rm` `cp` `mv` `execute` `ps` `filebrowse` `download` `filecontent` `socks5data` `screenshot` `clear` `getsystem` `mimikatz` `list_processes` `inject`。前端把整行原样 POST，服务端做字符串前缀匹配——**无结构化参数、无 schema 校验，`inject` 的 shellcode 靠 base64 塞在同一字符串里**。类型常量（`pkg/command/cmdType.go:3-40`，均 4 字节大端）：

| 值 | 名称 | 值 | 名称 | 值 | 名称 |
|---|---|---|---|---|---|
| 10 | FileBrowse | 26 | DOWNLOAD | 45 | DUMP_DATA |
| 11 | EXECUTE | 27 | EXIT | 46 | ExecuteLinuxBin |
| 12 | PS | 28 | CD | 47 | SearchSensitive |
| 13 | KILL | 29 | PWD | 48 | DumpBrowser |
| 14 | DRIVES | 40 | ExecuteAssembly | 50 | Socks5Data |
| 15 | MKDIR | 41 | InlineBin | 60 | InteractiveShell |
| 16 | RM | 42 | InlineExecute | 61 | WriteInteractieShell |
| 17 | CP | 43 | ExecuteLinuxScript | 62 | StopInteractiveShell |
| 18 | MV | 44 | SCREENSHOT | 80 | GETSYSTEM |
| 19 | FileContent | 21 | SLEEP | 81 | MIMIKATZ |
| 24 | UploadStart | 22 | PAUSE | 82 | PROCESS_INJECT |
| 25 | UploadLoop | 23 | SHELL | 83 | LIST_PROCESSES |

**下发通道分派**（`sendCommand.go:186-231`）：同一字节串按 `ClientListenerType[uid]` 走五条路——`web`→塞内存队列等植入端下次 GET；`websocket`→加密两遍→Base64→发；`tcp`/`kcp`→加密两遍→Base64→前置 4B 长度→写 socket；`oss`→加密两遍→以 `uid/server_%020d时间戳` 为对象名写桶。

**回传**是按 `replyType` 分派的巨大 switch（`websocket.go:577-814`，`tcp.go`/`post.go` 各有一份近似副本）：`0` 命令输出累加进 `shells.shell_content`（单条超 10000 字节截断并加 `[Data truncated...]`）；`31` 错误输出加 `!Error: ` 前缀；`22` 下载首包（总长+路径）建空文件并写 `downloads`；`26` 下载数据包（路径长+路径+数据）追加写并累加 `downloaded_size`；`PS`/`FileBrowse`/`DRIVES`/`FileContent`/`Socks5Data` 写进各自队列由 HTTP 处理器阻塞等待。

**"请求-响应"怎么凑**：Rshell 没有 task id，HTTP 处理器发完命令就阻塞在自己 channel 上等：

```go
// pkg/api/clients.go:95-119
queue := command.VarPidQueue.GetOrCreateQueue(uid)
sendcommand.SendCommand(uid, "ps")
ctx, cancel := context.WithTimeout(context.Background(), 300*time.Second)
select {
case pids := <-queue: ...   // 拿到就返回
case <-ctx.Done():          // 超时 408
}
```

后果：一个浏览器请求挂住最长 300 秒；同 uid 第二个请求会拿到同一队列（`GetOrCreateQueue` 按 uid 复用）；重启则全部在途请求丢失，且**任务本身无任何持久化记录**（没有 `tasks` 表）。

### 2.5 插件机制

`pkg/api/plugin.go` + `database.Plugin`：multipart 上传 → 落 `<exeDir>/Extensions/<filename>` → 库里记 name/os/type/path/upload_time。`ExecutePlugin`（`:110-206`）按 `os × type` 出 6 条路径：

| os | type | 服务端动作 | 任务类型 |
|---|---|---|---|
| windows | `execute-assembly` | 4B 长度 + 字节 + args | `40 ExecuteAssembly` |
| windows | `inline-bin` | 先 `godonut.GenShellcode(pe,args,arch)` | `41 InlineBin` |
| windows | `shellcode-inject` | 声称是 shellcode，**实际仍打 `41 InlineBin`** | `41 InlineBin` |
| windows | `inline-execute` | 4B 长度 + 字节 + args | `42 InlineExecute` |
| linux | `script` | 4B 长度 + 脚本 + args | `43 ExecuteLinuxScript` |
| linux | `binary` | 4B 长度 + ELF + args | `46 ExecuteLinuxBin` |

前两者共用同一类型（`plugin.go:151-168`），植入端无法区分"Donut 生成的"与"原始 shellcode 位"——**类型枚举在此已语义漂移**，新框架必须一类型一语义。

### 2.6 加密与密钥管理

| 用途 | 算法 | 位置 | 问题 |
|---|---|---|---|
| 协商 | X25519 | `encrypt.go:236-245` | 无 HKDF，直接拿 32B 共享密钥当 AES key |
| 对称 | **AES-256-CFB** | `:31-48` | 流模式无 MAC/AEAD，密文可翻转比特；IV 前置、无序号无重放保护 |
| 编码 | hex → 加密 → Base64 | `:70-76` | 膨胀约 2.7× |
| 元数据 | `EncryptNormal`：**随机 key 前置在密文头** | `:70-87` | 密钥与密文同包 = 混淆，不是加密 |

命令下发做**两次**加密（`sendCommand.go:190-192`）：同 key 连 Encrypt 两次——不增强度（安全界由 key 决定），只增 CPU 与故障点，是"看起来更安全"的典型反例。密钥对存**业务库**（`database.Key`，`sqlite3.go:88-91`），启动读进包级变量 `encrypt.Key`（`:195-233`）；每端公钥缓存在**无锁包级 map** `encrypt.PublicKeyMap`（`:19`），被多 goroutine 并发读写（`websocket.go:450`、`get.go:390`）——数据竞争是确定的。

### 2.7 配置与持久化

- **配置几乎为零**：除 `-p` 端口外全是编译期常量——`pkg/config/config.go:4-16` 硬编码伪装用 `BDUSS=...` Cookie 前缀、`Http_get_output_prepend` 之类响应包装串、企微 Webhook URL。
- **数据库**：SQLite 单文件，路径 `filepath.Join(filepath.Dir(os.Executable()),"database.db")`（`sqlite3.go:166-175`）；xorm `Sync2` 一次建 16 张表（`:181`），**无版本号、无迁移脚本**（字段只能加不能改）。
- **表清单**（`:20-141`）：`Users`（**明文密码**）、`Clients`、`Notes`、`Shell`（一 uid 一行 TEXT）、`Socks5`、`Downloads`、`Listener`、`WebDelivery`、`Settings`(KV)、`Key`、`Plugin`、`Screenshots`、`Credentials`、`CredentialDumps`、`SensitiveResults`、`DumpBrowserResults`。
- **首次启动**：`admin` 不存在则生成 20 位随机密码并**打进日志**（`:190-215`）——比 `admin/admin` 好，但密码进日志仍是缺陷。

## 3. Rshell-web 前端架构

### 3.1 技术栈（`package.json` 实际版本）

| 类别 | 依赖与版本 |
|---|---|
| 框架 / 语言 | vue ^3.3.4，typescript ~5.1.6（`vue-tsc` 检查） |
| 构建 | vite **4.4.9**（固定）+ `@vitejs/plugin-vue` ^4.3.1 + `unplugin-auto-import`/`unplugin-vue-components` |
| UI / 表格 | element-plus ^2.3.12 + icons ^2.1.0；vxe-table ^4.5.12 + `vxe-table-plugin-element` ^3.1.0 |
| 状态 / 路由 | pinia ^2.1.6 + `pinia-plugin-persistedstate` ^3.2.0；vue-router ^4.2.4（history） |
| 请求 | axios ^1.5.0 + axios-retry ^4.0.0 |
| 终端 | xterm ^5.3.0 + `@xterm/addon-fit` ^0.11.0 + `@xterm/addon-web-links` ^0.12.0 |
| 图表 / i18n / 其它 | echarts ^5.4.3、vue-schart ^2.0.0；vue-i18n ^9.14.4；ansi-to-html ^0.7.2、js-base64 ^3.7.7、uuid ^13.0.0、vue-clipboard3 ^2.0.0 |

### 3.2 路由表与页面清单（`src/router/index.ts:4-153`）

| path | name | permiss | 组件 | 用途 |
|---|---|---|---|---|
| `/` | — | — | redirect → `/login` | — |
| `/home` | Home | 1 | `views/home/index.vue` | 仪表盘（在线数、OS/地区统计） |
| `/Clients` | Clients | 2 | `views/clients/ClientsView.vue` | 客户端列表（2s 轮询） |
| `/Listeners` | Listeners | 2 | `views/listener/listener.vue` | 监听器增删启停 |
| `/Server` | Server | 5 | `views/server/ServerGen.vue` | 生成植入端（OS/架构/监听器/密码 → 二进制） |
| `/WebDelivery` | WebDelivery | 5 | `views/server/WebDelivery.vue` | 外壳化投递（见 §2.2 `webdelivery`） |
| `/Settings` | Settings | 5 | `views/settings/Settings.vue` | Webhook 与全局设置 |
| `/Plugins` | Plugins | 5 | `views/plugin/PluginView.vue` | 插件上传/执行 |
| `/client` | 客户端详情 | 2 | `views/client/ClientView.vue` | 详情外壳（顶栏 + router-view + keep-alive） |
| `/client/shell` | Shell | — | `views/client/View/ClientShell.vue` | xterm 交互 shell（WS）+ 普通命令 |
| `/client/socks5` | Socks5 | — | `views/client/View/ClientSocks5.vue` | 在客户端上开 socks5 |
| `/client/files` | Files | — | `views/client/View/ClientFiles.vue` | 文件树/上传/下载/删除/编辑 |
| `/client/pid` | PID | — | `views/client/View/ClientPid.vue` | 进程列表与终止 |
| `/client/downloads` | Downloads | — | `views/client/View/ClientDownloads.vue` | 下载进度（2s 轮询） |
| `/client/notes` | Notes | — | `views/client/View/ClientNotes.vue` | 主机备注 |
| `/client/screenshots` | Screenshots | — | `views/client/View/ClientScreenshots.vue` | 截图列表与查看 |
| `/client/credentials` | Credentials | — | `views/client/View/ClientCredentials.vue` | 凭据库 |
| `/client/sensitive-search` | SensitiveSearch | — | `views/client/View/ClientSensitiveSearch.vue` | 敏感文件检索结果 |
| `/client/browser-dump` | BrowserDump | — | `views/client/View/ClientBrowserDump.vue` | 浏览器数据导出（定时刷新） |
| `/login` | 登陆 | — | `views/login/LoginView.vue` | 登录（写 token + 角色键） |
| `/user/resetpassword` | 重置密码 | 1 | `views/user/ResetPassword.vue` | 改密 |
| `/404` `/401` | — | — | `views/error/404View.vue`、`401View.vue` | 错误页 |

`src/views` 共 24 个 `.vue`：**`views/credentials/CredentialsView.vue` 有文件但没挂路由**（凭据只能从"客户端详情 → 凭据"进），`views/HomeView.vue` 只作 `/` 的父容器，`views/server/` 同时放生成与投递两页。

**权限**：`meta.permiss` 取 `1/2/4/5`，在 `main.ts:41-56` 的 `beforeEach` 与 `usePermissStore().key` 比对，不在白名单跳 `/401`；另有 `v-permiss` 指令（`main.ts:33-39`）用 `el.hidden = true` 隐藏。注意这是**纯前端**模型——后端 `routers.go` 只校验 JWT 有效性、不校验角色（`Users` 连权限字段都被注释，`sqlite3.go:20-26`）。

### 3.3 API 层封装

三层：`utils/request/index.ts`（单例 axios）→ `api/<resource>/index.ts`（对象字面量）→ 页面里 `clientsApi.get_clients_list({...})`。

```ts
// utils/request/index.ts:13-18
let service = axios.create({ baseURL: '/api', timeout: 10 * 60 * 1000, withCredentials: true });
// :22-27 只对超时/网络错误重试 3 次、间隔 1s
axiosRetry(service, { retries: 3, retryDelay: () => 1000, shouldResetTimeout: true,
                      retryCondition: (e) => ['ECONNABORTED','ERR_NETWORK'].includes(e.code!) });
// :30-42 每个请求注入 JWT —— 头名是 Authorization2，不是 Authorization
config.headers.Authorization2 = 'Bearer ' + userStore.getToken();
config.cancelToken = new CancelToken(c => { cancel = c; });   // 模块级单例
```

响应拦截（`:45-103`）把 `code===401/402`、`status===401/404/500/429` 映射成四类提示并**硬跳转 `window.location.href='/login'`**（丢 SPA 状态）。API 定义集中在 `api/clients/index.ts`（443 行、约 50 方法），把 `/client/*`、`/socks5/*`、`/webdelivery/*`、`/shellcode/*`、`/sensitive/*`、`/dumpbrowser/*` 全堆进一个对象——**一个文件一个上帝 API**。

### 3.4 WebSocket 用法（唯一一处：交互式 shell）

两段式鉴权：`GET /api/ws/auth/:uid`（带 `Authorization2`）拿 5 分钟专用 token（`purpose="websocket"`），再连 `ws(s)://host/api/ws/interactive/:uid/:sessionId?auth=<token>`。`ClientShell.vue` 细节：`:1388-1543` 连接逻辑；`:1354-1376` 每 15s 发 `{type:'heartbeat'}`、45s 无消息即 `close()` 触发重连；收到 `{type:'auth_response',success:true}` 才认为连上，随后发 `{type:'init',uid,sessionId,cols,rows}`；消息只有 `output`/`error`/`session_info`/`heartbeat_response` 四种；`onclose`/`onerror`/10s 连接超时三处都调 `scheduleReconnect()`。**同时**保留 `setInterval(GetShellContent,5000)`（`:1620`）轮询同一块 shell 内容——两套通道并发更新同一终端。服务端（`pkg/api/interactiveshell.go:46-215`）要求 token 内 `uid` 等于 URL 的 `uid`（`:133-137`）、`purpose` 必须为 `websocket`（`:140-144`），这是 Rshell 里最像现代设计的一块。

### 3.5 状态管理

12 个 Pinia store：`user`（localStorage 存 `token/roles/username/permiss/refresh`）、`userpermiss`（当前角色允许的 permiss 键 + `defaultList{admin,user}`）、`tags`（页签，`nameList` 供 `keep-alive :include`）、`fileTree`/`currentFileNode`（文件浏览器树 + 当前节点）、`shellcommand`（**per-uid 命令历史** `Record<uid,string[]>` + 游标，实现上下键）、`taskinfo`（sessionStorage，只有一个 `task_ids` 字符串——历史残留：`clear()` 还 `router.push('/Tasks')` 但该路由不存在）、`sidebar`/`theme`/`counter`。可复用的是 `shellcommand` 的 per-uid 历史与 `tags` + `keep-alive` 的页签缓存组合。

### 3.6 i18n

`src/i18n/index.ts:1-31`：`createI18n({legacy:false, locale:getInitialLocale(), fallbackLocale:'en'})`；语言判断优先级 `localStorage['rshell-lang']` → `navigator.language` 前缀 `zh`（是则 `zh-CN`，否则 `en`）；`locales/en.ts` 已超 880 行。路由 `meta.title` 存 i18n key（如 `nav.clients`），守卫里 `i18n.global.t()` 翻译后写 `document.title`。

### 3.7 可复用的交互模式

| 模式 | 要点 | 位置 |
|---|---|---|
| 终端 | xterm + FitAddon，ResizeObserver → `ws.send({type:'resize'})`；ansi-to-html 兜非终端输出 | `ClientShell.vue` |
| 文件管理 | 左树（el-tree + store）+ 右表格 + 面包屑 | `ClientFiles.vue` |
| 表格 | `components/Common/Tables/`（TablesView + TableColumn + Config/Search + `useTableContext`）自研封装，大数据量页用 vxe-table | 组件目录 |
| 表单 / 上传 | el-form + rules；上传用 FormData（`api/clients/index.ts:75-92`） | 各页面 |
| 下载 | `responseType:'blob'` + `URL.createObjectURL` | `api/clients/index.ts:117-125` |
| 水印 / 页签 | `v-watermark` 指令；TagsView + keep-alive | 全局 |

## 4. Toshell 架构

### 4.1 cmd / internal / pkg 分层

| 层 | 目录 | 说明 |
|---|---|---|
| 入口 | `cmd/server` | 读配置 → 建库 → 任务 id 校准 → 会话自适应阈值 → 指纹库 → 默认监听器 → Agent 存储接线 → 重启恢复 → 隧道恢复 → 内嵌 SPA → 起 HTTP |
| 入口 | `cmd/implant/{windows,linux}` | 植入端构建入口（真实源码在 `internal/server/builder/implant/`） |
| 入口 | `cmd/cli`、`cmd/socks5proxy`、`cmd/toshell-mcp` | CLI、独立 socks5、MCP 客户端示例 |
| 可复用库 | `pkg/goroutine`、`pkg/rate` | 协程池、限流器（只有两个，非常克制） |
| 业务 | `internal/common` | **内层唯一真源**：server 与 implant 共用的纯逻辑 |
| 业务 | `internal/server`、`internal/implant`、`internal/operator` | 服务端 / 植入端 / CLI 命令 |

### 4.2 `internal/` 与 `pkg/` 一级（含关键二级）子目录职责

| 目录 | 职责 | 关键点 |
|---|---|---|
| `common/protocol` | 帧定义、包头、任务类型常量 | `Packet` 30 字节固定头 |
| `common/crypto` | AES-256-GCM / ChaCha20-Poly1305 + X25519 + HKDF；另有 SM4 | `NewAESEncryptor`、`DeriveSharedSecret` |
| `common/features` | **能力位唯一真源** | 33 位位图 + `cap:v1:` 令牌 |
| `common/avops` | 杀软对抗分级 L0–L4 | Tier / Action / Policy |
| `common/preview` | 文件预览白名单与体积上限 | 前后端共用一份判定 |
| `common/moduleabi` | 内存模块 ABI（头 + 裸字节） | 与任务解耦的下行帧 |
| `common/tunnel` | 隧道协议/复用/SOCKS5/QUIC/安全 | `protocol/constants.go` 16B 头 |
| `common/transport` | WS 服务端/客户端、升级策略 | `UpgradePolicy{Path,HostAllowlist}` |
| `common/{encoding,utils,types}` | 编码、工具、跨层 DTO | `TaskInfo` / `SessionInfo` |
| `implant/{config,transport}` | 植入端配置与 HTTP/DNS/WS/TCP 传输 | `interval + jitter` |
| `implant/{executor,injection}` | 任务执行；6 种注入（APC/EarlyBird/hollowing/remote thread/thread hijack/DLL） | 按 OS 分文件 |
| `server/api` | 路由 + 60 余个处理器 | `api.go:494-681` |
| `server/auth` | JWT / API Key / 密码 / 访问门 | HS256 + bcrypt |
| `server/task` | 任务状态机、批量下发、补发、断点、等待者 | §6.3–6.7 |
| `server/session` | 会话表、判活自适应、忙期、shell/隧道句柄 | §6.16 |
| `server/listener` | TCP/WS/HTTP 轮询/MQTT + 共享处理核心 + 中继 | `handler_core.go` |
| `server/database` | SQLite + 手写迁移 | `agent_schema.go`、`tunnel_schema.go` |
| `server/mcp` | 对外 MCP（JSON-RPC 2.0 over HTTP） | 注册表/信封/限流/审计/结果外置 |
| `server/ai` | 内置 Agent：run/step/tool_call、事件环、长任务、playbook | SSE 数据源 |
| `server/agentstore` | Agent 四张表持久化 | 与 database 分开以便单测 |
| `server/builder` | 载荷构建：模板挑选、能力位烘焙、加壳、签名、PE 资源 | 200+ 文件 |
| `server/drivers` | BYOVD 驱动档案、签名校验、ledger | 只服务 L3 |
| `server/{avdetect,intel}` | 杀软指纹匹配、情报抽取 | 结果加工在服务端 |
| `server/{logging,webhook,mimicry,plugin,modules,shellcode,tunnelstore}` | 日志、通知、拟态、插件、模块、shellcode、隧道持久化 | — |

### 4.3 HTTP + WS 双通道（实为四通道）

Toshell 把"通道"做成接口而不是 switch：

```go
// api/router.go:21-32
type listenerRouter struct {
    sessMgr   *session.Manager
    runtimes  map[string]*runtimeListener  // listenerID → 实例
    defaultP  TaskPusher                   // 配置文件启动的默认监听器
    defaultSC ShellController
}
```

会话注册时把 `ListenerID` 写进 `SessionInfo`（`handler_core.go:35-56`）；所有推送（任务/文件/shell/隧道/模块）先 `resolve(sessionID)` 找到所属实例再转发（`router.go:132-147`），未命中回退默认；`ChannelHealth()` 按 `tcp/http/websocket/mqtt` 统计运行实例数（`:93-116`）。四通道共用一套注册/心跳/结果处理（`handler_core.go` 的 `buildSessionInfo`/`upsertSession`/`touchSession`/`unmarshalRegister`/`replaySessionTasks`），只在"连接绑定/ACK 格式/下行方式"分叉：

| 通道 | 下行 | 特点 |
|---|---|---|
| TCP | 直接写 socket | 16MiB 帧上限（`tcp_listener.go:331`），最低延迟 |
| WebSocket | `transport.Server` 推送 | `UpgradePolicy`（路径 + Host 白名单），握手被拒结构化记日志 |
| HTTP 轮询 | **`downQueue map[sessionID][][]byte`**，心跳时批量取走（`http_polling.go:52-56`） | 无主动推送；请求体上限 64KiB（小）/16MiB（块），超限 **413** |
| MQTT | 经 broker topic | 可内嵌 broker |

HTTP 轮询另带**会话令牌**：注册响应（AES-GCM 加密）下发 32 字节随机 hex，之后 `GET /task` 必须携带，缺/错一律 403 且**绝不调用 GetNext**（`http_polling.go:58-71`）。注释解释了原因：`session_id` 会出现在控制台/截图/日志中，没令牌时任何知道它的人都能把任务"抢走"（GetNext 会置为 sent）。

### 4.4 任务类型枚举（能读到的全部常量）

`protocol/packet.go:44-63` 与 `server/task/task.go:63-116` 各一份，当前一致：

| 常量 | 值 | 含义 |
|---|---|---|
| `TaskTypeCommand` | `command` | 执行命令 |
| `TaskTypeFileList` | `file_list` | 列目录 |
| `TaskTypeFileDown` | `file_download` | 下载文件 |
| `TaskTypeFileUp` | `file_upload` | 上传文件 |
| `TaskTypeFileDel` | `file_delete` | 删除文件 |
| `TaskTypeProcList` | `process_list` | 进程列表 |
| `TaskTypeProcKill` | `process_kill` | 杀进程 |
| `TaskTypeProcInject` | `process_inject` | 进程注入（method/pid/shellcode/dll_path） |
| `TaskTypeProcSpoof` | `process_spoof` | 进程镂空/伪装父进程 |
| `TaskTypeAutoInject` | `auto_inject` | 自动选注入方式 |
| `TaskTypeSpawn` | `spawn` | 派生子会话 |
| `TaskTypeBOFLoad` | `bof_load` | 加载 BOF |
| `TaskTypeShell` | `shell` | 交互式 shell（PTY） |
| `TaskTypeInjection` | `injection` | 注入面板统一入口 |
| `TaskTypeExit` | `exit` | 退出植入端 |
| `TaskTypeFilelessExec` | `fileless_exec` | 全内存执行（shellcode/bof/dll/exe_mem） |
| `TaskTypeScreenStream` | `screen_stream` | 实时屏幕流（start/stop） |
| `TaskTypeScreenshot` | `screenshot` | 截图（monitor/max_width/format/quality） |
| `TaskTypeRelay` | `relay` | 运行时中继（start/stop + addr） |
| `TaskTypeEDRBlind` | `edr_blind` | ntdll 脱钩 + ETW patch + Autologger 清理 |
| `TaskTypeEDRKill` | `edr_kill` | 按进程名杀安全软件 |
| `TaskTypeBYOVDLoad` | `byovd_load` | 加载自带驱动 |
| `TaskTypeBYOVDUnload` | `byovd_unload` | 卸载驱动 |
| `TaskTypeBYOVDKill` | `byovd_kill` | 用驱动 IOCTL 强杀 |
| `TaskTypePPLKill` | `ppl_kill` | 杀 PPL 进程 |
| `TaskTypeUACBypass` | `uac_bypass` | UAC 提权（fodhelper + 回连） |
| `TaskTypeExecModule` | `exec_module` | 按需加载内存模块（只带 token） |
| `TaskTypeAVDetect` | `av_detect` | 杀软探测（结果在服务端匹配指纹库） |

另有**帧类型**与**帧级标记**两套，见 §5.2。

### 4.5 能力位（capabilities）—— 最值得抄的一块

`common/features/features.go` 头注释把动机讲透了：**能力是编译期事实**（`-tags light/bof/evasionscan` 决定哪些 `.go` 参与编译），旧实现只按 `strings.Contains(info.OS,"windows")` 推导，于是 light 档载荷照样点亮注入/截图/凭据/EDR 按钮，"操作员点了没反应，会误判成自己环境的问题"。三件套：

1. **位序表**（`:94-129`）：33 个能力占 `uint64` 的 0…32 位，注释明确"**只允许在尾部追加**"——已交付载荷的位图按位序烘焙进二进制，重排会让老载荷解出**错误**能力（比少一个按钮严重得多）。
2. **推导**（`Derive`，`:224-296`）：按"真实实现文件是否参与编译"逐条判断；三条 fail-closed 口径（有真实实现才点亮 / 带 `!light` 则 light 档不点亮 / 只有 stub 绝不点亮）；未知 OS 只点亮跨平台基础能力，不猜平台。
3. **令牌**（`:343-411`）：构建期把位图编成 `cap:v1:0000000000200001` 注入模板源码，运行时随心跳 `Modules` 上报；`ParseToken` 只认**精确前缀 + 16 位 hex**。

展示层唯一入口 `Resolve`（`:454-466`）：合法非全 0 令牌 → 用位图（`source=reported`）；上报了已知能力名 → 用名字；都没有 → `OSFallback`（`:473-520`，**冻结的老口径**），并附 `SourceNote`（`:523-524`）声明"这是兜底推导、未必等于真实能力"。**面板映射** `tabFeatures`（`:139-157`）：13 个 tab 各声明"哪些能力能点亮我"，任一命中即可用；`Tabs()` 只返回 `true` 的键，前端按 `capTabs[key]===true` 渲染。**档案归一化** `NormalizeProfile`（`:174-184`）：`full`/`light` 两档，**未知档案 fail-closed 归 light**——因为 `buildTagList` 只认字面量 `light`，放行 `profile=nano` 会编译出 full 却按最小集算能力，两侧必须一致。

### 4.6 休眠掩码 / 内存执行等模块位置

| 能力 | 文件 | 说明 |
|---|---|---|
| 休眠掩码 | `builder/implant/sleepmask_windows.go` | 休眠期 XOR 加密**自己的堆缓冲**（SM4 子密钥、结果缓存），休眠走 `ntdll!NtDelayExecution` + 分片 + 随机抖动；注释如实写明"不能加密代码段/整镜像（Go GC 会崩）"、"不能原地加密 string" |
| 内存保护 | `memprotect_{windows,unix}.go`、`mexecguard_windows.go` | 执行期权限收放 |
| 按需模块加载 | `xload_windows.go` + `moduleabi/` | 反射加载底座 `blob_windows.go` 在 light 档也保留 |
| 无文件执行 | `imgexec_windows.go`、`blob_unix.go` | `runMappedImage` / `loadDLLMem` |
| 直接系统调用 | `directsyscall_windows_amd64{,_shared}.go` | amd64 专用 |
| 反沙箱计时门 | `gate_scan_windows.go` / `gate_scan_off_windows.go` | `-tags evasionscan` 才进载荷，**不产生能力位**（"隐蔽行为不是操作员可见功能"） |
| 注入/混淆/加壳/签名 | `internal/implant/injection/*`、`implant_obfuscate.go`、`harden.go`、`sign.go`、`pe_sections.go` | UPX 在 `release/upx/` 内附带 |

### 4.7 MCP / AI 工具面

`internal/server/mcp/` 是**独立的 JSON-RPC 2.0 over HTTP 服务端**（默认只绑 `127.0.0.1:18082`，`server.go:63-64`），刻意不 import `api/ai/config`（避免循环依赖，`:31-34`）：

| 块 | 文件 | 设计 |
|---|---|---|
| 协议 | `server.go` | `initialize`/`ping`/`tools/list`/`tools/call`/`resources/list`/`resources/read`；会话头 `Mcp-Session-Id`；状态码 401/403/429/400/200（业务错误进 JSON-RPC + envelope 双写） |
| 工具注册表 | `registry.go`、`registry_tools.go` | 20+ 工具：`session_list`、`session_context`、`attack_suggest`、`intel_query`、`session_kill`、`exec`、`run_command`、`task_submit`、`task_result`、`task_wait`、`user_info`、`system_info`、`service_list`、`check_av`、`net_info`、`net_connections`、`env_vars`、`scheduled_tasks`、`file_list`、`file_download`、`process_list`、`process_kill`、`screenshot`、`fileless_exec`、`credentials`、`tunnel_start/list/stop`、`remote_download`… 均带 `InputSchema` 与风险等级 |
| 结果信封 | `envelope.go` | 统一 `data.envelope.{ok,error.code}`，稳定错误码供客户端分支 |
| 结果外置 | `resultstore.go` | 超限结果落 `<dir>/<YYYYMMDD>/<16hex>.bin`，上下文只放摘要+句柄；`Get(handle,offset,limit)` 分页、单次 ≤256KiB；句柄白名单 `^\d{8}/[0-9a-f]{16,64}$` 拒绝路径穿越 |
| 限流 | `ratelimit.go` | 三道独立 fail-closed 闸：滑动窗口 60 RPM、同 token 并发 4、未读外置句柄 32（磁盘水位闸）；超限 429 + 点名闸门 |
| 审计 | `audit.go` | 一行 JSONL，14 个固定字段；**不落参数原文**（敏感键值不参与摘要，命中即 `<redacted>`）；可镜像进 DB（`AuditSink`） |
| 内联模型 | `inline_model.go` | 无外部 LLM 时的降级路径 |

AI 侧（`internal/server/ai/`）是另一套：`agent.go`（run 状态机）、`agent_event_ring.go`（环形缓冲 + seq）、`toolargs.go`、`consent.go`、`longtask.go`、`playbook.go`、`copilot.go`；对外流式出口就是 §6.9 的 SSE。

### 4.8 数据库表

| 表 | 关键列 | 索引 |
|---|---|---|
| `sessions` | `id`(PK,TEXT) `hostname` `username` `os` `arch` `pid` `ip_addresses` `mac_addresses` `domain` `process_name` `first_seen` `last_seen` `status` `listener` `remote_addr` `cpu_usage` `memory_used` `active_modules` `comment` | `status` |
| `tasks` | `id`(PK,自增) `session_id` `command` `args` `execute_type` `status` `created_at` `sent_at` `completed_at` `output` `error` `exit_code` `timeout`（FK → sessions） | `session_id`、`status` |
| `listeners` | `id`(PK) `name` `type` `protocol` `bind_addr` `bind_port` `public_addr` `status` `connections` `options`(JSON) | — |
| `logs` | `id` `timestamp` `level` `component` `message` `session_id` `task_id` `source_ip` `user` | `timestamp` |
| `custom_templates` | `id` `name` `category` `tasks_json` | — |
| `implants` | `id` `format` `os` `arch` `protocol` `server_url` `size` `sha256` `filename` `options_json` | `created_at` |

Agent 四张表（`agent_schema.go`）：`agent_runs`（`status`/`session_id`/`trace_id` 三索引）、`agent_steps`（`run_id+step_no`）、`agent_tool_calls`（`run_id+step_no`、`internal_task_id`、**`run_id+args_hash`**——"同参数调用去重"的落点）、`tool_results`（`run_id`、`ttl_expires_at`）。隧道表（`tunnel_schema.go`）：`tunnels`（`status`/`session_id` 索引），让 SOCKS5 代理在服务端重启后按库自动恢复。迁移策略：全部 `CREATE TABLE/INDEX IF NOT EXISTS` + `migrateAddColumn` 做加法，**对既有库幂等、不做破坏性 DDL**（`database.go:162-168`）。

### 4.9 鉴权与 token 设计

| 机制 | 位置 | 细节 |
|---|---|---|
| 管理面 JWT | `auth/auth.go:39-79` | HS256，`Claims{username,role,iss:"toshell",exp}` |
| API Key | `:126-138` | `X-API-Key` 逐个 `subtle.ConstantTimeCompare` |
| 密码 | `:82-114` | bcrypt（`$2a$`）；老库明文时降级常量时间比较，便于迁移 |
| 中间件 | `:165-223` | 顺序：`X-API-Key` → `Authorization: Bearer` → **`?token=` 仅白名单** → 放行 `/login`、`/health` |
| query token 白名单 | `:149-163` | 只有 `/api/v1/ws/events` 与 `/api/v1/sessions/{id}/shell`（浏览器 WS/EventSource 不能自定义头）；其它路径带 query token **一律 401 并在文案里点名正确用法** |
| 植入端鉴权 | `listener/http_polling.go:58-71` | 注册下发 32 字节随机 hex 会话令牌，`GET /task` 必须携带，缺失/不匹配 403 |
| 访问门 | `auth/webgate.go` + `api.go:675` | `__gate` 入口 + `webGate` 包装（隐藏管理面入口） |

### 4.10 审计日志

三层分工：① **操作日志** `logs` 表（`component/session_id/task_id/source_ip/user` 六维齐全）；② **MCP 审计** JSONL（`O_APPEND`+0600，**刻意不复用 `logging`**——因为 `logging` 用 `fmt.Sprintf` 拼 `message` 不转义，塞 JSON 会产出非法 JSON）；③ **时间线** `tasks.created_at/sent_at/completed_at` + `agent_steps` 构成可回放链路。"不可回滚"体现在终态写入**单向**（终态去重直接 `return nil`，`task.go:622-627`），审计文件 append-only、无删除接口。

## 5. 协议与帧格式对比

### 5.1 Rshell：外层 4B 类型 + 内层业务字段

内层消息头所有通道一致（`websocket.go:324-326`、`tcp.go:295`）：`[4B type (BigEndian)][payload...]`，`type` 取 `1`=firstBlood、`2`=otherMsg、`3`=heartBeat。`otherMsg` 是二段结构（`websocket.go:501-522`）：

```
[4B type=2] [4B metaLen] [metaLen 字节 metaInfo(Base64)] [realMsg(Base64) 到结尾]
```

结果帧解包顺序（`websocket.go:529-576`，服务端视角）：

```
realMsg --Base64--> --Decrypt(第1次)--> --Decrypt(第2次)--> [4B replyType] [data]
```

`replyType` 是**与命令类型共用命名空间**的混编枚举：`0` 命令输出、`31` 错误、`10/12/19/26/45/47/48/50/61` 复用命令常量，另有 `22`（下载首包）这个不在 `cmdType.go` 里的裸数字。

| 通道 | 帧界定 | 代码 |
|---|---|---|
| WebSocket | 一条二进制 message = 一帧；**服务端下发不带长度前缀，直接是 Base64 文本** | `websocket.go:174` 发 `BinaryMessage` |
| TCP / KCP | `[4B len][payload]` | `tcp.go:150-158`、`:241` |
| HTTP | 上行 Cookie 塞 `BDUSS=...;SESSIONID=<metaInfo>`，body 为 Base64 密文；下行 JSON `{"data":{"log_id":…,"action_rule":{"pos_1":…,"pos_2":<命令或[]>,"pos_3":…}}}` 伪装腾讯搜索字段 | `config.go:4-15`、`get.go:560-591` |
| OSS | 对象名即帧：`<uid>/server_<20 位纳秒>`，内容 Base64 密文 | `sendCommand.go:230` |

心跳/抖动：

| 对象 | 周期 | 判死 | 代码 |
|---|---|---|---|
| WS Ping | 30s | 读超时 60s（Pong 刷新） | `websocket.go:276-284` |
| WS 心跳检查 | 10s 一轮 | `>90s` 计数 +1，**连续 5 次**关 | `:209-239` |
| TCP 心跳检查 | 10s 一轮 | `>30s` 计数，**3 次**关 | `tcp.go:160-202` |
| HTTP | 植入端 `sleep`（默认 5s） | `>SleepTime*2` 计数 3 次下线 | `get.go:150-195` |
| 主动 sleep | `sleep <秒>` → 4B 毫秒下发 | — | `sendCommand.go:39-47` |

**没有 jitter**：全链路只有固定 interval，"抖动"这个词在仓库里不存在。

文件传输分块：上行 `utils.SplitByteArray(fileBytes, 1040500)`（`api/clients.go:257`，约 1MiB/块），每块一个 `25 UploadLoop` 帧，每 5 块往 shell 历史写一行进度；下行植入端自定块大小，服务端只看 `[4B pathLen][path][chunk]` 并 `O_APPEND`（`websocket.go:695-740`），进度靠 `downloaded_size` 累加——**无 offset、无校验、无续传语义**。

### 5.2 Toshell：30 字节固定头 + JSON payload + 双加密层

主协议头（`common/protocol/packet.go:5-10,65-87`）：

| 偏移 | 长度 | 字段 | 编码 |
|---|---|---|---|
| 0 | 4 | Magic = `"TSHL"` | ASCII |
| 4 | 1 | Version = `0x01` | |
| 5 | 1 | Type | 见下 |
| 6 | 4 | Length | BigEndian uint32 |
| 10 | 8 | ID | uint64（**会话 id = `%x` 格式化这 8 字节**，`handler_core.go:38`） |
| 18 | 8 | Timestamp | uint64 |
| 26 | 4 | Checksum | uint32 |
| 30 | n | Payload | JSON 或裸字节 |

`HeaderSize=30`、`MaxPayloadSize=10MiB`。帧类型（`:12-34`）：`0x00` Register、`0x01` Heartbeat、`0x02` Task、`0x03` Result、`0x04` FileUpload、`0x05` FileDown、`0x06` Ack、`0x07` ShellOpen、`0x08` ShellData、`0x09` ShellClose、`0x0A` Tunnel、`0x0B` Relay、`0x0C` ScreenFrame、`0x0D` RelayStatus、`0x0E` ModuleData、`0xFF` Error。帧级标记（`:36-41`，仅 WS/TCP）：首字节 `0x00`=AES-GCM 加密的 Packet（控制面）、`0x01`=XOR 编码的隧道流（数据面）——**同一连接上控制面与数据面用不同编码**，这是它同时承载 shell 与 SOCKS5 的原因。

`TypeModuleData` 负载布局（注释 `:27-32`，实现 `moduleabi.EncodeBlobFrame`）：`[4B 头长][头 JSON][模块裸字节]`；用独立帧而非常规任务参数的理由写得好：任务表/列表/SSE 里只会出现一次性 token，不会出现多 MB 二进制。隧道协议头（`common/tunnel/protocol/constants.go`）：`[1B 0x7F][1B 0x54][1B ver=0x02]…` 共 16B；类型 `0x00` Handshake / `0x01` HB / `0x02` NewTunnel / `0x03` Close / `0x04` Ack / `0x05` Sync / `0x06` List / `0x0F` Error / `0x10` Data / `0x11` DataAck / `0x12` DataBatch；flags：`0x01` gzip（废弃）、`0x02` encrypted、`0x04` priority、`0x08` final、`0x10` batch、`0x20` **Snappy**（"比 gzip 快 10 倍"）。

| 加密层 | 算法 | 位置 |
|---|---|---|
| 协商 | X25519（`ScalarMult` + clamp） | `common/crypto/crypto.go:79-98` |
| 派生 | **HKDF-SHA256**，`salt=nil`，`info="toshell-session"` → 32B | `:100-109` |
| 对称（默认） | **AES-256-GCM**，12B 随机 nonce 前置 | `:21-36,50-68` |
| 对称（可选） | ChaCha20-Poly1305（XChaCha） | `:38-48` |
| 国密（可选） | SM4 | `common/crypto/sm4.go` |
| 隧道数据面 | XOR 快路径（`encKey` 裸密钥） | `listener.go:38` |

心跳与抖动：植入端 `interval + jitter`，`GetInterval()` 直接返回两者之和（`internal/implant/transport/transport.go:142-148`）——**是"固定增加"而非随机抖动**，比"每次随机 0..jitter"更易被节奏分析，但至少让不同载荷可配不同节奏。服务端判活 `effectiveTimeout = max(HeartbeatTimeout, 3×observedInterval)`，有任务在跑时再 `×3`（`session/session.go:21-41`）——踩过"离线几秒又在线"后加的保护。

文件传输分块：通道帧上限 16MiB（`tcp_listener.go:331`）、协议载荷 10MiB；大文件走独立 transfer 状态 `transfers[taskID]{TransferID,Size,Received}`（`task/task.go:43-48`），**挂在全局 Manager 而非监听器实例**——注释明确"listener stop/start 会重建实例，实例字段重启即丢，导致续传退化为全量重推"；重连时 `replaySessionTasks` 按"已有部分分块 → 下发 resume 任务（Data 带 `transfer_id+offset`）"（`handler_core.go:122-130`）；进度用 `UpdateProgress(0..100)` 单独更新、不改状态（`task.go:912-936`）。

### 5.3 三者对照

| 维度 | Rshell | Toshell | 我们的取舍 |
|---|---|---|---|
| 帧头 | 4B type（无 magic/版本/校验） | 30B 固定头（magic+ver+type+len+id+ts+checksum） | 学 Toshell 固定头，**id 用 8B UUID** 便于做 DO key |
| 载荷 | 裸字节 / Base64 / JSON 混用 | 统一 JSON（除 ModuleData/Tunnel） | 统一 JSON + 少量二进制旁路 |
| 加密 | AES-CFB + X25519（无 KDF、无 AEAD） | AES-GCM/ChaCha + X25519 + HKDF | **AES-256-GCM + P-256 ECDH + HKDF**（WebCrypto 可用性优先） |
| 双加密 | 有（同 key 加两遍） | 无 | 无（AEAD 一次足够） |
| 心跳 | 固定周期，无 jitter | interval + jitter（加法），服务端自适应阈值 | interval + **真随机 jitter**；判活 = 3×实测间隔 |
| 判死 | 计数 3–5 次 | 自适应 + 忙期宽限 | 学 Toshell |
| 任务标识 | **没有**（靠 channel 阻塞配对） | 单调 uint64 + DB 自增 + 重启校准 | D1 行 id / ULID |
| 结果承载 | 拼进一个 TEXT 字段 | 任务一行 + 结果可外置句柄 | 结果进 R2 + D1 存句柄 |
| 续传 | 无 | transfer_id + offset | R2 multipart + offset |
| 直播通道 | WS（交互 shell） | WS + SSE（Agent 事件） | **WS（DO）+ SSE（Worker，带 Last-Event-ID）** |

## 6. 【最重要】可借鉴设计清单（24 条）

> 格式：做法 → 为什么好 → 能不能照搬（Workers+D1+R2+DO）→ 不能的话怎么改。"能照搬"指设计可照搬，代码一律不复制（§8）。

**1. 能力位驱动的 UI**（`features.go`）
做法：能力=编译期事实 → 构建时算位图 → 编成 `cap:v1:<16hex>` 令牌注入载荷 → 心跳上报 → 服务端解码 → "能力→tab"映射算出可用面板 → 为什么好：界面永不可能出现"点了没反应的按钮"；能力表只有服务端一份不漂移；位序只许尾部追加，老载荷永远解得出正确结果 → 照搬：**能**（纯逻辑无 IO）；改法：把"编译期"换成"构建流水线期"，能力位随档案写进 D1 的 `implants` 行，心跳令牌二次校验（防人改库）。

**2. 能力令牌版本化 + 未知即回退**
做法：`TokenPrefix="cap:v1:"`；`ParseToken` 只认精确前缀 + 恰好 16 位 hex；未知位解码时忽略而不 panic（`:365-375`）；全 0 位图按"没上报"处理（`:454-460`）→ 为什么好：协议演进时"老服务端遇新载荷"是可预期事件，回退 OS 推导比按错位序解出**错误能力表**安全得多 → 照搬：**能**；改法：升级成 `cap:v1:<arch>:<16hex>`，把架构也纳入令牌。

**3. 任务状态机 + 终态幂等去重**
做法：`pending→sent→completed|failed|timeout`，`Complete`/`Fail`/`Expire` 第一步都判终态，是则 `return nil` 不报错（`task.go:622-627,828-832,885-889`）→ 为什么好：重连补发、重复结果帧、超时看门狗与结果帧并发到达必然发生，去重让"重复上报"变无害而非重复副作用 → 照搬：**能且必须**；改法：D1 用 `UPDATE tasks SET status='completed' WHERE id=? AND status IN ('pending','sent')` 做原子 CAS，靠 `changes()` 判断，比先读后写省一次往返且天然并发安全。

**4. 任务归属校验**
做法：结果上报只按 TaskID 找任务不够——TaskID 进程内递增、极易预测，任何能打 `/result` 的人都能伪造/终止任意任务（`task.go:689-699` 审计 H1）；于是把归属校验做成终结的**前置条件**，`CompleteForSession` 校验 `task.SessionID == 上报会话`，不符即返回且状态一点不改 → 为什么好：堵的是真实链——伪造结果 → 污染 Agent 上下文 → prompt injection → 照搬：**能**；改法：还要求"token 就是注册时下发的那个"（`HMAC(session_id,secret)`），并把校验写进 SQL 的 WHERE。

**5. 批量下发**
做法：轮询通道心跳间隔长，一次只发一个会让任务排队几分钟、表现为"功能无响应"，故从 pending 一次取最多 N 个（`task.go:542-577`）→ 为什么好：把 n 次往返压成 1 次，对 100k 请求/天是直接省钱 → 照搬：**能**；改法：`SELECT … WHERE session_id=? AND status='pending' ORDER BY id LIMIT ?` + 批量 upsert 一次 `batch()`，上限按帧大小（≤32MiB）与 DO 写预算取 20–50。

**6. 事件驱动等待**
做法：任务终结时 `notifyLocked(id)` 唤醒所有等待者；`waiters` 与任务状态**共用同一把锁**，因为"注册等待"与"状态变更"必须互为原子点，否则丢通知（`task.go:663-664`，详见 `wait.go`）→ 为什么好：Agent/CLI 不必各自挂满超时轮询，任务结束立刻拿结论 → 照搬：**不能照搬实现，能照搬语义**；改法：DO 天然有——每会话一个 DO，`alarm()` + 内存 `Deferred`；跨实例等待用 DO 的 WS 推送 `task_completed`。

**7. 断点续传（transfer_id + offset）**
做法：`TransferState{TransferID,Size,Received}` 挂在**全局 Manager**（非监听器实例，否则 stop/start 丢状态、续传退化全量重推）；重连时按已有分块下发 resume 任务（Data 带 `transfer_id+offset`）（`task.go:43-48,962-997`；`handler_core.go:122-130`）→ 为什么好：大文件在 C2 场景几乎必然断，全量重推等于把带宽与植入端超时预算烧光 → 照搬：**能**，状态换地方；改法：三项进 D1 一行，数据块进 R2 multipart（天然有 part 序号）；**offset 必须单调递增且服务端校验**（`received > st.Received` 才更新）——Rshell 完全没有这个概念。

**8. 结果外置成句柄**
做法：超内联上限的结果落盘，上下文只放"摘要+句柄"；句柄 `20260927/ab12cd34ef567890`；`Get(handle,offset,limit)` 分页、单次 ≤256KiB；句柄用**严格白名单正则**校验杜绝 `../`（`mcp/resultstore.go:17-119`）→ 为什么好：三层收益（省上下文、省内存、安全——句柄是外部输入，白名单是唯一正确做法）→ 照搬：**能，这是 R2 的教科书用法**；改法：ResultStore→R2（key `<run_id>/<seq>-<random>.bin`），`Get`→R2 Range 请求；TTL 用 lifecycle rule + D1 索引双保险；白名单正则保留并追加 `run_id` 前缀校验（防越权读别人的结果）。

**9. SSE + Last-Event-ID + 环形缓冲 + resync**（`handlers_copilot.go:392-574`）
做法：① 每条事件带 `id: <seq>`（run 内从 1 递增），连接建立先发 `retry: 3000`；② 空转每 15s 发**注释帧** `:\n\n`（不是事件、不进回放、不占 seq）防代理掐长连接；③ 控制帧（`status`/`state`）**故意不带 `id:`**——带上会把客户端水位线推到虚假位置，重连反而漏事件；④ 续传 `Last-Event-ID` 头优先、`?last_event_id=` 次之；⑤ **先订阅后快照**，再回放 `(lastID,Head]`，实时流里 `seq<=lastSent` 一律跳过（重叠必然存在，去重比"保证不重叠"可靠）；⑥ 三种兜底：`lastID>Head`（重启后序号重来）→ 按"从当前开始"且**绝不把 lastSent 设为 lastID**（否则永久黑屏）；`lastID+1<Oldest` → `resync{events_expired}`；通道满丢事件 → `resync{events_dropped}`；⑦ 缺口一次连接只报一次 → 为什么好：这是"不重不丢"的完整答案，且把"补不上"**显式告知**客户端而非假装连续；注释甚至写了"为什么不能先回放后订阅"（回放期间事件只能靠通道缓冲兜，缓冲一满就静默丢失）→ 照搬：**能，SSE 在 Workers 上比 WS 更省**（一个 HTTP 响应流，不占 DO 的 WS 消息预算）；改法：seq 用 D1 `agent_events(run_id,seq)` 复合主键或 DO 环形缓冲 + D1 落盘；补不齐时降级为"返回 run 详情 + 从当前继续"；心跳注释帧必留。

**10. WS 广播 + 慢客户端显式丢弃**
做法：`WSHub` 单 goroutine 事件循环；广播对每个 client `select { case send<-msg: default: close(send); delete(clients) }`——**缓冲满直接断开并记 dropped**（`api/ws_push.go:60-98`）；扇出观测回调在**锁外**调用（`:88-95`）→ 为什么好：一个慢客户端不能拖垮整个广播（否则实时屏幕流会把所有订阅者延迟一起拉爆）；丢弃是**显式**的（有计数、有观测点）→ 照搬：**不能照搬单 goroutine hub**；改法：每会话一个 DO，`acceptWebSocket` + hibernation；`send` 前查 `bufferedAmount`，超阈值 `close(1013)` 并在 D1 记 `delivery_dropped`。

**11. 审计不可回滚 + 不落参数原文**
做法：每次调用一行 JSONL（`O_APPEND`+0600），14 个固定字段；**只落 `args_keys` + `args_digest`**，敏感键值不参与摘要（命中即 `<redacted>`，连长度都不透露）；`AuditSink` 可选镜像进 DB，但**落盘才是权威**；写失败只记 stderr，不影响调用结果（`mcp/audit.go:18-89`）→ 为什么好：审计文件不可编辑（append-only、无删除接口）；凭据不会被抄进长期文件；摘要仍可关联（同 digest 出现两次 = 同参数重放）→ 照搬：**能，但"文件"换 R2**；改法：R2 追加式对象（`audit/<yyyy>/<mm>/<dd>/<hour>-<shard>.jsonl`）或 D1 `audit_events` 带 `prev_hash` 形成哈希链；**`args_digest` 用 HMAC-SHA256 而非裸 SHA256**（裸 hash 对低熵参数可字典反推，如 4 位 PID）。

**12. 白名单式文件预览**
做法：`preview` 包纯逻辑分类（text/image/executable/archive/database/unknown）；文本上限 1MiB、超大只回 64KiB 前缀并标 `truncated=true`、图片 2MiB、硬上限 64MiB；**明确不预览 svg**（可内联脚本）；未识别后缀返回 `preview_unknown_ext` 让操作员确认后只读预览 8KiB；服务端用 `Decide` 做**二次校验**（前端限制可被绕过），同一份清单经 `/api/v1/files/preview-policy` 下发前端（`common/preview/preview.go:1-60,125-140`）→ 为什么好：默认拒绝 + 一处判定 + 前后端同源；`preview_binary`（内容探测）与 `preview_bad_image`（后缀是图片但签名不符）堵住"后缀撒谎"这条最常见绕过 → 照搬：**能**；改法：清单进 D1 或编进 Worker 常量；前缀读取用 R2 Range（`bytes=0-65535`），**绝不整体 buffer**（10ms CPU / 128MB 内存）。

**13. 限流三闸（RPM / 并发 / 挂起句柄）**
做法：按 token 三道独立闸——滑动窗口 60 RPM（**明确不用固定窗口**，跨窗口边界会放行 2 倍流量）、同 token 并发 4、未读外置句柄 32（磁盘水位闸）；超限一律 429 + 点名哪道闸；句柄释放只有两条路径（读完 / TTL 惰性剔除），**不做 FIFO 淘汰**（"淘汰意味着服务端替客户端删结果，可能删掉还没读的关键输出"）（`mcp/ratelimit.go:9-78`）→ 为什么好：三闸各防一种炸法（刷请求 / 占满 goroutine / 写满磁盘），且 fail-closed（宁可 429 也不替你丢数据）→ 照搬：**能**；改法：RPM 用 DO storage 计数（或 D1 `rate_windows` + 原子 upsert），**不要用 KV**（同 key 1 写/秒、1000 写/天）；并发用 DO 单线程 + `inFlight` 计数；句柄数从 D1 `COUNT(*) WHERE read_at IS NULL AND ttl>now`。

**14. fail-closed 的破坏性动作分级**
做法：把 6 条杀软对抗链收成三件套——Tier（L0 侦察 / L1 用户态温和 / L2 强 / L3 BYOVD / L4 检测面抑制）+ Action 表（动作→等级→任务类型→必需能力位→影响文案）+ Policy（`allow_l2/l3/l4`、确认、超时上限）。三条硬规则：**未知动作一律拒绝**、**未知等级串归最高风险并拒绝**、**等级只能由动作决定**（请求里的 `tier` 只做一致性核对，不符即拒，防"用 tier=L0 绕过 L2 开关与二次确认"）（`common/avops/avops.go:1-120`）→ 为什么好：`Destructive` 口径是"是否留下**不可自动回滚**的改动"，于是 `edr_blind`（改系统级 Autologger + 覆写 ntdll `.text`）被正确标成破坏性，而不是因为"没杀进程"就当成温和操作 → 照搬：**能且必须**；改法：Action 表进 D1（热更新）+ 编进 Worker 常量兜底；二次确认用一次性 confirm token（D1 行，TTL 60s，绑定 `session_id+action+参数 digest`），**确认本身要进审计**。

**15. 破坏性动作禁止自动重投递**
做法：`ListReplayable`（断线补发）与 `RequeueSentEx`（轮询重投递）**都**调 `avops.TaskNoRetry`；被拒任务**保持 sent** 而不改终态——"我们并不知道植入端有没有执行过它，擅自改成终态会让操作员以为没执行从而重新下发"（`task.go:999-1100`）；`Expire`（服务端超时）是第二条独立保证（终态任务天然不会被重投递选中）→ 为什么好：承认不确定性的写法——不猜，把判断交回给人，并让不确定性可见（日志报"有 N 条未补发"）→ 照搬：**能**；改法：`TaskNoRetry` 从"按类型"扩展成"Tier ≥ L1 或 `destructive=true`"；重投递路径只保留一条（DO 重连时的一次查询）。

**16. 会话判活自适应**
做法：`effectiveTimeout = max(HeartbeatTimeout, 3×observedInterval)`，有任务在跑再 `×3`；`observedInterval` 从 `LastSeen` 变化平滑采样（`session/session.go:21-41,49-53`）。动机写在启动注释里：`interval=60s` 与 `heartbeat_timeout=60s` 几乎零余量，任何一次心跳迟到都判离线，"前端表现为离线几秒又在线抖动" → 为什么好：判活阈值与载荷节奏解耦，不同载荷可配不同 interval 而服务端不改代码 → 照搬：**能**；改法：DO `alarm()` 做判活，`observedInterval` 存 DO storage；alarm 每次触发算 1 请求 + 1 行写，周期要 ≥60s。

**17. 任务 id 重启校准**
做法：内存 atomic 计数器重启归零会与 DB 历史 id 撞号，启动时用 `MAX(tasks.id)` 抬到之上，只向更大方向、幂等且 CAS（`task.go:163-182`）→ 为什么好：20 行代码挡住"前端按 id 查任务串到旧记录"这类难查 bug → 照搬：**不需要**（D1 自增/ULID 天然全局唯一），但**语义要保留**：用"会话内递增 seq"时 seq 来源必须持久化；改法：任务 id 用 ULID（时间有序 + 全局唯一 + 可作主键），seq 用 `MAX(seq)+1 WHERE run_id=?`。

**18. 模块二进制与任务解耦（一次性 token）**
做法：`exec_module` 任务的 `Data` 只有 `moduleabi.ArgumentHeader` JSON（`module_id/token/sha256/size/abi/args_json`），**模块字节走独立的 `TypeModuleData` 帧**先下行；植入端按 token 暂存、执行时按 token 取、**取出即删**（`task.go:440-459`、`packet.go:27-32`）→ 为什么好：任务表/列表/SSE 里只有短 token，不会出现多 MB base64；字节只出现在该出现的那一次下行；"授权"（一次性、可审计、会过期）与"字节"解耦 → 照搬：**能，这是 R2+D1 的完美分工**；改法：字节放 R2（`modules/<id>/<sha256>.bin`），任务只放 `{module_id,sha256,size,token}`；token 用 D1 一行（`expires_at`,`used_at`），用一次即置；植入端拿预签名 URL **自己来 R2 取**，字节不经 Worker。

**19. 监听器路由（会话 → 监听器实例）**
做法：会话注册时记 `ListenerID`，所有推送先 `resolve(sessionID)` 再转发，未命中回退默认（`api/router.go:132-147`）；`ChannelHealth()` 按四通道统计实例数（`:93-116`）→ 为什么好：多监听器并存时"这个会话该从哪推"必须集中回答，放 router 里比散在 handler 里安全 → 照搬：**不能照搬**（Workers 没有"运行中的 socket 实例"）；改法：我们的"通道"是**协议**（`ws|http-poll|dns`），路由表退化成 D1 的 `sessions.channel` 列，`resolve` 就是读一列 + 三选一分派。

**20. 通道健康仪表**
做法：`/channels/health` 返回 `{tcp:n,http:n,websocket:n,mqtt:n}`（`api.go:584`），前端 Channels 页直接渲染 → 为什么好：通道是 C2 最脆的一层，"现在有哪几条通道活着"应是首屏信息而非靠日志推断 → 照搬：**能**；改法：改成 `{ws:活跃DO数, poll:近5分钟有请求的会话数, dns:近5分钟有查询的会话数}`，一次 D1 `GROUP BY` 聚合。

**21. 伪装 / 拟态**
做法：Toshell 监听器带 `mimicry.Profile`（整形响应头 + 根路径诱饵，支持热更新，`http_polling.go:50-51`）；Rshell 更硬编码——HTTP 监听器只挂两个像腾讯搜索接口的路径（`listener.go:504-506`），Cookie 伪装百度 `BDUSS`（`config.go:4`），响应字段伪装 `action_rule.pos_1/2/3`（`get.go:560-591`）→ 为什么好：被动流量审计第一眼看"这个端点像不像正常业务" → 照搬：**部分能**——Worker 能改响应头/状态码/body 形状，但**不能伪造 TLS 指纹与证书**（Cloudflare 终结 TLS）；改法：拟态下沉到载荷侧 uTLS/H2 指纹（Toshell 的 `transport_tls_utls.go` 已示范），Worker 侧只做"路径/头/body 形状"。

**22. HTTP 轮询的会话令牌**
做法：注册响应（加密）下发 32 字节随机 hex，`GET /task` 必须携带，缺失/不匹配 403 且**绝不调用 GetNext**（`http_polling.go:58-71`）→ 为什么好：堵住"知道 session_id 就能拉任务"的洞，token 只给真正完成注册的一方 → 照搬：**能**；改法：token 存 D1 的 `sessions.poll_token_hash`（存 hash 不存明文），常量时间比较，每次注册覆盖旧值。

**23. 前端 request 层统一错误语义（借骨架不借实现）**
做法：单例 axios + 请求拦截注入 JWT + 响应拦截把 `401/402/404/500/429` 映射成四类可读提示（`utils/request/index.ts:45-103`）→ 为什么好："错误语义只有一处定义"是前端可维护性的分水岭 → 照搬：**能**（搬到 `apps/web`）；改法：把硬跳转 `window.location.href` 换成路由跳转；**去掉模块级单例 cancelToken**（§7.8）；错误码表从后端契约生成。

**24. per-uid 命令历史 + 页签 keep-alive**
做法：`shellcommand` store 用 `Record<uid,string[]>` + 每 uid 一个游标实现上下键（`stores/shellcommand.ts:8-64`）；`tags.nameList` 驱动 `<keep-alive :include>`，切页签不重建终端（`ClientView.vue:62`）→ 为什么好：多标签终端不串历史；终端组件重建会丢 xterm buffer（体验断崖）→ 照搬：**能**；改法：历史落 localStorage（按 uid 分 key），加"敏感命令不入历史"开关。

## 7. 反面教材清单（18 条）

> 格式：做法 → 为什么是坑 → 在 Workers 上会怎么炸。

**1. 单进程内存态就是全部状态**
做法：会话表（`ClientListenerType`）、任务队列（`CommandQueues`）、等待者（`VarPidQueue`）、隧道、监听器实例、Agent 事件环全是包级 `map`+`sync.Mutex`（`connection/connection.go:10-16`、`command/commandQueue.go:10-12`、`task/task.go:23-41`）→ 坑：重启即失忆（靠"启动清空在线标记"补锅）、无法水平扩容、测试互相污染（Toshell 为此专门加了 `NewIsolated`，`task.go:136-143`）→ **Workers 炸点**：isolate 随时销毁且有多个并行，`let sessions = new Map()` 在下一个请求里就是空的；本地 `wrangler dev` 一切正常，上线后表现为"会话随机丢一半"——最难查的那类 bug。

**2. SQLite 本地文件当唯一库**
做法：`database.db` 落可执行文件同目录（`Rshell/sqlite3.go:166-175`）；Toshell 同构但更规范（WAL + `IF NOT EXISTS` 迁移，`database.go:29-51`）→ 坑：单进程独占、备份靠拷文件、`Sync2` 建表意味着字段只能加不能改（Rshell 连版本号都没有）→ **Workers 炸点**：**没有文件系统**；迁到 D1 时 Rshell 那 16 张表的"无迁移历史"会变成考古，所以我们从第一天就要有编号迁移。

**3. 跨请求全局变量 + 无锁 map**
做法：`encrypt.PublicKeyMap`（`encrypt.go:19`）多 goroutine 并发写；`authCache`（`middlewares/auth.go:24-26`）缓存 BasicAuth 结果；`WebDeliveryServer`（`api/webdelivery.go:16-17`）又一个全局 map → 坑：Go 里就是 data race（`go test -race` 必报）；缓存无上限无淘汰 → **Workers 炸点**：全局变量在 isolate 间不共享，缓存放这里命中率≈0；Cache API 是唯一跨请求缓存但有 512MB/TTL 语义，**不能当会话表**；用 KV 会撞"同 key 1 写/秒 + 1000 写/天"。

**4. 同步阻塞把 HTTP 请求挂住**
做法：`GetPidList` 发完命令就 `select` 在 channel 上等，最长 300 秒（`api/clients.go:95-119`）→ 坑：一个浏览器请求占一个 goroutine + 一个 DB 连接；用户关页面后结果无处可去；并发几个就耗尽连接池 → **Workers 炸点**：等待不计 CPU，**炸的是并发与子请求**——每个挂住的请求算一次在途请求（100k/天）并占 6 个在途连接名额之一；真正的死法是"用户刷新一次页面 = 一次 300s 长请求 = 一次 1027 超额"。正确做法：202 + 任务 id + SSE/轮询取结果。

**5. 密钥放配置文件 / 明文口令入库**
做法：`Users.Password` 明文（`sqlite3.go:20-26`，登录直接 `userPass.Password != pass`，`middlewares/auth.go:120`）；X25519 私钥进业务表 `Key`；Toshell 的 `JWTKey`/`EncryptionKey` 来自配置文件（首次启动自动生成落盘，`cmd/server/main.go:108-160` 注释自承"历史缺陷：仅打 WARNING 后继续运行"）→ 坑：库文件被拿走 = 全部凭据 + 服务端私钥一起泄漏；配置文件进 git 是常态 → **Workers 炸点**：`wrangler.toml` 会被提交，密钥必须走 `wrangler secret`（单条 ≤5KB、64 条上限）；更麻烦的是轮换——没有"读一次常驻内存"的地方、每请求都要从 env 取，所以**私钥不能作长期身份**，应改为"每会话派生密钥 + 服务端只存公钥"。

**6. 无 AEAD 的自制加密 + 双层加密**
做法：AES-CFB + IV 前置 + hex + base64（`encrypt.go:31-48,70-76`）；下发时**同一个 key 加密两遍**（`sendCommand.go:190-192`）；`EncryptNormal` 把随机 key **明文前置在密文头**（`encrypt.go:74`）→ 坑：CFB 无完整性（可翻转比特、可截断）、无序号可重放、双层加密不增强度只增故障面、"密钥与密文同包"是混淆不是加密 → **Workers 炸点**：WebCrypto 根本没有 CFB（只有 CBC/CTR/GCM/KW），移植必然重写；hex+base64+两层 AES 的膨胀吃掉 10ms 预算大半；手写 IV/nonce 管理在无状态运行时里**必然**出现 GCM nonce 重用（= 直接破密钥）。

**7. 一切靠轮询**
做法：客户端列表 2s（`ClientsView.vue:447`）、下载进度 2s（`ClientDownloads.vue:762`）、浏览器数据 2s、shell 内容 5s（`ClientShell.vue:1620`）；HTTP 通道本身也是轮询 → 坑：N 个标签 × M 个页面 = N×M×0.5 req/s 的无意义负载；数据没变也传全量 → **Workers 炸点**：100k/天 ÷（86400×0.5）≈ **2.3 个常开页面就能吃光全天配额**。这不是性能问题，是直接下线；必须改成 SSE/WS 推送 + 指数退避轮询兜底。

**8. 前端模块级单例 cancelToken**
做法：`let cancel: any = null;` 每个请求都覆盖它（`utils/request/index.ts:9,37-39`），`cancelRequest()` 只能取消"最后一个" → 坑：并发下取消行为不可预测（取消的是别人）→ **Workers 炸点**：不炸运行时，炸正确性——"用户点取消上传，结果取消的是心跳请求"，前端以为会话断了。正确做法：每请求自己的 `AbortController`，按 key 管理。

**9. 把全部输出拼进一个 TEXT 字段**
做法：`shells.shell_content` 不断 `+=`（`websocket.go:589`、`get.go:194`），单条超 1 万字节直接截断并追加 `[Data truncated...]` → 坑：每帧一次全行 UPDATE（输出 100KB = 100 次全行重写）、无游标只能全量拉、截断标记污染后续提取 → **Workers 炸点**：D1 免费 **100k 行写/天**，一个会话连续输出 1000 帧就是 1000 行写，十几个会话就没了；且 `+=` 到几十 MB 后单行写入直接失败。正确做法：append-only 事件表（每帧一行或每 4KB 一行）+ 游标分页读，或直接写 R2。

**10. 无请求体上限 / 无帧长上限**
做法：Rshell 的 `io.ReadAll(r.Body)` 无上限（`communication/post.go:113`），TCP 长度检查**被注释掉了**（`tcp.go:262-266`）→ 坑：一个 `Content-Length: 2GB` 就能 OOM → **Workers 炸点**：平台层有 100MB body 上限兜底，但 **128MB/isolate** 更早炸；且 `await request.arrayBuffer()` 会一次性把 body 读进内存。Toshell 的做法可照搬：**按入口分级设上限，超限 413**（`http_polling.go:73-101`，小包 64KiB / 大块 16MiB）。

**11. 到处 `recover()` 吞错误**
做法：每个 WS/TCP handler 顶部 `defer func(){ if r:=recover(); … }()`（`websocket.go:245-249`、`tcp.go:217-225`），panic 只记一行日志然后继续 → 坑：连接处于半坏状态（客户端以为连着、服务端已停止读）；错误不可聚合、不可告警 → **Workers 炸点**：未捕获异常 = 该请求 500 且没有进程可恢复；`try/catch` 吞掉后你会得到"200 + 空数据"，前端表现为"数据莫名其妙没了"。正确做法：错误分类 → 明确状态码 + 结构化错误体 + `waitUntil` 落审计。

**12. 枚举值复用 / 类型混编**
做法：`flag` 一字节同时编码架构与管理员（`websocket.go:424-430` 用 `>8`/`>4` 而非按位与）；`replyType` 与命令类型共用命名空间还混进 `22`、`31` 两个裸数字；插件 `shellcode-inject` 与 `inline-bin` 用同一任务类型（`plugin.go:151-168`）→ 坑：一字段两含义 = 半年后没人敢改；裸数字无法 grep → **Workers 炸点**：不炸运行时，炸**协议演进**——我们没有"重启所有载荷"的能力（载荷在目标机上），所以类型表必须一次设计对：一类型一语义 + 全具名常量 + 只许追加。

**13. 无审计 / 审计可被覆盖**
做法：Rshell **完全没有操作审计**（谁在何时对哪台机器下了什么命令，只有 shell 历史）；Toshell 早期同样缺，其 `docs/SECURITY-REAUDIT-1.4.2.md` 与 `mcp/audit.go` 头注释都在补这件事 → 坑：事后无法回答"这条 `rm -rf` 是谁下的" → **Workers 炸点**：不炸，但没有审计就无法做限流归因与事故复盘，而云端恰恰最需要（看不到进程、没有 tcpdump，只有日志）。

**14. 每帧一次全行 DB 更新**
做法：`UpdateTask(task)` 在 `Complete`/`UpdateProgress`/`GetNext` 各调一次且传整个结构体（`task.go:531,659,932`）→ 坑：SQLite 靠 WAL 还能扛，行写配额一算就崩 → **Workers 炸点**：D1 每次写都是**一行写**（计费与配额按行），进度 0→100 每 1% 更新一次 = 100 行写 = 一个文件下载烧掉 1/1000 日配额。正确做法：进度只在 DO 内存维护，完成时写一次终态，或按 10% 粒度落库。

**15. 监听本地端口 / 开本地 socket**
做法：Rshell 六个监听器全是 `net.Listen`/`ListenAndServe`（`listener.go:242-260`）；Toshell 的 MCP 服务端也自己 `Listen("tcp","127.0.0.1:18082")`（`mcp/server.go:63-64`）→ 坑：多实例部署端口冲突、容器化代价高 → **Workers 炸点**：**Worker 不能监听任何端口**（01 文档 §2）；所有"服务端主动 accept"的设计必须翻转为"客户端 HTTP 请求进来"，MCP 面改成 Worker 的一条路由（`/mcp`），会话状态进 DO。

**16. token 放 URL query**
做法：Rshell 交互 WS 用 `?auth=<token>`（`ClientShell.vue:1410`），服务端也接受 `?token=`（`auth.go:141-146`）→ 坑：token 进 Nginx/代理日志、浏览器历史、`Referer` → **Workers 炸点**：Cloudflare 的请求日志（Logpush / Workers Logs）会记录完整 URL，token 会出现在你自己的日志里。Toshell 的做法可抄：**query token 只对白名单路径放行**（只有浏览器无法加头的 WS/SSE 端点），其它路径一律 401 并说明正确用法（`auth.go:149-163`）。

**17. 配置全是编译期常量**
做法：Rshell 的伪装 Cookie、响应包装串、Webhook URL 全在 `pkg/config/config.go` 硬编码，改一个 Webhook 要重新编译 → 坑：运维改配置 = 发版；不同环境不能共用代码 → **Workers 炸点**：Worker 代码是**不可变部署**（每次 `wrangler deploy` 都是新版本），把配置写进代码等于"改配置走 CI"。正确做法：配置进 D1（热更新）+ `wrangler secret`（凭据）+ 少量 env（开关）。

**18. "看起来更安全"的动作代替安全设计**
做法：双层加密（同 key）、key 拼接在密文前、`flag>8` 表示管理员、每次响应塞 3000–4000 字节随机填充（`encrypt.go:176-188` `GenRandomBytes`）→ 坑：加密强度不变而 CPU 翻倍；随机填充让响应大小分布更像"随机"而不是更像"正常业务"（反而更容易被识别）→ **Workers 炸点**：每请求 10ms CPU，随机 4KB 填充 + 两次 AES + hex/base64 轻松吃掉大半预算，而安全收益为 0。正确做法：**AEAD 一次 + 真随机 jitter + 按业务形态整形响应大小**。

## 8. 许可证与复用边界

### 8.1 三仓 LICENSE 实测

| 仓库 | 文件 | 类型 | 版权行（原文） | 长度 |
|---|---|---|---|---|
| `C2/Rshell` | `LICENSE` | **MIT** | `Copyright (c) 2025 Rubby2001` | 21 行 |
| `C2/Rshell-web` | `LICENSE` | **MIT** | `Copyright (c) 2025 Rubby2001` | 21 行 |
| `C2/Toshell` | `LICENSE` | **MIT** | `Copyright (c) 2026 iQingshan and ToShell contributors` | 21 行 |

两处**不属于主仓代码**的许可证需单独说明：

| 位置 | 内容 | 对我们的约束 |
|---|---|---|
| `C2/Toshell/release/upx/{win64,linux-amd64}/upx-5.2.0-*/LICENSE` | **UPX 自身**许可证：GNU GPL v2 **+ 特殊例外**（"As a special exception we grant the free usage of UPX for all executables, including commercial programs"） | UPX 是构建工具，不进产物代码；特殊例外覆盖"被 UPX 压缩过的可执行文件"，压缩产物不受 GPL 传染。**但我们不复用 UPX 也不打包其二进制** |
| `C2/Toshell/docs/**`（11 篇设计文档）+ `docs/skills/toshell-api/SKILL.md` | 随仓库以 MIT 分发 | 可读、可引用观点，**不整段搬运**（§8.3） |

### 8.2 MIT 给了什么、我们为什么不直接抄

MIT 允许使用、复制、修改、合并、发布、再许可、销售，只需**保留版权与许可声明**。所以法律上可以复制，只要带上那三行版权。**不这么做，理由不是法律而是工程**：

| 理由 | 说明 |
|---|---|
| 运行时完全不匹配 | 三仓是 Go + 单进程 + SQLite + 本地 socket；我们 100% 是 TS + Workers + D1/R2/DO。复制的每一行都要重写，唯一"可复制"的其实是纯逻辑（正则、位运算、状态机判定），而那些恰好最该按我们的约束重新推导 |
| 隐含假设会跟着代码进来 | `encrypt.go` 依赖 `crypto/cipher`（WebCrypto 没有 CFB）；`sync.Mutex` 保护的全局 map 在 isolate 模型里语义完全不同。**复制代码 = 连它的假设一起复制**，错误假设是最贵的债 |
| 安全债传染 | `flag>8`、双层加密、`?token=`、无体积上限——若以"抄来的"身份进入新框架，review 时会被当成"既有设计"放过 |
| 归属与审计清晰 | 代码里混入第三方 Go 片段会让"这段谁写的、为什么这么写"永久失焦。**设计可以借，代码一行不抄** |

### 8.3 明确的复用边界

| 对象 | 可以 | 不可以 |
|---|---|---|
| 设计/架构思想（任务状态机、能力位、SSE 续传、结果外置、审计字段、限流三闸、fail-closed 分级、预览白名单） | ✅ 自由吸收、重新推导、按我们的约束重实现（§6 即其产物） | — |
| 协议/帧格式 | ✅ 作参考实现对照，理解字段为何这么排（如 Toshell 30B 头里 `ID` 与会话 id 的关系） | ❌ 沿用其字节布局（载荷加密与通道都不同，沿用只会"看起来兼容其实不兼容"） |
| 枚举/常量表 | ✅ 作**完备性检查清单**（"我漏了哪种任务类型？"——§4.4 就是干这个用的） | ❌ 照抄字符串值（按我们的命名规范重定，且一次定死） |
| Go 代码 | ❌ 不复制、不翻译、不"参考着改" | — |
| Vue/React 组件 | ✅ 读交互模式（xterm 装配、文件树、命令历史、页签 keep-alive），用我们的组件体系重写 | ❌ 复制 `.vue`/`.tsx` |
| 文档（Toshell `docs/*.md`） | ✅ 读观点与踩坑记录（`EVASION.md`、`PROTOCOL-HARDENING.md`、`AGENT-RESULT-OFFLOAD.md`、`SECURITY-REAUDIT-1.4.2.md` 信息密度很高） | ❌ 整段搬运（很多结论绑定 Go/单进程前提） |
| 测试用例 | ✅ 读它测了什么（Toshell 200+ 单测的文件名本身就是需求清单：`noretry_test.go`、`task_content_limit_test.go`、`handlers_body_limit_test.go`、`ws_origin_test.go`） | ❌ 复制测试代码 |
| 二进制/预编译产物（`release/upx`、`release/implant*`、`Rshell/dist`） | ❌ 不使用、不打包、不分发 | — |

### 8.4 若将来必须引用代码

确有小片段值得直接用（某个正则、某个位运算判定）时，三条同时满足，否则不引：① **隔离**——放独立 `packages/legacy-ref/`，文件头写明来源仓库、路径、行号、LICENSE；② **带声明**——`NOTICE` 附对应仓库 MIT 版权行原文；③ **带测试**——为该片段写独立测试证明新环境行为一致，**没测试的引用一律拒绝**。目前没有任何片段通过这三条，故本文档结论：**只吸收设计，不复制代码**。

## 9. 对 stratus-c2 的 6 条硬结论（给 02-architecture 的输入）

| # | 结论 | 来源 |
|---|---|---|
| 1 | 任务必须有 id、状态机、终态去重、归属校验；**不能靠"阻塞等 channel"凑请求-响应** | §2.4 + §6.3/6.4 |
| 2 | 能力位是"UI 与载荷同源"的唯一解，且必须**只许尾部追加 + 未知即 fail-closed** | §4.5 + §6.1/6.2 |
| 3 | 实时通道分两条：**WS 走 DO（hibernation）**做交互，**SSE 走 Worker**做事件流；SSE 必须实现 `id:` + `Last-Event-ID` + `resync` | §6.9/6.10 |
| 4 | 大结果**绝不进 D1 文本列**：进 R2、D1 存句柄；进度只在 DO 内存维护，完成写一次 | §6.8 + §7.9/7.14 |
| 5 | 破坏性动作按 Tier 分级 + 二次确认 + **禁止自动重投递**；"不确定是否执行过"时保持不确定态而非猜 | §6.14/6.15 |
| 6 | 审计从第一行代码开始：append-only、不落参数原文、`args_digest` 用 HMAC、可哈希链验证 | §6.11 + §7.13 |
