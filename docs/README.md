# 文档索引

> 阅读顺序建议：**01 调研 → 02 架构 → 03 协议 → 04 客户端 → 05 前端 → 06 运维**。
> 每篇都能单独看，但"为什么这么设计"的答案基本都在 01 和 02。

## 00 · 起点

| 文档 | 说明 |
|---|---|
| [../README.zh-CN.md](../README.zh-CN.md) | 项目总览、功能状态表、快速开始 |
| [00-overview.md](./00-overview.md) | 一页纸：这套东西是什么、不是什么 |

## 01 · 调研（决定设计的事实）

| 文档 | 你要从中拿走什么 |
|---|---|
| [01-cloudflare-platform-limits.md](./01-research/01-cloudflare-platform-limits.md) | 免费额度的**具体数字**与 8 条硬约束；100 会话预算 |
| [02-vshell-feature-matrix.md](./01-research/02-vshell-feature-matrix.md) | VShell 有什么、哪些在 CF 上必须砍 |
| [03-local-repo-analysis.md](./01-research/03-local-repo-analysis.md) | Rshell/Rshell-web/ToShell 的做法与坑（24 借鉴 + 18 反面） |
| [04-frontend-stack.md](./01-research/04-frontend-stack.md) | Vue3 + shadcn-vue + Element Plus 的版本矩阵与坑 |
| [05-prior-art.md](./01-research/05-prior-art.md) | CF 上做 C2 的既有实践、封号案例、通道模式对比 |

## 02 · 架构（为什么这么做）

| 文档 | 内容 |
|---|---|
| [01-system-architecture.md](./02-architecture/01-system-architecture.md) | 组件、平面、时序、请求预算 |
| [02-data-model.md](./02-architecture/02-data-model.md) | D1/DO/KV/R2 的表与读写纪律 |
| [03-crypto-design.md](./02-architecture/03-crypto-design.md) | 密钥层级、AAD、握手、校验清单 |
| [04-transport-channels.md](./02-architecture/04-transport-channels.md) | WS hibernation、轮询、R2 死信箱、DoH |
| [05-threat-model.md](./02-architecture/05-threat-model.md) | 防谁/不防谁、账号被盗会怎样 |
| [adr/](./02-architecture/adr/README.md) | 架构决策记录（ADR-0001~0006） |

## 03 · 协议（写客户端/写后端都看这个）

| 文档 | 内容 |
|---|---|
| [01-envelope.md](./03-protocol/01-envelope.md) | L1/L2 帧、seq、nonce、AAD、合批 |
| [02-client-ingress-api.md](./03-protocol/02-client-ingress-api.md) | 植入体侧端点与示例 |
| [03-admin-api.md](./03-protocol/03-admin-api.md) | 控制台 REST/WS |
| [04-task-catalog.md](./03-protocol/04-task-catalog.md) | 任务类型、状态机、破坏性分级 |
| [05-errors.md](./03-protocol/05-errors.md) | 错误码、重试策略、关闭码 |
| [06-auth-and-rbac.md](./03-protocol/06-auth-and-rbac.md) | 三种认证模式、角色矩阵、密钥生命周期 |
| [openapi.yaml](./03-protocol/openapi.yaml) | 机器可读的 API 定义（控制台 `/api/v1/openapi.json` 是它的运行时子集） |

## 04 · 客户端

| 文档 | 内容 |
|---|---|
| [01-implant-spec.md](./04-client/01-implant-spec.md) | **语言无关**实现规范 + 各语言密码学对照 |
| [../clients/go/README.md](../clients/go/README.md) | Go 参考植入体（标准库、可编译） |

## 05 · 前端

| 文档 | 内容 |
|---|---|
| [01-design-system.md](./05-frontend/01-design-system.md) | 主题桥接、组件清单、WS 客户端、体积预算 |
| [02-pages.md](./05-frontend/02-pages.md) | 页面清单与每个页面的关键交互 |

## 06 · 运维

| 文档 | 内容 |
|---|---|
| [01-deployment.md](./06-operations/01-deployment.md) | 从零部署、加固、回滚、清理 |
| [02-quota-and-cost.md](./06-operations/02-quota-and-cost.md) | 额度怎么算、什么时候该上付费 |
| [03-runbook.md](./06-operations/03-runbook.md) | 演练中的事故处置 |
| [04-troubleshooting.md](./06-operations/04-troubleshooting.md) | 1102 / 1027 / 1016 与常见坑 |

## 维护约定

- 改协议 → 改 `03-protocol` + `packages/shared/src/frames.ts` + 单测，三处同时改。
- 改表 → 改 `packages/db/src/schema.ts` → `pnpm --filter @stratus/db generate` → 提交迁移 → 更新 `03-data-model`。
- 改配额口径 → 改 `packages/shared/src/limits.ts` 与 `01-research/01-*` 的 §11，并在 `CHANGELOG` 记一笔。
