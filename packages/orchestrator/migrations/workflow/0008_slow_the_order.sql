CREATE TABLE `session_feeds` (
	`task_id` text PRIMARY KEY NOT NULL,
	`narration` text DEFAULT '' NOT NULL,
	`narrated_at` text,
	`active_at` text NOT NULL
);
