CREATE TABLE `confirmations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`user_id` text NOT NULL,
	`command` text NOT NULL,
	`input` text NOT NULL,
	`summary` text NOT NULL,
	`after_history_id` integer NOT NULL,
	`turn_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE INDEX `confirmations_request` ON `confirmations` (`user_id`,`command`,`input`);--> statement-breakpoint
ALTER TABLE `outbox` ADD `notice` integer DEFAULT false NOT NULL;