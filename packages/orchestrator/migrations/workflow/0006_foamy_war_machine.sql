CREATE TABLE `reviews` (
	`task_id` text PRIMARY KEY NOT NULL,
	`revision` text,
	`blocking` integer NOT NULL,
	`summary` text NOT NULL,
	`findings` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`task_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `rulings` (
	`task_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`revision` text,
	`reason` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`task_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `tasks` DROP COLUMN `result`;