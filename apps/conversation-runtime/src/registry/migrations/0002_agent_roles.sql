ALTER TABLE `agents` ADD `role` text DEFAULT 'specialist' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `owner_id` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `chat` integer DEFAULT true NOT NULL;