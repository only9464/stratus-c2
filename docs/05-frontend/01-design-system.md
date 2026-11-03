# 05-01 · 管理端前端设计

> 栈：**Vue 3 + Vite + TypeScript + Tailwind v4 + shadcn-vue（reka-ui）+ Element Plus + Pinia + Vue Router + TanStack Query**。
> 交付形态：静态 SPA，构建产物由 **console worker 的 Static Assets** 直接托管（不额外部署 Pages）。
> 原则：**重表格/重表单/复杂弹层用 Element Plus，外壳与视觉用 shadcn-vue**；两者共用一套 CSS 变量，暗色主题一键切换。

---

## 1. 分层与职责

| 层 | 选型 | 用在哪 |
|---|---|---|
| 设计系统（tokens + 原子组件） | Tailwind v4 + shadcn-vue | Button / Card / Badge / Input / Tabs / Dialog / Sheet / Toast / Table（轻量） |
| 重型控件 | Element Plus | `el-table`（分页、多选、树形）、`el-form` + 校验、`el-date-picker`、`el-upload`、`el-tree`（文件树）、`el-drawer` |
| 终端 | `@xterm/xterm` + `@xterm/addon-fit` | 交互 shell |
| 图表 | `echarts`（按需引入） | 仪表盘曲线 |
| 数据层 | TanStack Query（缓存/重试/失效） + Pinia（仅放"会话态"：当前用户、主题、WS 连接、密钥句柄） | — |
| 实时 | 原生 WebSocket 封装（`lib/ws.ts`） | 会话事件、终端 IO |

**为什么两套 UI 并存**：Element Plus 的表格/表单成熟度无可替代（尤其分页、虚拟滚动、日期范围）；shadcn-vue 提供的是"可改的源码组件 + 现代视觉"。混用最大的坑是**样式重置冲突**，方案见 §3。

---

## 2. 路由与页面

```
/login                         登录（AUTH_MODE=token）或 Access 直达
/                              仪表盘：会话/任务概览、配额水位、最近事件
/sessions                      会话列表（el-table：多选、筛选、批量下发）
/sessions/:id                  会话详情（Tabs）
  ├─ overview                  基本信息、能力位、标签、备注
  ├─ terminal                  交互 shell（xterm）
  ├─ files                     文件管理（树 + 上传/下载/预览）
  ├─ tasks                     该会话的任务流水
  ├─ screen                    屏幕帧（最新 + 时间轴）
  └─ pivot                     代理规则（socks5 / portfwd）
/tasks                         全局任务流水（按状态/分类筛选）
/payloads                      载荷：创建配置、上传二进制、生成一次性链接
/modules                       模块库（PE/BOF/shellcode 元数据）
/notes                         笔记（Markdown）
/pivot                         全局代理规则
/operators                     成员与公钥（admin）
/audit                         审计日志
/quota                         配额水位（Workers/DO/D1/KV/R2 + 今日用量）
/settings                      设置（元数据模式、保留期、通知、主题）
/doc                           OpenAPI（Scalar，可选路由）
```

---

## 3. 主题桥接（shadcn-vue ↔ Element Plus）

两套库都用 CSS 变量，但命名不同。**单一真源 = shadcn-vue 的 token**，Element Plus 变量由它派生：

```css
/* apps/web/src/styles/theme.css */
@import "tailwindcss";

@theme {
  --color-background: oklch(1 0 0);
  --color-foreground: oklch(0.145 0 0);
  --color-primary: oklch(0.55 0.18 264);
  --color-muted: oklch(0.97 0 0);
  --color-border: oklch(0.922 0 0);
  --radius: 0.625rem;
}

.dark {
  --color-background: oklch(0.145 0 0);
  --color-foreground: oklch(0.985 0 0);
  --color-primary: oklch(0.68 0.16 264);
  --color-muted: oklch(0.269 0 0);
  --color-border: oklch(0.269 0 0);
}

/* Element Plus 变量映射：只映射我们用到的那些 */
:root {
  --el-color-primary: var(--color-primary);
  --el-bg-color: var(--color-background);
  --el-bg-color-overlay: var(--color-background);
  --el-text-color-primary: var(--color-foreground);
  --el-border-color: var(--color-border);
  --el-border-color-light: var(--color-border);
  --el-border-radius-base: var(--radius);
  --el-font-family: inherit;
}

/* 关键：Element Plus 的 reset 会污染 shadcn 的按钮/输入，用作用域隔离 */
.el-scope .el-button { font-family: inherit; }
```

**三条规避规则**

1. **Element Plus 用 `unplugin-vue-components` 按需引入**（`vite.config.ts` 里配 `ElementPlusResolver({ importStyle: 'css' })`），
   所以 `main.ts` **不再** `app.use(ElementPlus)`；全局只 import 一份 `element-plus/theme-chalk/dark/css-vars.css`（暗色变量）。
   构建产物里 `el-table` 只在会话页的 chunk 里出现（实测 149 KB / gzip 52 KB），首屏不受影响。
2. **Element Plus 组件只在 `<el-scope>` 容器里用**（一个普通 div），避免它的全局选择器影响 shadcn 组件。
3. **暗色主题**：shadcn 用 `.dark` class，Element Plus 用 `html.dark` + `el-dark` 变量集。挂载时同时给 `<html>` 加 `dark` class 即可，两套自动一致。

---

## 4. 组件清单（`apps/web/src/components`）

| 组件 | 来源 | 说明 |
|---|---|---|
| `AppShell.vue` | 自写 | 侧栏 + 顶栏 + 内容区；侧栏可折叠（localStorage 记忆） |
| `NavItem.vue` | 自写 | 图标 + 文案 + 激活态 |
| `StatCard.vue` | shadcn Card | 仪表盘数字卡（带趋势） |
| `QuotaBar.vue` | 自写 | 配额水位条（用量/额度，>80% 变橙，>95% 变红） |
| `SessionTable.vue` | el-table | 多选、排序、状态徽标、行操作 |
| `TaskTable.vue` | el-table | 状态机色块、耗时列 |
| `TerminalPane.vue` | xterm |  attach / resize / 粘贴保护 |
| `FileTree.vue` | el-tree | 懒加载目录 |
| `FileDropZone.vue` | el-upload | 分片上传 + 进度 + 断点 |
| `ScreenViewer.vue` | 自写 | 帧时间轴 + 缩放 |
| `KeyManager.vue` | shadcn Dialog | 生成/导入/导出加密备份/指纹核对 |
| `TaskComposer.vue` | shadcn Sheet + el-form | 按任务类型动态渲染表单 → 加密 → 下发 |
| `RiskBadge.vue` | 自写 | 破坏性任务标记（红） |
| `EmptyState.vue` / `ErrorState.vue` | 自写 | 空态/错误态 |
| `ThemeToggle.vue` | 自写 | light/dark/system |

---

## 5. 状态与数据流

```
Pinia（全局会话态）                 TanStack Query（服务端态）
 ├─ user (id/role)                  ├─ sessions / session(id)
 ├─ theme                           ├─ tasks / results
 ├─ ws: { status, lastEventAt }     ├─ payloads / keys / audit / quota
 └─ keys: { keyId, fp, handle }     └─ 失效策略：WS 事件触发 invalidate
```

- **不把列表数据放 Pinia**（避免手写缓存同步）；列表一律走 Query + `staleTime: 30s`。
- **WS 事件 → `queryClient.invalidateQueries({queryKey:['sessions']})`**，不做"手动 patch 缓存"（容易漏）。
- **密钥句柄**（`CryptoKey`）只放内存 + IndexedDB；Pinia 只存 `keyId` 与指纹。

---

## 6. WebSocket 客户端（`lib/ws.ts`）

```ts
export class Stc2Socket {
  private ws?: WebSocket;
  private backoff = 1000;
  private readonly maxBackoff = 30_000;
  private queue: string[] = [];

  constructor(private url: string, private onEvent: (e: ServerEvent) => void) {}

  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => { this.backoff = 1000; this.flush(); };
    this.ws.onmessage = (m) => this.onEvent(JSON.parse(m.data));
    this.ws.onclose = () => this.retry();
    this.ws.onerror = () => this.ws?.close();
  }

  private retry() {
    const jitter = Math.random() * 0.3 + 0.85;
    setTimeout(() => this.connect(), this.backoff * jitter);
    this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
  }

  send(msg: object) {
    const s = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(s);
    else this.queue.push(s);              // 断线期间排队，重连后 flush
  }
}
```

**要点**

- 指数退避 + 抖动（与服务端 `Retry-After` 解耦）。
- 断线期间最多排队 100 条（终端输入），超出丢弃最旧（避免重连瞬间打爆 DO）。
- 心跳：浏览器侧不需要（服务端会主动关掉死连接）；用 `visibilitychange` 在页面隐藏时降低订阅。

---

## 7. 终端（xterm）

```ts
const term = new Terminal({ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13, cursorBlink: true });
const fit = new FitAddon(); term.loadAddon(fit); term.open(el); fit.fit();

term.onData((d) => enc.queue({ t: 'io', data: d }));   // 50 ms 合批
socket.onEvent((e) => { if (e.t === 'io') term.write(dec.decode(e)); });
```

- **合批**：按键按 50 ms 或 1 KB 聚合后一次发送（否则一条 `ls` 的回显就能打出几百个 DO 请求）。
- **二进制**：终端数据是 UTF-8 文本，直接字符串；**不用 base64**（省 33%）。
- **粘贴保护**：超过 8 KB 的粘贴先确认。
- **重连恢复**：进入会话时先拉最近 4 KB 输出（服务端 ring buffer）再接管实时流。

---

## 8. 大文件（前端侧）

| 场景 | 方案 |
|---|---|
| 上传（浏览器→云端→植入体） | 4 MiB 分片，`Promise` 并发 2；IndexedDB 记 `offset`；失败重试 3 次 |
| 下载（植入体→R2→浏览器） | `fetch` + `response.body.getReader()` 流式；`StreamSaver` 或 File System Access API 落盘 |
| 断点续传 | 先 `GET /files/:id` 拿 `chunks_done`，跳过已传分片 |
| 校验 | 每片 `SHA-256`（`crypto.subtle.digest`），服务端比对 |

---

## 9. 构建与托管

```jsonc
// workers/console/wrangler.jsonc
{
  "name": "stc2-console",
  "assets": {
    "directory": "../../apps/web/dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application"   // 所有未知路径回 index.html
  }
}
```

- `vite build` 产物 `apps/web/dist` → `wrangler deploy` 时自动上传（≤ 20,000 文件，免费额度）。
- API 与 SPA 同源：`/api/*` 走 Hono，其余走 `ASSETS`。
- 本地开发：`vite`（5173）+ `wrangler dev`（8788），Vite `server.proxy` 把 `/api` 与 `/ws` 转到 8788。

---

## 10. 体积预算（gzip 后）

| 块 | 目标 | 手段 |
|---|---|---|
| Vue + Router + Pinia | ~40 KB | 现代打包，`build.target: es2022` |
| Element Plus（按需） | ~60–90 KB | `unplugin-vue-components` + `ElementPlusResolver` |
| shadcn-vue + tailwind 产物 | ~15 KB | 只装用到的组件；Tailwind v4 自动裁剪 |
| xterm | ~50 KB | 动态 `import()`（只在终端页加载） |
| echarts | ~100 KB | 按需引入 `LineChart`/`GridComponent` |
| **首屏** | **< 250 KB** | 路由级 code split |

---

## 11. 可访问性与可用性

- 焦点可见（`:focus-visible` ring），键盘可达（Tab 顺序、Esc 关弹层）。
- 颜色不作为唯一状态标识（状态同时给图标 + 文本）。
- `prefers-reduced-motion` 时禁用动画。
- 危险操作：二次确认弹层里**显示服务端返回的 `impact` 原文**，不只写"确定吗"。
- 长列表：`el-table` 虚拟滚动（> 200 行启用）。

---

## 12. 已知限制

| 限制 | 说明 |
|---|---|
| 屏幕流不是视频 | 最高 2 fps，浏览器侧按"有新帧"拉图 |
| 终端延迟 | WS 在线时 < 200 ms；降级到 HTTP 轮询时等于轮询间隔 |
| 密钥备份 | 私钥不可导出为明文（除非用户显式导出加密备份）；浏览器清缓存 = 密钥丢失 |
| 多标签页 | 同一浏览器多标签共享 IndexedDB 密钥，但 WS 各自独立（服务端允许多连接） |
