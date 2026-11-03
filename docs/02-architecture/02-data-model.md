# 02-02 · 数据模型（D1 / DO / KV / R2）

> 原则：**D1 是账本，DO 是会话状态，KV 是令牌与配置，R2 是内容**。
> 免费额度：D1 500 MB/库、5M 行读/天、100k 行写/天；KV 1,000 写/天；R2 10 GB-month。所有表结构都为这三个数字服务。

---

## 1. 存储职责划分

| 存储 | 放什么 | 不放什么 |
|---|---|---|
| **D1**（`stc2-core`） | 会话、任务、结果索引、文件索引、审计、操作员、载荷、配额日报 | 文件内容、屏幕帧、大结果正文 |
| **DO SQLite**（每会话） | 未 ACK 任务、去重窗口、GCM nonce 计数器、在线连接元数据 | 任何需要跨会话查询的东西 |
| **KV** | 一次性下载令牌（TTL）、公钥缓存、引导配置、特性开关 | 任务队列、任何"每心跳写一次"的东西 |
| **R2** | 载荷二进制、文件分片、大结果、屏幕帧 | 需要事务的数据 |

**环境隔离**：所有 R2 key 以 `{env}/` 开头（`prod/`、`lab/`），D1 用一张 `settings` 表里的 `env` 字段标记，避免"测试数据混进生产报表"。

---

## 2. ER 概览

```
operators ──1:N── operator_keys
    │
    └──1:N── audit_log

payloads ──1:N── sessions ──1:N── tasks ──1:1── task_results
                     │                 │
                     ├──1:N── files ──1:N── file_chunks
                     ├──1:N── screens
                     └──1:N── pivot_rules

settings / quota_daily / notes  （独立）
```

---

## 3. 表定义

### 3.1 `settings`

```sql
CREATE TABLE settings (
  k           TEXT PRIMARY KEY,           -- 例如 'env' / 'retention_days' / 'auth_mode'
  v           TEXT NOT NULL,
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
```

用途：运行时开关（不改代码就能改行为）。写入极少（每次运维操作 1 行）。

### 3.2 `operators`

```sql
CREATE TABLE operators (
  id            TEXT PRIMARY KEY,          -- b64u(12B)
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'operator',  -- admin|operator|viewer
  password_hash TEXT,                      -- PHC 字符串；access 模式下为 NULL
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_login_at INTEGER
);
```

> `password_hash` 只在 `AUTH_MODE=token` 且启用了口令登录时使用；哈希算法见 [06-auth-and-rbac](../03-protocol/06-auth-and-rbac.md)。**免费计划 10 ms CPU 下不建议开 PBKDF2 登录**（见架构文档 §8）。

### 3.3 `operator_keys`

```sql
CREATE TABLE operator_keys (
  id          TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  key_id      TEXT NOT NULL,               -- b64u(8B)，载荷配置里引用它
  pub_raw     TEXT NOT NULL,               -- b64u(65B) 未压缩 P-256 点
  fp          TEXT NOT NULL,               -- SHA256(pub_raw) 前 8 字节 hex
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  revoked_at  INTEGER,
  UNIQUE (operator_id, key_id)
);
CREATE INDEX idx_operator_keys_fp ON operator_keys(fp);
```

### 3.4 `payloads`

```sql
CREATE TABLE payloads (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  psk_id      TEXT NOT NULL UNIQUE,        -- b64u(8B)，载荷里带
  k_reg       TEXT NOT NULL,               -- b64u(32B)，HKDF(psk,"stc2/v1/reg")
  k_sess      TEXT NOT NULL,               -- b64u(32B)，HKDF(psk,"stc2/v1/sess")
  os          TEXT,                        -- windows|linux|darwin
  arch        TEXT,                        -- amd64|arm64|386
  r2_key      TEXT,                        -- 二进制在 R2 的位置
  size        INTEGER,
  sha256      TEXT,
  note        TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at  INTEGER,                     -- 下载链接过期
  revoked_at  INTEGER
);
CREATE INDEX idx_payloads_created ON payloads(created_at DESC);
```

**为什么存 `k_reg`/`k_sess` 而不是 `psk`**：网关要验 HMAC、要发会话令牌，必须能算出这两个 key。存派生值的好处是：即便 D1 泄露，攻击者也拿不到原始 PSK（无法反推），只能冒充该载荷注册新会话。**代价已写入威胁模型。**

### 3.5 `sessions`

```sql
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,          -- sid, b64u(16B)
  payload_id    TEXT REFERENCES payloads(id),
  host          TEXT,
  username      TEXT,
  os            TEXT,
  arch          TEXT,
  pid           INTEGER,
  internal_ip   TEXT,
  external_ip   TEXT,
  asn           TEXT,
  country       TEXT,
  caps          TEXT,                      -- JSON 数组：["shell","file","screen",...]
  implant_pub   TEXT,                      -- b64u(65B) 本会话的 ECDH 公钥
  owner_key_id  TEXT,                      -- 用哪把操作员公钥（默认团队 key）
  status        TEXT NOT NULL DEFAULT 'online',  -- online|offline|dead|quarantined
  note          TEXT,
  tags          TEXT,                      -- JSON 数组
  first_seen    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen     INTEGER NOT NULL DEFAULT (unixepoch()),
  closed_at     INTEGER
);
CREATE INDEX idx_sessions_status_seen ON sessions(status, last_seen DESC);
CREATE INDEX idx_sessions_payload ON sessions(payload_id);
```

`status` 语义：`online` = 最近 3 个心跳内；`offline` = 超时但未吊销；`dead` = 操作员主动注销或自毁确认；`quarantined` = 触发风控（例如同 sid 多 IP 高频切换）。

### 3.6 `tasks`

```sql
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  operator_id   TEXT REFERENCES operators(id),
  rid           TEXT,                      -- 请求 ID（回显关联，b64u(8B)）
  cat           TEXT NOT NULL,             -- 粗分类：exec|file|shell|screen|pivot|system
  status        TEXT NOT NULL DEFAULT 'queued',  -- queued|dispatched|running|done|failed|expired|canceled
  size          INTEGER,                   -- 密文字节数（不含帧头）
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  dispatched_at INTEGER,
  completed_at  INTEGER,
  expires_at    INTEGER,
  err           TEXT
);
CREATE INDEX idx_tasks_session_created ON tasks(session_id, created_at DESC);
CREATE INDEX idx_tasks_status ON tasks(status, created_at);
```

> `cat` 是**故意保留的元数据泄露**（为了让列表页能筛选/图标化）。要彻底零元数据就设 `METADATA_MODE=none`，此时 `cat` 写 `'e2e'`、`size` 仍然保留（否则无法做配额控制）。

### 3.7 `task_results`

```sql
CREATE TABLE task_results (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,
  inline_ct   TEXT,                        -- ≤ 4 KB 时直接内联（b64u）
  r2_key      TEXT,                        -- > 4 KB 时外置
  nonce       TEXT,                        -- b64u(12B)，解密必需（参与 AAD）
  rid         TEXT,                        -- 请求 ID，解密必需（参与 AAD）
  size        INTEGER NOT NULL,
  sha256      TEXT,
  truncated   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_results_task ON task_results(task_id);
CREATE INDEX idx_results_created ON task_results(created_at DESC);
```

> `nonce` 与 `rid` 必须随密文一起存：它们参与 AAD，缺一个就解不开。服务端存这两个值**不构成内容泄露**
> （它们已经在 L1 帧的明文字段里）。

**为什么阈值是 4 KB**：D1 单行上限 2 MB，但行越大写放大越严重；4 KB 是"一次写不心疼、两次读能接受"的经验值。

### 3.8 `files` / `file_chunks`

```sql
CREATE TABLE files (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  direction     TEXT NOT NULL,             -- up（植入体→云端）| down（云端→植入体）
  path          TEXT,                      -- 远端路径（明文会泄露路径 → 可选加密，见 METADATA_MODE）
  name          TEXT,
  size          INTEGER,
  sha256        TEXT,
  status        TEXT NOT NULL DEFAULT 'open',  -- open|complete|failed|deleted
  r2_prefix     TEXT NOT NULL,
  chunks_total  INTEGER NOT NULL DEFAULT 0,
  chunks_done   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_files_session ON files(session_id, created_at DESC);

CREATE TABLE file_chunks (
  transfer_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  sha256      TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (transfer_id, idx)
);
```

**分片策略**：4 MiB/片（`CHUNK_SIZE` 常量）。理由：远小于 100 MB 请求上限与 DO 的 100 MiB 出站上限；断点续传粒度合适；单文件 1 GB = 256 行 `file_chunks`，在 10 万行写/天里可接受。

### 3.9 `screens`

```sql
CREATE TABLE screens (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  r2_key     TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  size       INTEGER,
  width      INTEGER,
  height     INTEGER,
  format     TEXT DEFAULT 'jpeg'
);
CREATE INDEX idx_screens_session ON screens(session_id, ts DESC);
```

### 3.10 `pivot_rules`

```sql
CREATE TABLE pivot_rules (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,               -- socks5|portfwd
  listen_host TEXT,                        -- 操作员本机（stc2 proxy 用）
  listen_port INTEGER,
  target_host TEXT,
  target_port INTEGER,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
```

> 注意：真正的监听在**操作员本机**（`stc2 proxy`）或**植入体侧**；这张表只是配置与审计记录。服务端无法监听端口。

### 3.11 `audit_log`

```sql
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL DEFAULT (unixepoch()),
  actor_type  TEXT NOT NULL,               -- operator|implant|system
  actor_id    TEXT,
  action      TEXT NOT NULL,               -- task.create / payload.revoke / session.kill ...
  target      TEXT,                        -- session id / payload id / key id
  request_id  TEXT,
  ip          TEXT,
  meta        TEXT                         -- JSON（**不含命令明文**）
);
CREATE INDEX idx_audit_ts ON audit_log(ts DESC);
CREATE INDEX idx_audit_target ON audit_log(target, ts DESC);
```

### 3.12 `quota_daily`

```sql
CREATE TABLE quota_daily (
  day            TEXT PRIMARY KEY,          -- YYYY-MM-DD (UTC)
  workers_req    INTEGER DEFAULT 0,
  do_req         INTEGER DEFAULT 0,
  d1_rows_read   INTEGER DEFAULT 0,
  d1_rows_write  INTEGER DEFAULT 0,
  kv_write       INTEGER DEFAULT 0,
  r2_class_a     INTEGER DEFAULT 0,
  r2_class_b     INTEGER DEFAULT 0,
  r2_bytes       INTEGER DEFAULT 0,
  notes          TEXT
);
```

由 Cron 每天写一次（1 行），控制台"配额水位"页读它。

---

## 4. DO（SessionDO）内部表

```sql
-- 每个 SessionDO 一个 SQLite 实例
CREATE TABLE IF NOT EXISTS pending (
  tid        TEXT PRIMARY KEY,
  seq        INTEGER NOT NULL,       -- 出站序号（op→implant）
  cat        TEXT,
  ct         TEXT NOT NULL,          -- 密文（不可解）
  nonce      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE TABLE IF NOT EXISTS dedupe (
  k          TEXT PRIMARY KEY,       -- 'in:<seq>' / 'tid:<tid>'
  ts         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS counters (
  k          TEXT PRIMARY KEY,       -- 'seq_in' | 'seq_out' | 'nonce_in' | 'nonce_out'
  v          INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  k          TEXT PRIMARY KEY,       -- 'first_seen' | 'last_seen' | 'status' | 'caps'
  v          TEXT
);
```

**为什么 `dedupe` 单独一张表**：每帧都要查一次"见过没有"，主键查找是最便宜的；定期删除 24 h 前的行（alarm 里做），控制单对象存储。

---

## 5. KV 键设计

| key | 值 | TTL | 写入频率 |
|---|---|---|---|
| `dl:{token}` | `{payload_id, r2_key, exp, one_time}` | 10 min | 每次生成链接 1 次（≤ 100/天） |
| `pubkey:{key_id}` | `b64u(pub_raw)` | 无（手动失效） | 登记密钥时 1 次 |
| `cfg:bootstrap` | 引导配置（auth_mode / 公告 / 版本） | 无 | 运维改动时 |
| `flag:{name}` | `"0"`/`"1"` | 无 | 极低 |

> **KV 写入总预算 1,000/天**，上表最坏情况：100 次下载令牌 + 1 次配置 + 少量 flag ≈ 110，留足余量。

---

## 6. R2 键设计

```
{env}/payloads/{payload_id}/{filename}
{env}/sessions/{sid}/files/{transfer_id}/{chunk:05d}
{env}/sessions/{sid}/results/{task_id}.bin
{env}/sessions/{sid}/screens/{ts}.jpg
{env}/exports/{yyyy-mm-dd}/{name}.zip     # 报表导出（可选）
```

生命周期规则（用 R2 Lifecycle 或 Cron 删除）：

| 前缀 | 保留 | 依据 |
|---|---|---|
| `screens/` | 7 天 | 帧数量大 |
| `results/` | 30 天 | 复盘需要 |
| `files/` | 30 天 | 操作员显式删除优先 |
| `payloads/` | 永久（手动删） | 数量小 |
| `exports/` | 3 天 | 临时产物 |

---

## 7. 配额友好的读写模式（实现约束）

| 场景 | 反例（会炸） | 正确做法 |
|---|---|---|
| 会话列表 | 每行查一次最后任务（N+1 查询） | 单条 `LEFT JOIN` 子查询，或 `sessions.last_task_at` 冗余列 |
| 任务批量下发 | 循环 100 次 `INSERT` | 一次 `db.batch()`，并限制单批 ≤ 100 |
| 结果回传 | 每条结果都 `UPDATE sessions` | 每 10 条或每 30 s 合并一次 |
| 审计 | 每个动作同步写 D1 | 攒批（`ctx.waitUntil` + 队列/DO 内存缓冲） |
| 大结果 | 直接塞 D1 | > 4 KB 走 R2，D1 只留索引 |
| 清理 | `DELETE` 全表 | 分批（每次 1,000 行），Cron 每小时跑一次 |

---

## 8. 迁移与版本

- 迁移文件：`db/migrations/0001_init.sql`、`0002_*.sql`…，只增不改。
- 执行：`wrangler d1 migrations apply stc2-core --remote`（本地用 `--local`）。
- 每次迁移在 `settings` 里记 `schema_version`；Worker 启动时（首次请求）比对，版本不匹配就返回 503 并提示执行迁移——**避免"代码已升级、库没升"的静默错乱**。
- 回滚：D1 Time Travel（免费 7 天）恢复，命令见 [部署文档](../06-operations/01-deployment.md)。
