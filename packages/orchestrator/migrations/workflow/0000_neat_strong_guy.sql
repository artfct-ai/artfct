CREATE TABLE `agent_inbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`text` text NOT NULL,
	`wake` text DEFAULT 'none' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`job_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`external_url` text NOT NULL,
	`ref` text NOT NULL,
	`status` text DEFAULT 'drafted' NOT NULL,
	`refiner_task_id` text,
	`delivered_to_humans_at` text,
	`delivered_revision` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `boards` (
	`job_id` text NOT NULL,
	`channel_key` text NOT NULL,
	`channel` text NOT NULL,
	`message_id` text,
	`hash` text,
	`recreated` integer DEFAULT 0 NOT NULL,
	`relocate` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`job_id`, `channel_key`)
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`kind` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`stage` text NOT NULL,
	`issue_id` text,
	`issue_key` text,
	`input_key` text,
	`preceding_job_id` text,
	`input_ref` text,
	`input_url` text,
	`branch` text,
	`brief` text DEFAULT '' NOT NULL,
	`author_harness` text,
	`author_model` text,
	`research_payload` text,
	`selection` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`task_id` text,
	`line` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `model_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`purpose` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`channel` text NOT NULL,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `prompt_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`text` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rpc` (
	`id` integer PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`method` text NOT NULL,
	`purpose` text NOT NULL,
	`sent_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sandboxes` (
	`task_id` text PRIMARY KEY NOT NULL,
	`harness` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`bridge_token` text NOT NULL,
	`token_used` integer DEFAULT 0 NOT NULL,
	`session_id` text,
	`last_progress_at` text NOT NULL,
	`prompt_in_flight` integer DEFAULT 0 NOT NULL,
	`turn_text` text DEFAULT '' NOT NULL,
	`bridge_closed_at` text,
	`no_progress_schedule` text,
	`wall_schedule` text,
	`hello_schedule` text,
	`keepalive_schedule` text,
	`token_schedule` text,
	`credential_expires_at` text,
	`nudged` integer DEFAULT 0 NOT NULL,
	`restarts` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_todos` (
	`task_id` text PRIMARY KEY NOT NULL,
	`todos` text,
	`note` text,
	`tool_calls` integer DEFAULT 0 NOT NULL,
	`tool_failures` integer DEFAULT 0 NOT NULL,
	`failed_tools` text DEFAULT '[]' NOT NULL,
	`flush_schedule` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`task_id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`role` text DEFAULT 'author' NOT NULL,
	`refiner_index` integer,
	`result` text,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`paused_at` text,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`started_at` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`job_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `transcript` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`message` text NOT NULL
);
