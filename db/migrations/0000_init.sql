CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` integer DEFAULT (unixepoch()) NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`target` text,
	`request_id` text,
	`ip` text,
	`meta` text
);
--> statement-breakpoint
CREATE INDEX `idx_audit_ts` ON `audit_log` (`ts`);--> statement-breakpoint
CREATE INDEX `idx_audit_target` ON `audit_log` (`target`,`ts`);--> statement-breakpoint
CREATE TABLE `file_chunks` (
	`transfer_id` text NOT NULL,
	`idx` integer NOT NULL,
	`size` integer NOT NULL,
	`sha256` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`transfer_id`, `idx`)
);
--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`direction` text NOT NULL,
	`path` text,
	`name` text,
	`size` integer,
	`sha256` text,
	`status` text DEFAULT 'open' NOT NULL,
	`r2_prefix` text NOT NULL,
	`chunks_total` integer DEFAULT 0 NOT NULL,
	`chunks_done` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_files_session` ON `files` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`operator_id` text,
	`session_id` text,
	`title` text NOT NULL,
	`body_md` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_notes_session` ON `notes` (`session_id`);--> statement-breakpoint
CREATE TABLE `operator_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`operator_id` text NOT NULL,
	`key_id` text NOT NULL,
	`pub_raw` text NOT NULL,
	`fp` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_operator_keys_unique` ON `operator_keys` (`operator_id`,`key_id`);--> statement-breakpoint
CREATE INDEX `idx_operator_keys_fp` ON `operator_keys` (`fp`);--> statement-breakpoint
CREATE TABLE `operators` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`display_name` text,
	`role` text DEFAULT 'operator' NOT NULL,
	`password_hash` text,
	`disabled` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_operators_username` ON `operators` (`username`);--> statement-breakpoint
CREATE TABLE `payloads` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`psk_id` text NOT NULL,
	`k_reg` text NOT NULL,
	`k_sess` text NOT NULL,
	`os` text,
	`arch` text,
	`r2_key` text,
	`size` integer,
	`sha256` text,
	`note` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_payloads_psk` ON `payloads` (`psk_id`);--> statement-breakpoint
CREATE INDEX `idx_payloads_created` ON `payloads` (`created_at`);--> statement-breakpoint
CREATE TABLE `pivot_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`listen_host` text,
	`listen_port` integer,
	`target_host` text,
	`target_port` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pivot_session` ON `pivot_rules` (`session_id`);--> statement-breakpoint
CREATE TABLE `quota_daily` (
	`day` text PRIMARY KEY NOT NULL,
	`workers_req` integer DEFAULT 0,
	`do_req` integer DEFAULT 0,
	`d1_rows_read` integer DEFAULT 0,
	`d1_rows_write` integer DEFAULT 0,
	`kv_write` integer DEFAULT 0,
	`r2_class_a` integer DEFAULT 0,
	`r2_class_b` integer DEFAULT 0,
	`r2_bytes` integer DEFAULT 0,
	`notes` text
);
--> statement-breakpoint
CREATE TABLE `screens` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`ts` integer NOT NULL,
	`size` integer,
	`width` integer,
	`height` integer,
	`format` text DEFAULT 'jpeg'
);
--> statement-breakpoint
CREATE INDEX `idx_screens_session` ON `screens` (`session_id`,`ts`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`payload_id` text,
	`host` text,
	`username` text,
	`os` text,
	`arch` text,
	`pid` integer,
	`internal_ip` text,
	`external_ip` text,
	`asn` text,
	`country` text,
	`caps` text,
	`implant_pub` text,
	`owner_key_id` text,
	`status` text DEFAULT 'online' NOT NULL,
	`note` text,
	`tags` text,
	`first_seen` integer DEFAULT (unixepoch()) NOT NULL,
	`last_seen` integer DEFAULT (unixepoch()) NOT NULL,
	`closed_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_status_seen` ON `sessions` (`status`,`last_seen`);--> statement-breakpoint
CREATE INDEX `idx_sessions_payload` ON `sessions` (`payload_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`k` text PRIMARY KEY NOT NULL,
	`v` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_results` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`session_id` text NOT NULL,
	`inline_ct` text,
	`r2_key` text,
	`nonce` text,
	`rid` text,
	`size` integer NOT NULL,
	`sha256` text,
	`truncated` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_results_task` ON `task_results` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_results_created` ON `task_results` (`created_at`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`operator_id` text,
	`rid` text,
	`cat` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`size` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`idem_key` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`dispatched_at` integer,
	`completed_at` integer,
	`expires_at` integer,
	`err` text
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_session_created` ON `tasks` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tasks_idem` ON `tasks` (`operator_id`,`idem_key`);