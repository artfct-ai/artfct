PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_rpc` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`method` text NOT NULL,
	`purpose` text NOT NULL,
	`sent_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_rpc`("id", "task_id", "method", "purpose", "sent_at") SELECT "id", "task_id", "method", "purpose", "sent_at" FROM `rpc`;--> statement-breakpoint
DROP TABLE `rpc`;--> statement-breakpoint
ALTER TABLE `__new_rpc` RENAME TO `rpc`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `sandboxes` ADD `stopped_early` integer DEFAULT 0 NOT NULL;