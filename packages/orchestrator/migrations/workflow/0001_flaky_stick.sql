CREATE TABLE `prompt_steers` (
	`prompt_id` integer PRIMARY KEY NOT NULL,
	`rpc_id` integer NOT NULL,
	`status` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `prompt_queue` ADD `instruction` integer DEFAULT 0 NOT NULL;