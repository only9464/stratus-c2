# 03-04 · 任务目录（Task Catalog）

> 任务 = L2 明文里的 `{k, a, rid, ttl}`。**服务端看不到 `k` 和 `a`**（只在密文里），只看到 `cat` 粗分类与大小。
> 所有任务都是"下发 → 执行 → 结果"三段式；`ttl` 过期即丢弃。
> 平台列：`W`=Windows `L`=Linux `M`=macOS `*`=通用。

---

## 1. 分类与粗标签

| `cat`（服务端可见） | 包含的 `k` | 用途 |
|---|---|---|
| `shell` | `shell.exec`, `shell.pty_*` | 命令与终端 |
| `exec` | `exec.bin`, `exec.script`, `exec.mem` | 执行文件/内存加载 |
| `file` | `file.*` | 文件操作 |
| `proc` | `proc.list`, `proc.kill` | 进程 |
| `screen` | `screen.shot`, `screen.stream`, `screen.input` | 桌面 |
| `net` | `net.scan`, `net.info` | 网络 |
| `pivot` | `pivot.socks5`, `pivot.portfwd` | 代理（**代理端在植入体**） |
| `sys` | `sys.info`, `sys.whoami`, `sys.persist`, `sys.env` | 系统 |
| `module` | `module.load` | 插件/BOF/内存模块 |
| `e2e` | （全部，当 `METADATA_MODE=none`） | 隐藏分类 |

---

## 2. 任务清单

### 2.1 Shell / 执行

| `k` | 平台 | 参数 `a` | 结果 `out` | 风险 |
|---|---|---|---|---|
| `shell.exec` | `*` | `cmd:string, cwd?:string, timeout?:number, shell?:string` | `stdout+stderr`（合并，UTF-8 或按 `encoding` 转） | 中 |
| `shell.pty_open` | `*` | `cols, rows, shell?` | `{ch:"pty"}` 后续走 `io` 帧 | 中 |
| `shell.pty_resize` | `*` | `cols, rows` | `ok` | 低 |
| `exec.bin` | `*` | `path, args?:string[], cwd?, detach?:bool` | `{pid, code, out}` | 高 |
| `exec.script` | `*` | `lang:"ps1"|"sh"|"bat"|"py", body:string, keep?:bool` | 输出 | 高 |
| `exec.mem` | `W` | `b64:blob, args?:string[]`（PE/DLL/BOF） | `{ok, out?}` | 高 |

### 2.2 文件

| `k` | 平台 | 参数 | 结果 |
|---|---|---|---|
| `file.list` | `*` | `path, long?:bool` | `[{name,size,mtime,mode,is_dir}]` |
| `file.stat` | `*` | `path` | `{size,mtime,sha256?,mode}` |
| `file.read` | `*` | `path, offset?, len?`（默认 ≤ 256 KB/次） | `{b64, eof}` |
| `file.write` | `*` | `path, b64, append?:bool` | `{written}` |
| `file.del` | `*` | `path, recursive?:bool` | `ok` |
| `file.mv` | `*` | `from, to` | `ok` |
| `file.mkdir` | `*` | `path` | `ok` |
| `file.download_start` | `*` | `path, chunk:4194304` | `{tid, total, size, sha256}` → 走 `PUT /v1/file/:tid/:idx` |
| `file.upload_begin` | `*` | `path, total, size, sha256` | `{tid, next:0}` → 植入体 `GET /v1/file/:tid/:idx` |

> 文件内容**永不经 L2 密文帧**（1 MiB 上限），只走分片 HTTP + R2。`file.read` 是为了"读小文件/看配置"。

### 2.3 进程 / 系统

| `k` | 平台 | 参数 | 结果 |
|---|---|---|---|
| `proc.list` | `*` | `filter?:string` | `[{pid,ppid,user,name,path,cmdline}]` |
| `proc.kill` | `*` | `pid, force?:bool` | `ok` |
| `sys.info` | `*` | — | `{host,user,os,arch,uptime,cpu,mem,disks,av?}` |
| `sys.whoami` | `*` | — | `{user,groups,priv,integrity}` |
| `sys.env` | `*` | `filter?` | `{k:v}` |
| `sys.persist` | `*` | `method:"run"|"schtask"|"cron"|"service", name, cmd` | `{ok, detail}`（**破坏性，需二次确认**） |
| `sys.selfdestruct` | `*` | `wipe:bool` | 无条件退出（结果可能回不来） |

### 2.4 桌面（帧走 R2）

| `k` | 平台 | 参数 | 结果 |
|---|---|---|---|
| `screen.shot` | `*` | `display?:0` | `{key, w, h, sz}` → 控制台按 key 取图 |
| `screen.stream` | `*` | `fps:1|2, quality:60, seconds:30` | 多个 `screen` 帧通知 |
| `screen.input` | `*` | `type:"mouse"|"key", ...` | `ok` |
| `clip.get` / `clip.set` | `*` | `text?` | `{text}` |

### 2.5 网络 / 代理

| `k` | 平台 | 参数 | 结果 |
|---|---|---|---|
| `net.info` | `*` | — | `{ifaces, routes, dns, proxy}` |
| `net.scan` | `*` | `cidrs:[], ports:[], mode:"connect"|"syn"` | 压缩后的结果（见 §4） |
| `pivot.socks5_start` | `*` | `port, user?, pass?` | `{listen:"0.0.0.0:1080"}`（**在植入体上监听**） |
| `pivot.socks5_stop` | `*` | `port` | `ok` |
| `pivot.portfwd` | `*` | `lhost, lport, rhost, rport` | `{ok}` |

> 代理规则登记在 D1 `pivot_rules`，但**真正的监听端口在植入体或操作员本机**。云端不监听任何端口——这是平台限制，不是实现偷懒。

### 2.6 模块

| `k` | 平台 | 参数 | 结果 |
|---|---|---|---|
| `module.load` | `W` | `kind:"pe"|"bof"|"shellcode", b64, args?, entry?` | `{ok, out}` |
| `module.list` | `*` | — | `[{name, loaded_at}]` |

---

## 3. 任务状态机

```
queued ──dispatch──▶ dispatched ──ack──▶ running ──res──▶ done
   │                     │                  │
   │                     └──(无 ack, 超时)──▶ queued（最多 3 次）
   │                                        │
   └──(ttl 到期)──▶ expired                 └──res ok=false──▶ failed
```

- **重投递**：`attempts < 3` 且 `ttl` 未过期才重投；`sys.persist` / `sys.selfdestruct` **永不自动重投**（破坏性）。
- **幂等**：任务带 `rid`；植入体对同一 `rid` 只执行一次（本地 LRU 256 条）。
- **取消**：`DELETE /api/v1/tasks/:id` → 状态 `canceled`；若已 dispatched，下发 `cmd{cat:"control", a:{k:"cancel", rid}}`（尽力而为）。

---

## 4. 结果体积策略

| 结果大小 | 处理 |
|---|---|
| ≤ 4 KB | D1 内联（`task_results.inline_ct`） |
| 4 KB – 64 KB | 仍在 `res` 帧里传，但落 R2，D1 只存索引 |
| > 64 KB | 植入体先 `PUT /v1/file/:tid/:idx` 到 R2，`res` 只带 `out_ref` |
| 扫描结果 | 强制"压缩 + 截断 Top N + 分页句柄"，禁止一次性回传 10 万行 |

---

## 5. 平台差异（实现注意）

| 场景 | Windows | Linux | macOS |
|---|---|---|---|
| shell | `cmd /Q /C` 或 `powershell -NoP -NonI -C` | `/bin/sh -c` | `/bin/zsh -c` |
| 编码 | 中文系统默认 GBK（CP936）→ **输出按 `chcp 65001` 或本地转 UTF-8** | UTF-8 | UTF-8 |
| PTY | ConPTY / winpty | `openpty` | `openpty` |
| 提权 | UAC / token 复制 | sudo / SUID | sudo |
| 持久化 | 计划任务 / Run 键 / 服务 | cron / systemd | launchd |

> 编码问题（中文 Windows 的 GBK 输出）是 ToShell 真实踩过的坑：**在展示层归一，不要改原始字节**，否则回读会乱。

---

## 6. 破坏性任务清单（UI 必须二次确认 + 服务端禁重投）

| 任务 | 为什么 |
|---|---|
| `sys.persist` | 改系统启动项，难回滚 |
| `sys.selfdestruct` | 不可逆 |
| `exec.mem` | 内存执行可能崩宿主 |
| `proc.kill` | 可能杀掉关键进程导致失联 |
| `file.del`（`recursive`） | 数据丢失 |
| `pivot.*` | 在目标上开监听端口 = 新的暴露面 |

服务端在 `POST /tasks` 时校验 `cat`，对上述类型要求 body 里带 `confirm: true`；缺失直接 409，**且不落待发队列**。
