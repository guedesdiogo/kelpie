CREATE TABLE `checkpoints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`summary` text NOT NULL,
	`kept_from_history_id` integer NOT NULL,
	`usage` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `history` ADD `checkpoint_id` integer;--> statement-breakpoint
ALTER TABLE `turns` ADD `checkpoint_id` integer;