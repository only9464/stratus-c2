# 路线图

> 排序依据：**能不能让一次真实演练跑完**，而不是功能数量。P0 不做完，其它都往后放。

## v0.1（已发布）

- [x] 平台限额调研 + 架构定稿（两个 Worker、每会话一个 DO、E2E 零知识）
- [x] L1/L2 信封、去重窗口、AAD 绑定
- [x] edge/console 两个 Worker 的主体端点
- [x] D1 schema + Drizzle + 迁移
- [x] 控制台 UI（会话/任务/载荷/密钥/审计/配额）
- [x] Go 参考植入体（HTTP beacon）

## v0.2 —— 让主通道真正可用（P0）

- [ ] **参考植入体实现 WS 主通道**（gorilla/websocket 或自写帧层），心跳用固定串走自动应答
- [ ] 结果分页回读：>4 KB 的外置结果在控制台按 64 KB 分页拉取 + 前端流式解密
- [ ] 文件分片全链路：`file.download_start` → `PUT /v1/file` → R2 → 控制台下载（含断点续传）
- [ ] 交互式 shell：`io` 帧 + 前端终端（先做"命令-回显"对，再上 PTY）
- [ ] 任务状态机补齐：`dispatched → running → done` 的 ACK 路径与超时重投（破坏性任务除外）
- [ ] 控制台 WS 实时化：任务状态与会话上下线不再轮询

## v0.3 —— 运营能力（P1）

- [ ] 操作员密钥管理完整版：加密备份导出/导入（PKCS#8 + PBKDF2 包裹）
- [ ] 角色落地：`viewer/operator/admin` 的路由元数据授权 + 前端按角色隐藏
- [ ] 审计导出（CSV/JSONL）与按会话聚合视图
- [ ] 配额守卫：接近阈值时自动降级（拉长 `next`、拒绝大任务）并在 UI 弹警告
- [ ] Cron：结果/文件/屏幕的 TTL 清理 + 配额日报落 `quota_daily`
- [ ] 载荷一键配置：把 `config.json` 与 ldflags 命令一起生成（复制即用）

## v0.4 —— 内网与隐蔽（P2，都有硬限制）

- [ ] SOCKS5 pivot：植入体侧监听 + 操作员本机 `stc2 proxy`（loopback）+ 帧复用
- [ ] 端口转发（应用层，非 TCP 隧道——平台做不到）
- [ ] DoH TXT 兜底通道（需要 `CF_DNS_TOKEN`，只做单向下发）
- [ ] 屏幕截图（单帧走 R2）；屏幕流最多 2 fps，明确写"不是视频"
- [ ] 多跳中继（A 会话转发给 B 会话，明码标价"每跳都吃 DO 请求"）

## v1.0 —— 给别人用

- [ ] 端到端测试：`wrangler dev` 起两个 Worker + 跑通注册/任务/结果/文件
- [ ] 一键部署脚本（`scripts/deploy.sh`）与 `wrangler` 版本兼容矩阵
- [ ] 文档站（VitePress）与 OpenAPI 完整化（`@hono/zod-openapi` 生成）
- [ ] 兼容性矩阵：Windows/Linux/macOS × Go/Rust/C# 各一份可编译的最小植入体
- [ ] 安全审计清单（自查 + 外部复核）

## 明确不做

| 不做 | 原因 |
|---|---|
| UDP / KCP / QUIC / MQTT 通道 | 平台无 UDP；MQTT 需要 broker（= 自建服务器） |
| 域前置 | Cloudflare 对 SNI≠Host 直接 421 |
| 通用代理 / VPN 用途 | 违反 CF 自营条款，实测封号 |
| 服务端解密/搜索明文 | 破坏零知识，且吃不起 CPU 预算 |
| 服务端编译载荷 | Workers 无子进程/工具链 |
| 与 VShell 协议互通 | 无授权依据，且会把错误码体系绑死 |
| 内置免杀 / 反 EDR | 属于载荷工程，与本框架协议无关；只提供"接入点" |
