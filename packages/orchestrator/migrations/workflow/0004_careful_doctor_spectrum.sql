ALTER TABLE `tasks` ADD `model_turn_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `restarts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sandboxes` DROP COLUMN `restarts`;