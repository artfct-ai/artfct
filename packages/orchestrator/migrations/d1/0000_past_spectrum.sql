CREATE TABLE `bindings` (
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`repo` text,
	`workflow_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`source`, `external_id`)
);
--> statement-breakpoint
CREATE INDEX `bindings_workflow` ON `bindings` (`workflow_id`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`source`, `external_id`)
);
--> statement-breakpoint
CREATE TABLE `firing_threads` (
	`firing_key` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`thread` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `linear_installs` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`organization_name` text NOT NULL,
	`app_user_id` text NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `linear_oauth_states` (
	`nonce` text PRIMARY KEY NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflows` (
	`workflow_id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
