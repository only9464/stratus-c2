# ADR-0001：拆成 edge / console 两个 Worker

- 状态：已接受（2026-11）
- 影响面：部署拓扑、绑定、发布流程

## 背景

单 Worker 也能同时提供"植入体端点"和"控制台 API + SPA"：Hono 里挂两套路由即可。
但这样会把两类完全不同风险的流量塞进同一个执行上下文与同一个错误面板。

## 决定

拆成两个 Worker：

- `stc2-edge`：`c2.example.com`，全世界可打，只有植入体端点 + 诱饵；
- `stc2-console`：`ops.example.com`，只给操作员，可套 Cloudflare Access。

`SessionDO` / `HubDO` 定义在 edge（migrations 只能在那里跑），console 通过
`durable_objects.bindings[].script_name = "stc2-edge"` 绑定同一批 DO 类。

## 代价

| 代价 | 说明 |
|---|---|
| 多一次部署 | `deploy:edge` 必须在 `deploy:console` 之前（否则 DO 类找不到） |
| 跨 Worker 调用要 service binding | 同 zone 的 `fetch()` 到另一个 Worker 会失败，必须用 binding 或 Custom Domain |
| 两份 `wrangler.jsonc` | 占位符要同步改（D1/KV id） |
| 日志分两处 | `wrangler tail` 要开两个终端（或用 `--name` 区分） |

## 什么情况下推翻

- 免费计划的 **100 个 Worker 上限**成为约束（不可能，只用 2 个）；
- 需要"单次请求同时处理植入体与控制台"（不存在这种场景）；
- 想把控制台也放到 `workers.dev` 上做零配置试用（那时可以合并成一个，但仍需 `AUTH_MODE=token`）。
