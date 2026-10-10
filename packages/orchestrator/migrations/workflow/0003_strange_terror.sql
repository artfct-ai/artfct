ALTER TABLE `agent_inbox` ADD `chat_message` text;--> statement-breakpoint
ALTER TABLE `agent_inbox` ADD `taken` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_inbox` ADD `reacted` integer DEFAULT false NOT NULL;