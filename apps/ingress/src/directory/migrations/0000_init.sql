CREATE TABLE `grants` (
	`user_id` text NOT NULL,
	`agent_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `agent_id`)
);
--> statement-breakpoint
CREATE TABLE `identities` (
	`channel` text NOT NULL,
	`channel_user_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`channel`, `channel_user_id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`user_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`role` text,
	`deleted` integer NOT NULL
);
