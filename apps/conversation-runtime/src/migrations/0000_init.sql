CREATE TABLE `history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`turn_id` integer NOT NULL,
	`role` text NOT NULL,
	`user_id` text,
	`system_version` integer NOT NULL,
	`message` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `inbound` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_message_id` text NOT NULL,
	`user_id` text NOT NULL,
	`text` text NOT NULL,
	`received_at` integer NOT NULL,
	`turn_id` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbound_provider_message` ON `inbound` (`provider_message_id`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`turn_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`text` text NOT NULL,
	`delay_ms` integer NOT NULL,
	`status` text NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE INDEX `outbox_turn` ON `outbox` (`turn_id`,`seq`);--> statement-breakpoint
CREATE TABLE `state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `turns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`generation` integer NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`system_prompt` text NOT NULL,
	`system_version` integer NOT NULL,
	`reply` text,
	`created_at` integer NOT NULL
);
