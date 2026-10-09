CREATE TABLE `feed_items` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`tool_call_id` text,
	`tool_kind` text,
	`failed` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `feed_posts` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`activity_id` text NOT NULL,
	`content` text NOT NULL
);
