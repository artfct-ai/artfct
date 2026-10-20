PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_reviews` (
	`task_id` text PRIMARY KEY NOT NULL,
	`revision` text,
	`blocking` integer NOT NULL,
	`summary` text NOT NULL,
	`findings` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_reviews`("task_id", "revision", "blocking", "summary", "findings") SELECT "task_id", "revision", "blocking", "summary", "findings" FROM `reviews`;--> statement-breakpoint
DROP TABLE `reviews`;--> statement-breakpoint
ALTER TABLE `__new_reviews` RENAME TO `reviews`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_rulings` (
	`task_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`revision` text,
	`reason` text
);
--> statement-breakpoint
INSERT INTO `__new_rulings`("task_id", "status", "revision", "reason") SELECT "task_id", "status", "revision", "reason" FROM `rulings`;--> statement-breakpoint
DROP TABLE `rulings`;--> statement-breakpoint
ALTER TABLE `__new_rulings` RENAME TO `rulings`;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
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
INSERT INTO `__new_tasks`("task_id", "job_id", "role", "refiner_index", "model", "status", "paused_at", "cost_usd", "started_at", "summary", "model_turn_id", "restarts") SELECT "task_id", "job_id", "role", "refiner_index", "model", "status", "paused_at", "cost_usd", "started_at", "summary", "model_turn_id", "restarts" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
CREATE TABLE `__new_artifacts` (
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
INSERT INTO `__new_artifacts`("job_id", "kind", "external_url", "ref", "ref_key", "status", "refiner_task_id", "delivered_to_humans_at", "delivered_revision", "updated_at") SELECT "job_id", "kind", "external_url", "ref", "ref_key", "status", "refiner_task_id", "delivered_to_humans_at", "delivered_revision", "updated_at" FROM `artifacts`;--> statement-breakpoint
DROP TABLE `artifacts`;--> statement-breakpoint
ALTER TABLE `__new_artifacts` RENAME TO `artifacts`;--> statement-breakpoint
CREATE TABLE `__new_jobs` (
	`job_id` text PRIMARY KEY NOT NULL,
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
INSERT INTO `__new_jobs`("job_id", "stage", "issue_id", "issue_key", "input_kind", "input_key", "preceding_job_id", "input_ref", "input_url", "branch", "brief", "author_harness", "author_model", "research_payload", "selection", "created_at") SELECT "job_id", "stage", "issue_id", "issue_key", "input_kind", "input_key", "preceding_job_id", "input_ref", "input_url", "branch", "brief", "author_harness", "author_model", "research_payload", "selection", "created_at" FROM `jobs`;--> statement-breakpoint
DROP TABLE `jobs`;--> statement-breakpoint
ALTER TABLE `__new_jobs` RENAME TO `jobs`;--> statement-breakpoint
CREATE TABLE `__new_model_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`purpose` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real
);
--> statement-breakpoint
INSERT INTO `__new_model_usage`("id", "at", "purpose", "model", "input_tokens", "output_tokens", "cost_usd") SELECT "id", "at", "purpose", "model", "input_tokens", "output_tokens", "cost_usd" FROM `model_usage`;--> statement-breakpoint
DROP TABLE `model_usage`;--> statement-breakpoint
ALTER TABLE `__new_model_usage` RENAME TO `model_usage`;--> statement-breakpoint
ALTER TABLE `agent_inbox` ADD `body` text;--> statement-breakpoint
ALTER TABLE `events` DROP COLUMN `kind`;