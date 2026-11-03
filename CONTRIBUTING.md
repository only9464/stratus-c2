# 贡献指南

感谢愿意一起把这套"无服务器 C2"做扎实。动手前请先读这三份，能省你很多来回：

1. [平台限额调研](./docs/01-research/01-cloudflare-platform-limits.md) —— 哪些事在 CF 上根本做不到
2. [总体架构](./docs/02-architecture/01-system-architecture.md) —— 为什么是两个 Worker、每会话一个 DO
3. [密码学设计](./docs/02-architecture/03-crypto-design.md) —— 为什么服务端不能解密（这条不接受"为了方便"而改）

## 环境

```bash
node -v        # >= 20
pnpm -v        # 10.x
go version     # 只有改 clients/go 才需要（>= 1.22）
```

## 本地开发

```bash
pnpm i
pnpm build                 # 构建前端（console worker 的 assets 从这里来）
pnpm typecheck             # 全仓类型检查（含 vue-tsc）
pnpm test                  # shared 的协议/密码学单测

# 三个终端
pnpm dev:web               # 5173  Vite
pnpm dev:console           # 8788  控制台（先跑一次 db:migrate:local）
pnpm dev:edge               # 8787  植入体平面
```

`.dev.vars`（**不要提交**）：

```ini
AUTH_MODE=dev
ADMIN_TOKEN=dev-token
AUTH_SECRET=dev-secret
```

## 提交前自检

```bash
pnpm typecheck && pnpm test && pnpm build
# 改了 workers/*：额外跑一次打包验证（不需要账号）
npx wrangler deploy --dry-run --outdir .wrangler/tmp -c workers/gateway/wrangler.jsonc
npx wrangler deploy --dry-run --outdir .wrangler/tmp -c workers/console/wrangler.jsonc
```

## 代码约定

| 位置 | 约定 |
|---|---|
| `packages/shared` | **协议与密码学的唯一真源**。改帧格式 = 改这里 + 改 `docs/03-protocol` + 补测试用例 |
| `packages/db` | schema 是 D1 的唯一真源；改表 → `pnpm --filter @stratus/db generate` → 提交迁移 |
| `workers/*` | 只用 Hono + Drizzle；**禁止**在请求路径里做超过 5 ms 的 CPU 工作（免费计划 10 ms） |
| `apps/web` | 外壳用 tailwind + 本地 shadcn 风格组件；重表格/表单用 Element Plus（放 `<el-scope>` 容器里） |
| `clients/*` | 必须**只用标准库**（或明确列出的最小依赖），保证别人能直接编译 |

## 三条硬规则

1. **服务端不许解密**。任何"服务端要读一眼内容"的需求（搜索、过滤、统计命令类型）都只能退化成
   "服务端看粗分类"。要反对这条请在 issue 里先讨论，别直接提交代码。
2. **不引第三方 UI 框架的全局样式**。Element Plus 的 CSS 已经在 `main.ts` 里限定了加载顺序，
   不要改成"按需 + preflight 后置"，会把 shadcn 组件打坏（见 [前端设计](./docs/05-frontend/01-design-system.md) §3）。
3. **默认 fail-closed**。未知通道、未知任务类型、缺绑定、schema 不匹配 —— 一律报错/拒绝，
   不要"回退到能跑"。

## 提交信息

```
<type>(<scope>): <subject>

type: feat | fix | docs | refactor | test | chore | perf
scope: gateway | console | shared | db | web | client-go | docs
```

例：`feat(shared): add per-direction nonce counter validation`

## 文档改动

- 改了行为 → 同一次提交里改对应文档（文档漂移比没文档更糟）。
- 新增功能 → 在 `README.zh-CN.md` 的功能状态表里如实标注 ✅/🟡/❌，**不许只写 ✅**。
- 引用别人的项目 → 只能"吸收设计"，不复制代码/协议常量/前端资源（见 `THIRD-PARTY-NOTICES.md`）。

## 安全与合规

- 只接受"授权演练"场景的 issue；贴真实目标数据前先脱敏。
- 发现本项目的安全缺陷走 [SECURITY.md](./SECURITY.md)，不要开 public issue。
