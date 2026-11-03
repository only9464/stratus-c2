# 04 · 管理端前端技术选型（Vue3 + shadcn-vue + Element Plus + Hono / Workers）

> 目标：**开源项目，陌生人 `pnpm i && pnpm dev` 就能跑**；console 单 Worker 部署（`assets` + Hono `/api/*`）。
> 数据快照 **2026-11-03**：版本号取 npm registry 实查，体积取 bundlephobia 实查（全量引用 / gzip）。
> 「2025 基线」列 = 2025 年内最后一版稳定大版本，供"求稳锁定"使用。

## 0. 结论先行

| 问题 | 结论 |
|---|---|
| 主 UI | **shadcn-vue + Tailwind v4** 做壳（布局、导航、表格外框、表单骨架、暗色主题） |
| Element Plus 用在哪 | 只做 shadcn-vue 缺失的重组件（日期区间、级联、穿梭框、树选、复杂表单校验），**路由级懒加载隔离** |
| 大表格 | **vxe-table**（虚拟滚动 + 服务端分页）；`el-table` 只用于 < 200 行小表 |
| 终端 | `@xterm/xterm` **5.5**（6.0 已发，addon 生态待跟） |
| 结果查看 | **CodeMirror 6** 默认；Monaco 仅在"需要语义提示"的页面 `import()` |
| 后端 | Hono **4.13.16** + `@hono/zod-openapi` + `@scalar/hono-api-reference`，与 Assets 同 Worker |
| 首屏预算 | 壳 < **160 KB** gzip；任一子路由 < **260 KB**；Monaco/ECharts 永不进首屏 |

## 1. 版本与兼容性矩阵

### 1.1 运行时 / 构建

| 组件 | 2025 基线 | latest（实测） | 兼容性要点 |
|---|---|---|---|
| Node.js | 22 LTS | 22 / 24 | Vite 7/8 要求 `^20.19.0 \|\| >=22.12.0`；`@vueuse/core@15` 要求 `node>=22` |
| pnpm | 9.x | 10.x | 用 `packageManager` 字段锁死，`corepack enable` 对齐 |
| Vue | 3.5.x | **3.5.44** | 3.5 系列无破坏变更，`^3.5` 安全 |
| Vite | 7.3.x（7.0 于 2025-06） | **8.3.5**（7.x 最新 7.3.7；6.x 最新 6.4.5） | 7/8 的 Node 要求相同；`@cloudflare/vite-plugin`、`@tailwindcss/vite` 已支持 6/7/8 |
| TypeScript | 5.9.x | **7.0.2**（5.x 最新 5.9.3） | TS7 是 Go 重写版；`vue-tsc@3` peer 仅要求 `>=5.0`，**保守锁 5.9**，CI 另跑一次 TS7 前瞻 |
| Tailwind CSS | 4.1.x | **4.3.4** | v4 用原生 `@layer`，preflight 在 base 层——§2 的坑多源于此 |
| `@tailwindcss/vite` | 4.1.x | 4.3.4 | peer `vite ^5.2 \|\| ^6 \|\| ^7 \|\| ^8` |
| `@cloudflare/vite-plugin` | — | latest | peer `vite ^6.1 \|\| ^7 \|\| ^8`、`wrangler ^4.156.1` |

### 1.2 UI / 组件 / 数据

| 组件 | 2025 基线 | latest | 说明与链接 |
|---|---|---|---|
| shadcn-vue | 2.x | **2.9.0** | 复制式源码，不是依赖包；CLI 拉 registry。https://www.shadcn-vue.com/docs/installation/vite |
| reka-ui（原 radix-vue） | 2.x | **2.11.0** | shadcn-vue 的无样式底座，peer `vue >= 3.4`。https://reka-ui.com |
| Element Plus | 2.11.x | **2.14.7** | peer `vue ^3.3.7`，支持 Vue3。暗色自 **2.2.0**：`html.dark` + `theme-chalk/dark/css-vars.css` |
| vxe-table | 4.1x | **4.23.14** | 虚拟滚动；https://vxetable.cn |
| Pinia | 3.0.x | **4.1.0**（3.x 最新 3.0.4） | v4 peer：`vue ^3.5.11`、`ts >=5.6`、`@vue/devtools-api ^8.2.1` → 升 v4 连带升 Vue |
| Vue Router | 4.6.x | **5.4.0**（4.x 最新 4.6.4） | v5 peer 含 `vite ^7.3 \|\| ^8`、`pinia ^3 \|\| ^4`、`@pinia/colada` → **与构建工具耦合，新项目锁 4.6** |
| TanStack Query for Vue | 5.x | **5.105.3** | peer `vue ^2.6 \|\| ^3.3`；与 Pinia 分工：Query=服务端状态，Pinia=UI 状态 |
| VueUse | 13.x | **15.0.0**（14.x 最新 14.4.0） | 按需 import，禁止整包引 |
| Zod | 3.x | **4.6.7** | `@hono/zod-openapi@1.6.3` peer 是 **zod ^4**，前后端必须统一到 4 |
| Hono | 4.x | **4.13.16**（`next` = 5.0.0-rc.1） | 生产锁 4.x |
| wrangler | 4.x | **4.156.2** | `wrangler types --env-interface` 生成 Env 类型 |
| `@xterm/xterm` | 5.5.0 | **6.0.0**（5.x 最新 5.5.0） | 5.5 全量 **65.5 KB** gzip；`addon-fit` 0.6 KB |
| Monaco | 0.52 | **0.57.0** | 主入口 27.2 KB，但 editor/worker 另计 **300 KB+** |
| CodeMirror | 6.0.2 | 6.0.2 | `@codemirror/view` 75.3 + `state` 15.7 KB gzip |
| ECharts | 5.6 | **6.1.0** | 全量 **359.3 KB** → 必须 `echarts/core` 按需 |

### 1.3 建议锁定组合（写进 `package.json`，别浮动）

```jsonc
{
  "dependencies": {
    "vue": "^3.5.44", "vue-router": "^4.6.4", "pinia": "^3.0.4",
    "@tanstack/vue-query": "^5.105.3", "@vueuse/core": "^14.4.0",
    "@xterm/xterm": "^5.5.0", "@xterm/addon-fit": "^0.11.0",
    "element-plus": "^2.14.7", "vxe-table": "^4.23.14", "echarts": "^6.1.0"
  },
  "devDependencies": {
    "vite": "^7.3.7", "typescript": "~5.9.3", "vue-tsc": "^3.3.14",
    "@vitejs/plugin-vue": "^6.0.10", "tailwindcss": "^4.3.4", "@tailwindcss/vite": "^4.3.4"
  }
}
```

> 体积口径提醒：bundlephobia 给的是**全量引用**，真实项目靠 tree-shaking / 按需引入通常能砍 50–90%。

## 2. shadcn-vue × Element Plus 混用：坑与规避

| # | 现象 | 根因 | 规避 |
|---|---|---|---|
| 1 | `w-full`/`mt-2` 加到 `el-input` 不生效 | Tailwind v4 的 utilities 在 `@layer utilities`；**EP 的 CSS 未分层**，未分层规则永远压过分层规则 | 给 EP 样式也套 layer：`@import "element-plus/dist/index.css" layer(ep);`；必要时用 `!` |
| 2 | `el-icon` 变整行、按钮内图标错位 | preflight 把 `svg` 设为 `display:block` | base 层补：`.el-icon svg{display:inline-block}` |
| 3 | 自定义按钮透明/无边框 | preflight 重置 `button{background:transparent;border:0}` | EP 自带按钮不受影响；自定义按钮显式写 `border`/`bg` |
| 4 | 暗色下两套 UI 不一致 | shadcn 用 `.dark` + `--primary…`；EP 用 `html.dark` + `--el-*` | **同一个开关**：`useDark()` 写 `<html class="dark">`，两套变量在同一块里赋值（§7） |
| 5 | Dialog/Select 被遮罩压住 | EP 弹层层级从 **2000** 起（`useZIndex` 初值），shadcn 习惯 `z-50` | 统一层级 token（下表），EP 侧 `<el-config-provider :z-index="1300">` |
| 6 | 行高/字重怪 | 两套 reset 叠加 | **只留 Tailwind preflight**；EP 只引 `dist/index.css`，不引它的 reset |
| 7 | 两份品牌色定义 | 两边都在 `:root` 写色值 | 品牌色只在 Tailwind `@theme` 定义一次，EP 侧 `--el-color-primary: var(--primary)` |

```css
/* apps/web/src/styles/index.css */
@import "tailwindcss";
@import "element-plus/dist/index.css" layer(ep);              /* 关键：进 layer */
@import "element-plus/theme-chalk/dark/css-vars.css" layer(ep-dark);

@layer base {
  .el-icon svg { display: inline-block; }                     /* 修 preflight */
  body { @apply bg-background text-foreground antialiased; }
}
```

```ts
// packages/shared/src/ui-tokens.ts —— 两边共用一套刻度
export const Z = { base: 0, dropdown: 1000, sticky: 1100, overlay: 1200,
                   modal: 1300, popover: 1400, toast: 1500, tooltip: 1600 } as const;
```

```vue
<el-config-provider :z-index="Z.modal" size="default" :button="{ autoInsertSpace: false }">
  <router-view />
</el-config-provider>
```

**关于 `ElConfigProvider` 的 `namespace`（EP 2.2.0+）**：需用 SCSS 以 `$namespace` 重编译 `theme-chalk`（产出 `--ep-*`/`.ep-*`），隔离彻底但构建链多一层、类名全换前缀。**结论：不用 namespace**——用「变量映射（§7）+ 层级 token + layer 包裹 + 路由级懒加载」四件套够用且不破坏一键启动。
> console 是纯 CSR SPA（Assets 托管 `index.html`），不存在 SSR 样式注入顺序问题，`namespace` 的强需求场景不成立；唯一红线：别引入在模块顶层执行 `document` 的库。

## 3. Hono 侧

| 项 | 现状 |
|---|---|
| 主版本 | **4.13.16**（`latest`）；`next` = `5.0.0-rc.1` → 生产锁 4.x |
| 体积 | 18.7 KB min / **7.6 KB gzip**（核心） |
| 形态 | console：`main` + `assets`；gateway：纯 API 无 assets |
| 指南 | https://hono.dev/docs/getting-started/cloudflare-workers |

**导出表实测**（`hono@4.13.16`，共 77 个入口，含 `./cloudflare-workers`、`./cloudflare-pages`、`./adapter`、`./validator`）；`dist/middleware/` 实际目录：

```
basic-auth bearer-auth body-limit cache combine compress context-storage cors csrf etag
ip-restriction jsx-renderer jwk jwt language logger method-not-allowed method-override
mount powered-by pretty-json request-id secure-headers serve-static timeout timing trailing-slash
```

> **`hono/rate-limiter` 在 4.13.16 里不存在**（导出表、`dist/middleware`、官方文档均无）。
> 限流改用：① Workers **Rate Limiting binding**（`env.RL.limit({key})`）；② DO 令牌桶；③ KV 计数（不精确）。

| 中间件 | import | 挂在哪 | 备注 |
|---|---|---|---|
| logger | `hono/logger` | 全部（dev） | 生产用 Workers Logs，别打全量 header |
| request-id | `hono/request-id` | 全部 | 与 Workers Trace 对齐排障 |
| secure-headers | `hono/secure-headers` | console | CSP 的 `connect-src` 要放行 WS 与 API 域 |
| cors | `hono/cors` | gateway | `origin` 用白名单函数，禁用 `*` |
| jwt | `hono/jwt` | console | HS256 + `c.env.JWT_SECRET`；Cookie 用 `HttpOnly; SameSite=Lax` |
| body-limit | `hono/body-limit` | gateway | 大文件走 R2 直传，Worker 只收小 JSON |
| zod-validator | `@hono/zod-validator` | 全部 | 与 `@hono/zod-openapi` **同一路由别混用** |
| csrf | `hono/csrf` | console（仅 Cookie 会话时） | 与 header-JWT 方案二选一 |

```ts
// workers/console/src/app.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";

const app = new OpenAPIHono<{ Bindings: CloudflareBindings }>();
const route = createRoute({
  method: "get", path: "/api/devices",
  request: { query: z.object({ cursor: z.string().optional(), limit: z.coerce.number().max(200).default(50) }) },
  responses: { 200: { description: "ok", content: { "application/json": { schema: z.object({ items: z.array(z.any()) }) } } } },
});
app.openapi(route, (c) => c.json({ items: [] }));
app.doc("/api/openapi.json", { openapi: "3.1.0", info: { title: "stratus console", version: "0.1.0" } });
app.get("/api/docs", apiReference({ spec: { url: "/api/openapi.json" } }));
export default app;
```

兼容性（实查 peer）：`@hono/zod-openapi@1.6.3` → `zod ^4.0.0`、`hono >=4.10.0`；`@scalar/hono-api-reference@0.12.17` → `hono ^4.12.5`。
两条纪律：① `/api/docs` 与 `/api/openapi.json` 必须鉴权或仅 dev 挂载（否则等于公开接口清单）；② zod 4 全量 **86.8 KB** gzip，worker 侧优先 `zod/mini` 或只引 schema 用到的部分。

```jsonc
// workers/console/wrangler.jsonc
{
  "name": "stratus-console", "main": "src/index.ts",
  "compatibility_date": "2026-11-01", "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./public", "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]              // 需要 wrangler >= 4.20.0
  },
  "observability": { "enabled": true }
}
```

- `not_found_handling: "single-page-application"` → 未命中返回 `index.html`(200)，深链刷新不 404。
- `run_worker_first` 用数组时**关闭** `Sec-Fetch-Mode: navigate` 自动判定，由你指定哪些路径进 Worker。
- 兼容日期 ≥ `2025-04-01` 时导航请求默认不进 Worker（省 invocation），副作用：浏览器直开 `/api/x` 拿到 HTML。

**wrangler v3 → v4**

| 项 | v3 | v4 |
|---|---|---|
| 静态资源 | `[site] bucket` | `assets = { directory, binding, not_found_handling, run_worker_first }` |
| 配置文件 | `wrangler.toml` | `wrangler.jsonc`（带 `$schema` 补全）+ toml 仍可 |
| Node 内置 | `node_compat = true` | `compatibility_flags = ["nodejs_compat"]` |
| 类型 | `wrangler types` | `wrangler types --env-interface CloudflareBindings` → `worker-configuration.d.ts` |
| 本地 | `wrangler dev`（老版默认 remote） | 默认**本地模拟**，远程绑定用 `--remote` |
| 体积检查 | `deploy --dry-run` | `deploy --dry-run --outdir bundled/`（输出 `Total Upload` + gzip 参考） |

```ts
type Bindings = CloudflareBindings & { JWT_SECRET: string };   // 避免与 Hono 内置 Env 撞名
const app = new OpenAPIHono<{ Bindings: Bindings }>();
```

## 4. 工程化：pnpm workspace 单仓

```
stratus-c2/
├─ pnpm-workspace.yaml        # packages: ["apps/*","workers/*","packages/*"]
├─ apps/web/                  # Vue3 SPA（Vite）
├─ workers/console/           # Hono /api/* + assets 托管 apps/web 产物
│   ├─ src/index.ts  ├─ public/（build 输出，git 忽略）  └─ wrangler.jsonc
├─ workers/gateway/           # 设备侧通道
└─ packages/shared/           # 共享 TS 类型 + zod schema + 常量
```

**共享包三种消费方式**（选一个，别混）：

| 方案 | 做法 | 优点 | 代价 |
|---|---|---|---|
| **A. 暴露源码（推荐）** | `exports` 指向 `src/*.ts`，两边 bundler 各自编译 | 零构建、改类型即时生效 | 消费方 `moduleResolution: "bundler"` |
| B. 预构建 d.ts | `tsc -b packages/shared` → `dist/` | 类型边界干净、可发包 | 改类型要重建，dev 需 `tsc -w` |
| C. Project References | `composite: true` + `references` | 增量类型检查快 | 配置复杂，Vite 仍需 alias |

```jsonc
// packages/shared/package.json
{ "name": "@stratus/shared", "type": "module",
  "exports": { ".": { "types": "./src/index.ts", "import": "./src/index.ts" },
               "./ui-tokens": { "types": "./src/ui-tokens.ts", "import": "./src/ui-tokens.ts" } },
  "dependencies": { "zod": "^4.6.7" } }
```

**选 A，所以不需要 `tsc -b`**：类型检查交给 `pnpm -r typecheck`（各包跑 `vue-tsc --noEmit`/`tsc --noEmit`），构建交给各自 bundler。

```ts
// apps/web/vite.config.ts
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: { alias: {
    "@": fileURLToPath(new URL("./src", import.meta.url)),
    "@stratus/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)) } },
  build: {
    outDir: "../../workers/console/public", emptyOutDir: true, sourcemap: true,
    rollupOptions: { output: { manualChunks: {
      vendor: ["vue", "vue-router", "pinia"], editor: ["@codemirror/view"], charts: ["echarts"] } } } },
  server: { port: 5173, proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: true, ws: true } } },
});
```

| 进程 | 端口 | 命令 |
|---|---|---|
| Vite dev | **5173** | `pnpm -F @stratus/web dev`（`/api`、`/ws` 代理到 8787） |
| console worker | **8787** | `pnpm -F @stratus/console dev`（本地模拟 D1/KV/DO） |
| gateway worker | **8788** | `pnpm -F @stratus/gateway dev --port 8788` |
| console 远程绑定 | 8787 | `wrangler dev --remote`（注意 50 routes/zone 上限） |

```jsonc
// 根 package.json
{ "scripts": {
  "dev": "pnpm -r --parallel --filter \"./workers/*\" --filter \"./apps/web\" dev",
  "build": "pnpm -F @stratus/web build",
  "typecheck": "pnpm -r typecheck",
  "deploy": "pnpm build && pnpm -F @stratus/console deploy && pnpm -F @stratus/gateway deploy" } }
```

> `pnpm --parallel` 日志交织、陌生人排障难：根 `dev` 只起 **web + console**，gateway 用 `pnpm dev:gateway` 单独起，README 写明"最小启动 = 1 条命令"。

**陌生人一键跑起来检查表**：`pnpm i` 无 peer 警告（组合钉死 + `peerDependencyRules` 显式允许）｜`.dev.vars.example` 列全 `JWT_SECRET`/`ADMIN_PASSWORD`/`PSK` 且 `.dev.vars` 进 `.gitignore`｜`wrangler d1 migrations apply --local` 一条命令建表｜默认 `admin/admin` 但 README 大红字要求改｜**不需要 Docker、不需要 CF 账号**（`wrangler dev` 全本地）。

## 5. WebSocket 前端工程实践

```ts
// apps/web/src/lib/ws.ts（要点版）—— 前置声明：type WsState = "connecting"|"open"|"reconnecting"|"closed";（Frame 定义见下方“多路复用帧”）
export function createSocket(url: string, o: { onFrame: (f: Frame) => void; onState: (s: WsState) => void; hb?: number }) {
  let ws: WebSocket | null = null, attempt = 0, byUser = false, lastPong = Date.now(), timer = 0;
  const backoff = () => Math.min(30_000, 500 * 2 ** attempt) * (1 + Math.random() * 0.3);  // 上限 30s + 30% 抖动
  const connect = () => {
    o.onState(attempt ? "reconnecting" : "connecting");
    ws = new WebSocket(url); ws.binaryType = "arraybuffer";
    ws.onopen = () => { attempt = 0; lastPong = Date.now(); o.onState("open");
      timer = window.setInterval(() => {
        if (Date.now() - lastPong > (o.hb ?? 25_000) * 3) return ws?.close();   // 三倍超时判死链
        ws?.send(JSON.stringify({ t: "ping", ts: Date.now() }));
      }, o.hb ?? 25_000); };
    ws.onmessage = (e) => { if (typeof e.data === "string") { const f = JSON.parse(e.data);
        if (f.t === "pong") return void (lastPong = Date.now()); o.onFrame(f); }
      else o.onFrame({ t: "bin", data: e.data }); };
    ws.onclose = () => { clearInterval(timer); if (byUser) return o.onState("closed");
      attempt++; o.onState("reconnecting"); setTimeout(connect, backoff()); };
    ws.onerror = () => ws?.close();
  };
  connect();
  return { send: (f: Frame) => ws?.readyState === 1 && ws.send(JSON.stringify(f)),
           close: () => { byUser = true; ws?.close(); } };
}
```

**心跳 25s** 是为了低于 Cloudflare 侧常见的 ~100s 空闲断连阈值；**退避上限 30s + 30% 抖动**避免服务端重启时全量雪崩。

**多路复用帧**（一个 WS 承载多会话）：

```ts
type Frame =
  | { t: "sub"; ch: string; from?: number } | { t: "unsub"; ch: string }
  | { t: "cmd"; ch: string; id: string; body: unknown }
  | { t: "data"; ch: string; seq: number; data: string }
  | { t: "ack"; ch: string; seq: number } | { t: "ping" | "pong"; ts?: number }
  | { t: "bin"; data: ArrayBuffer };
```

| 设计点 | 做法 |
|---|---|
| 通道 id | `ch = deviceId` 或 `deviceId:sessionId`，前端按 channel 分发到对应 store |
| 帧类型 | 高频帧用单字符 `t`（`c`/`d`/`a`/`p`），每帧省 5–10 字节 |
| 二进制 | 终端输出走二进制帧：首 4 字节 channel hash + 4 字节 seq |
| 解析 | 统一在 `@stratus/shared` 里 `switch(f.t)`，双端复用 |

**序号 + 断线补发**：服务端（DO）每 channel 维护 `ring[seq % 512]` + `lastAcked`；客户端记 `lastSeq`，重连首帧 `{t:"sub", ch, from: lastSeq}`；服务端重放 `seq > from`，超出窗口回 `{t:"gap"}` → 客户端降级"全量快照/整屏重绘"。

**背压**：`ws.bufferedAmount > 1 MiB` 时丢弃**可重建**的输出（终端可重绘），控制帧与 `cmd`/`ack` 永不丢；UI 显示"输出被截断，点击重绘"。

**xterm 数据流：ArrayBuffer vs base64**

| 维度 | ArrayBuffer（二进制帧） | base64（文本帧） |
|---|---|---|
| 体积 | 1.00× | **1.33×** + JSON 转义 |
| 解析 | `term.write(new Uint8Array(buf))` | `atob` + 逐字节转换，慢 3–10× |
| 二进制安全 | 天然安全 | 半个多字节 UTF-8 字符会被切碎 → 乱码 |
| 调试 | 差（看 hex） | 好（可直接打印） |

结论：`ws.binaryType = "arraybuffer"`，程序输出走二进制直通 xterm；只有"要留档/要复制"的路径才转 base64（分块 `btoa`，避免爆栈）。键盘输入量小，`term.onData(s => ws.send(new TextEncoder().encode(s)))` 用文本帧即可。

## 6. 大文件传输的前端方案

| 路线 | 链路 | 适合 | 注意 |
|---|---|---|---|
| **A. 前端直传 R2（S3 预签名）** | 浏览器 → R2；Worker 只签 URL | **推荐**，文件不过 Worker | R2 桶要配 CORS 放行 `PUT`；签名限 method/key/大小 |
| B. Worker 分片中转 | 浏览器 → Worker → R2 `put` | 无法配 CORS 时 | 受**域名套餐请求体上限**（Free/Pro 100 MB）；每片一次 invocation |
| C. Worker 编排 multipart | 前端传片、Worker `uploadPart` | 需逐片审计 | Class A 按片计费；Worker 内存 128 MB，别缓存整片 |

```ts
// apps/web/src/lib/upload.ts（要点：断点续传 = 每片落 IndexedDB）
const CHUNK = 8 * 1024 * 1024;                        // R2 multipart 最小 5 MiB，8 是折中
async function upload(file: File, key: string, api: Api) {
  const db = await openDb("uploads");
  const rec = (await db.get("parts", key)) ?? { uploadId: await api.createMultipart(key), parts: [] as Part[] };
  const total = Math.ceil(file.size / CHUNK);
  for (let i = rec.parts.length; i < total; i++) {    // 从断点继续
    const blob = file.slice(i * CHUNK, (i + 1) * CHUNK);
    const etag = await putWithProgress(await api.signPart(key, rec.uploadId, i + 1), blob);  // XHR upload.onprogress
    rec.parts.push({ partNumber: i + 1, etag });
    await db.put("parts", rec, key);                  // 每片一次持久化
  }
  await api.completeMultipart(key, rec.uploadId, rec.parts);
  await db.delete("parts", key);
}
```

| 关键点 | 值 |
|---|---|
| 分片 | 8 MiB（过小 → Class A 操作爆炸） |
| 并发 | 3–4 片（同域 HTTP/1.1 上限 6 连接） |
| 过期 | `uploadId` 有生命周期，超 7 天未完成就 `abortMultipart` 重来 |
| 校验 | 单片用 R2 返回的 `ETag`(MD5) + 完成时整体 SHA-256 |

**下载流式落盘**（三级降级，都不需要第三方库）：

```ts
async function download(url: string, filename: string) {
  const res = await fetch(url); if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  if ("showSaveFilePicker" in window) {                       // 1) File System Access API
    const h = await (window as any).showSaveFilePicker({ suggestedName: filename });
    return res.body.pipeTo(await h.createWritable());
  }
  if ("streamSaver" in window) {                              // 2) StreamSaver（Service Worker 中转）
    const w = (window as any).streamSaver.createWriteStream(filename).getWriter();
    return res.body.pipeTo(new WritableStream({ write: (c) => w.write(c) }));
  }
  location.href = url;                                        // 3) 302 直下 R2 预签名 URL
}
```

**校验**：`crypto.subtle.digest` 不支持流式（整块进内存）。≤100 MB 直接 `digest("SHA-256", await file.arrayBuffer())`；大文件按片算 hash 列表交服务端登记，**服务端以 R2 的 `ETag` + 总大小为准**（为流式 SHA-256 引 wasm 包 ≥60 KB gzip 不划算）。

## 7. 可访问性与暗色主题：一套变量喂两边

四条原则：① 颜色 token 只定义一次（`:root`）；② EP 的 `--el-*` 全部**映射**，不写死色值；③ 单一暗色开关 `useDark()` 写 `<html class="dark">`（EP 暗色用的就是它）；④ 对比度 ≥ 4.5:1、焦点环统一用 `--ring`、`prefers-reduced-motion` 关动画。

```css
@layer base {
  :root {
    --background: oklch(100% 0 0);   --foreground: oklch(21% .02 264);
    --card: oklch(100% 0 0);         --card-foreground: var(--foreground);
    --popover: oklch(100% 0 0);      --popover-foreground: var(--foreground);
    --primary: oklch(54% .19 264);   --primary-foreground: oklch(98% 0 0);
    --secondary: oklch(96% .005 264);--secondary-foreground: var(--foreground);
    --muted: oklch(96% .005 264);    --muted-foreground: oklch(55% .02 264);
    --accent: oklch(96% .01 264);    --accent-foreground: var(--foreground);
    --destructive: oklch(58% .22 27);--border: oklch(92% .005 264);
    --input: oklch(92% .005 264);    --ring: oklch(54% .19 264);  --radius: .5rem;

    /* ---- Element Plus → 映射到 shadcn token ---- */
    --el-color-primary: var(--primary);
    --el-color-primary-light-3: color-mix(in oklch, var(--primary) 70%, white);
    --el-color-primary-light-5: color-mix(in oklch, var(--primary) 50%, white);
    --el-color-primary-light-7: color-mix(in oklch, var(--primary) 30%, white);
    --el-color-primary-light-9: color-mix(in oklch, var(--primary) 12%, white);
    --el-color-primary-dark-2: color-mix(in oklch, var(--primary) 85%, black);
    --el-color-danger: var(--destructive);
    --el-bg-color: var(--background);      --el-bg-color-page: var(--secondary);
    --el-bg-color-overlay: var(--popover);
    --el-text-color-primary: var(--foreground);  --el-text-color-regular: var(--foreground);
    --el-text-color-secondary: var(--muted-foreground);
    --el-text-color-placeholder: var(--muted-foreground);
    --el-border-color: var(--border);      --el-border-color-light: var(--border);
    --el-border-color-lighter: var(--border);
    --el-border-radius-base: var(--radius);
    --el-border-radius-small: calc(var(--radius) - 2px);
    --el-fill-color-blank: var(--card);
    --el-mask-color: color-mix(in oklch, var(--foreground) 45%, transparent);
  }

  .dark {
    --background: oklch(18% .02 264);  --foreground: oklch(96% .005 264);
    --card: oklch(22% .02 264);        --card-foreground: var(--foreground);
    --popover: oklch(22% .02 264);     --popover-foreground: var(--foreground);
    --primary: oklch(66% .17 264);     --primary-foreground: oklch(18% .02 264);
    --secondary: oklch(26% .02 264);   --secondary-foreground: var(--foreground);
    --muted: oklch(26% .02 264);       --muted-foreground: oklch(70% .02 264);
    --accent: oklch(30% .02 264);      --accent-foreground: var(--foreground);
    --destructive: oklch(62% .2 27);   --border: oklch(30% .02 264);
    --input: oklch(30% .02 264);       --ring: oklch(66% .17 264);
    /* 暗色下 EP 的 light-* 派生色要往"更暗"混 */
    --el-color-primary-light-3: color-mix(in oklch, var(--primary) 70%, black);
    --el-color-primary-light-5: color-mix(in oklch, var(--primary) 50%, black);
    --el-color-primary-light-7: color-mix(in oklch, var(--primary) 30%, black);
    --el-color-primary-light-9: color-mix(in oklch, var(--primary) 12%, black);
    --el-fill-color-blank: var(--card);
  }

  html { color-scheme: light; }  html.dark { color-scheme: dark; }
  :where(a,button,input,select,textarea,[tabindex]):focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { *,*::before,*::after { animation-duration: .01ms !important; transition-duration: .01ms !important; } }
}
```

```ts
// apps/web/src/composables/useTheme.ts —— 一个开关同时喂 shadcn 与 EP
export const isDark = useDark({ selector: "html", attribute: "class", valueDark: "dark", valueLight: "" });
export const toggleDark = useToggle(isDark);
```

要点：用 `oklch` + `color-mix` 让 EP 的 `light-3/5/7/9` 派生色自动跟随；**不要再手动给 EP 加删 `dark` 类**；EP 的 `dark/css-vars.css` 仍要引（提供它自身的结构性变量），你的映射必须写在它**后面**才能覆盖。

## 8. 最终选型建议

| 页面 / 区域 | 用哪套 | 理由 |
|---|---|---|
| App Shell（侧栏、顶栏、面包屑、命令面板） | shadcn-vue | Tailwind 直写布局，改样式不用 `:deep()` 穿透 |
| 设备/会话列表 | shadcn-vue `DataTable`（TanStack Table） | 列定义是 TS，与 `@stratus/shared` 类型天然对齐 |
| 大表格（日志、任务历史、文件清单） | **vxe-table** | 万行虚拟滚动、列宽拖拽、服务端分页；`el-table` 千行即卡 |
| 终端页 | 自研布局 + shadcn Tabs/Splitter | 终端不需要组件库 |
| 复杂表单（策略、cron、批量下发） | **Element Plus** | `el-form` 校验、`el-date-picker`、`el-cascader`、`el-transfer` 最省事 |
| 仪表盘 | **ECharts 6**（按需注册） | 可维护性最好 |
| 结果查看器 | **CodeMirror 6**；需跳转定义才上 Monaco | Monaco 体积不可控 |
| 通知/弹窗/确认 | shadcn-vue（Toast/Dialog/AlertDialog） | 保持一套交互语言 |

**硬规则**：EP 只允许出现在 `pages/**/ep-*.vue`，且必须 `defineAsyncComponent(() => import(...))` 路由级懒加载——
既保证 EP 的 JS/CSS 不进首屏 chunk，也把 §2 的层叠冲突影响面缩到一个文件集里。

| 打包项 | gzip 估算 |
|---|---|
| vue + vue-router + pinia | **84 KB**（46.2 + 13.0 + 25.0 实测） |
| @tanstack/vue-query | 13 KB |
| shadcn-vue 壳（约 20 个组件按需） | 22 KB（reka-ui 全量 184 KB，按需后大降） |
| Tailwind 产出 CSS + 主题变量 | 11–17 KB |
| **首屏合计** | **≈ 130–140 KB** ✅ |
| ECharts（core + line/bar/pie） | 95–120 KB |
| Element Plus（按需 5–8 组件 + 样式） | 60–90 KB（全量 291 KB） |
| vxe-table（table + grid 按需） | 90 KB（估算） |
| CodeMirror 6（view + state + json） | 95 KB |
| xterm + fit | 66 KB |
| Monaco（懒加载，永不进主包） | 300–500 KB |

```ts
// apps/web/src/router/index.ts —— 分包边界
const routes = [
  { path: "/", component: () => import("@/pages/Dashboard.vue") },
  { path: "/devices", component: () => import("@/pages/Devices.vue") },
  { path: "/terminal/:id", component: () => import("@/pages/Terminal.vue") },   // xterm
  { path: "/files", component: () => import("@/pages/Files.vue") },            // R2 上传下载
  { path: "/policy", component: () => import("@/pages/ep/PolicyForm.vue") },   // Element Plus 岛
  { path: "/ide", component: () => import("@/pages/CodeWorkbench.vue") },      // Monaco
];
```

> 一句话：**壳用 shadcn-vue（可控、暗色即插即用），重组件用 Element Plus + vxe-table（省人力），两者靠「变量映射 + `@layer` 包裹 + 层级 token + 路由级懒加载」共存；Hono 4 单 Worker（`assets` + `/api/*`）同时承载 SPA 与 API；共享类型走 `packages/shared` 源码导出，全仓 `pnpm i && pnpm dev` 能跑。**

## 附：参考链接

Vue https://vuejs.org/guide/ ｜ Vite https://vite.dev/guide/ ｜ Tailwind v4 升级/分层 https://tailwindcss.com/docs/upgrade-guide ｜ Preflight https://tailwindcss.com/docs/preflight
shadcn-vue 安装 https://www.shadcn-vue.com/docs/installation/vite ｜ 主题 https://www.shadcn-vue.com/docs/theming ｜ reka-ui https://reka-ui.com
Element Plus 暗色 https://element-plus.org/en-US/guide/dark-mode.html ｜ 自定义命名空间 https://element-plus.org/en-US/guide/namespace.html
Pinia https://pinia.vuejs.org ｜ Vue Router https://router.vuejs.org ｜ TanStack Query/Vue https://tanstack.com/query/latest/docs/framework/vue/overview ｜ VueUse https://vueuse.org
xterm.js https://xtermjs.org ｜ CodeMirror 6 https://codemirror.net/docs/ ｜ Monaco https://microsoft.github.io/monaco-editor/ ｜ ECharts 按需 https://echarts.apache.org/handbook/en/basics/import/ ｜ vxe-table https://vxetable.cn
Hono Workers https://hono.dev/docs/getting-started/cloudflare-workers ｜ `@hono/zod-openapi` https://github.com/honojs/middleware/tree/main/packages/zod-openapi ｜ Scalar https://github.com/scalar/scalar/tree/main/packages/hono-api-reference
Workers Static Assets SPA https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/ ｜ wrangler 配置 https://developers.cloudflare.com/workers/wrangler/configuration/ ｜ `wrangler types` https://developers.cloudflare.com/workers/wrangler/commands/
R2 分片上传 https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/ ｜ File System Access API https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API ｜ StreamSaver.js https://github.com/jimmywarting/StreamSaver.js
