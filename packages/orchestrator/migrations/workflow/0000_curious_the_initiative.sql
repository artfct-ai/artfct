CREATE TABLE `agent_inbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`text` text NOT NULL,
	`body` text,
	`wake` text DEFAULT 'none' NOT NULL,
	`reply_to` text,
	`chat_message` text,
	`taken` integer DEFAULT false NOT NULL,
	`reacted` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_turn` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`first_row` integer NOT NULL,
	`board_changed` integer NOT NULL,
	`watchdog_schedule` text,
	`heads_up_schedule` text
);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`job_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`external_url` text NOT NULL,
	`ref` text NOT NULL,
	`ref_key` text NOT NULL,
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
CREATE TABLE `conversation` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`origin` text,
	`request_title` text NOT NULL,
	`request_text` text NOT NULL,
	`request_links` text NOT NULL,
	`opened_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`stage` text NOT NULL,
	`issue_id` text,
	`issue_key` text,
	`input_kind` text NOT NULL,
	`input_key` text NOT NULL,
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
	`cost_usd` real
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
	`kind` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `prompt_steers` (
	`prompt_id` integer PRIMARY KEY NOT NULL,
	`rpc_id` integer NOT NULL,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reply_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`target_key` text NOT NULL,
	`target` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reply_targets_target_key_unique` ON `reply_targets` (`target_key`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`task_id` text PRIMARY KEY NOT NULL,
	`revision` text,
	`blocking` integer NOT NULL,
	`summary` text NOT NULL,
	`findings` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rpc` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`method` text NOT NULL,
	`purpose` text NOT NULL,
	`sent_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rulings` (
	`task_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`revision` text,
	`reason` text
);
--> statement-breakpoint
CREATE TABLE `sandboxes` (
	`task_id` text PRIMARY KEY NOT NULL,
	`harness` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`bridge_token` text NOT NULL,
	`session_id` text,
	`first_prompt_at` text,
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
	`stopped_early` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_feeds` (
	`task_id` text PRIMARY KEY NOT NULL,
	`narration` text DEFAULT '' NOT NULL,
	`narrated_at` text,
	`active_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stage_plan` (
	`workflow_id` text PRIMARY KEY NOT NULL,
	`stages` text NOT NULL,
	`job_slots` integer NOT NULL,
	`page_parent` text,
	`root_page` text
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
	`model` text NOT NULL,
	`status` text NOT NULL,
	`paused_at` text,
	`cost_usd` real,
	`started_at` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`model_turn_id` text,
	`restarts` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transcript` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`message` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflow_end` (
	`workflow_id` text PRIMARY KEY NOT NULL,
	`ends_as` text NOT NULL,
	`reason` text NOT NULL,
	`answering` text NOT NULL,
	`posted` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflow_subject` (
	`workflow_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`tracker_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflows` (
	`workflow_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`definition` text NOT NULL,
	`name` text NOT NULL,
	`reason` text NOT NULL,
	`repo` text,
	`idle_schedule` text,
	`created_at` text NOT NULL
);
