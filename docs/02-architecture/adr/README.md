# 架构决策记录（ADR）

> 每条 ADR 只回答四件事：**背景、决定、代价、什么时候该推翻它**。
> 新增 ADR 用 `NNNN-短横线标题.md`，编号只增不减。

| 编号 | 标题 | 状态 |
|---|---|---|
| [0001](./0001-two-workers.md) | 拆成 edge / console 两个 Worker | 已接受 |
| [0002](./0002-do-per-session.md) | 每个会话一个 Durable Object | 已接受 |
| [0003](./0003-e2e-zero-knowledge.md) | 端到端加密，服务端零知识 | 已接受 |
| [0004](./0004-p256-over-x25519.md) | 用 P-256 而不是 X25519 | 已接受 |
| [0005](./0005-http-beacon-fallback.md) | HTTP 轮询作为兜底而不是主通道 | 已接受 |
| [0006](./0006-drizzle-orm.md) | 用 Drizzle ORM 而不是手写 SQL | 已接受 |
