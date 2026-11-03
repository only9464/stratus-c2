# 第三方组件与设计参考声明

本项目的代码为自研（MIT）。以下是**运行时依赖**与**设计参考**，二者严格区分。

## 一、运行时依赖（npm / Go）

### 后端（Workers）

| 组件 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| [hono](https://github.com/honojs/hono) | ^4.13 | MIT | HTTP 路由框架 |
| [drizzle-orm](https://github.com/drizzle-team/drizzle-orm) | ^0.45 | Apache-2.0 | D1 ORM |
| [drizzle-kit](https://github.com/drizzle-team/drizzle-kit-mirror) | ^0.31 | MIT | 迁移生成（dev） |
| [wrangler](https://github.com/cloudflare/workers-sdk) | ^4.156 | MIT OR Apache-2.0 | 部署工具（dev） |
| [@cloudflare/workers-types](https://github.com/cloudflare/workers-types) | ^5 | MIT OR Apache-2.0 | 类型（dev） |

### 前端

| 组件 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| [vue](https://github.com/vuejs/core) | ^3.5 | MIT | 框架 |
| [vue-router](https://github.com/vuejs/router) | ^4.6 | MIT | 路由 |
| [pinia](https://github.com/vuejs/pinia) | ^3.0 | MIT | 状态 |
| [element-plus](https://github.com/element-plus/element-plus) | ^2.14 | MIT | 重型表格/表单控件 |
| [tailwindcss](https://github.com/tailwindlabs/tailwindcss) | ^4.3 | MIT | 原子化样式 |
| [class-variance-authority](https://github.com/joe-bell/cva) / [clsx](https://github.com/lukeed/clsx) / [tailwind-merge](https://github.com/dcastil/tailwind-merge) | — | MIT | shadcn 风格组件工具 |
| [vite](https://github.com/vitejs/vite) / [@vitejs/plugin-vue](https://github.com/vitejs/vite-plugin-vue) | ^7.3 / ^6 | MIT | 构建（dev） |

> `pnpm licenses list` 可复核全部传递依赖的许可证。

### Go 参考植入体

**无第三方依赖**（纯标准库）。HKDF 为手写实现（RFC 5869，约 25 行）。

## 二、设计参考（未复制代码）

| 项目 | 许可证 | 我们借鉴了什么 |
|---|---|---|
| [VShell](https://github.com/veo/vshell) | 现已闭源；早期仓库**无授权许可** | 只参考其**公开讨论中的功能面与工程取舍**（通道注册表、载荷"链接即形态"、隧道实体化、批量操作）。**未复制**任何代码、协议常量（帧码）、前端资源或线格式；本项目协议帧类型（`hello`/`cmd`/`res`…）与加密方案均为独立设计。 |
| [Rshell](https://github.com/Rubby2001/Rshell---A-Cross-Platform-C2) | MIT | 参考其"多协议监听器抽象"与前端页面组织方式；未复制代码。 |
| [Rshell-web](https://github.com/Rubby2001/Rshell-web) | MIT | 参考其 Vue 前端的目录结构与交互模式；未复制代码。 |
| [ToShell](https://github.com/iQingshan/Toshell) | MIT | 参考其"能力位驱动 UI"、"结果外置成句柄"、"破坏性动作分级 + 禁自动重投"、"审计不含参数原文"等**设计结论**；未复制代码。 |

三份本地分析参见 [docs/01-research/03-local-repo-analysis.md](./docs/01-research/03-local-repo-analysis.md)。

## 三、协议与算法

| 项 | 说明 |
|---|---|
| AES-256-GCM | NIST SP 800-38D，标准算法，无自研改动 |
| HKDF-SHA256 | RFC 5869 |
| ECDH P-256 | SEC 2 / NIST P-256，通过各语言标准库实现 |
| 帧格式 / AAD / 令牌格式 | **本项目原创**，定义见 `docs/03-protocol/01-envelope.md` |

## 四、不使用的东西

- 不使用 UPX、不使用任何商业 C2 的组件、不打包任何内核驱动；
- 不引入"免杀框架"或"AV 对抗库"——载荷工程属于使用者自己的范畴；
- 不复制任何闭源产品的品牌、文案、图标或界面。
