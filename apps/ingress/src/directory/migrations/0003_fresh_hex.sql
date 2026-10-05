CREATE TABLE `noticed_senders` (
	`channel` text NOT NULL,
	`channel_user_id` text NOT NULL,
	`noticed_at` integer NOT NULL,
	PRIMARY KEY(`channel`, `channel_user_id`)
);
--> statement-breakpoint
CREATE INDEX `noticed_senders_noticed_at` ON `noticed_senders` (`channel`,`noticed_at`);--> statement-breakpoint
CREATE TABLE `pairing_codes` (
	`user_id` text NOT NULL,
	`channel` text NOT NULL,
	`salt` text NOT NULL,
	`hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `channel`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `pairing_failures` (
	`channel` text NOT NULL,
	`channel_user_id` text NOT NULL,
	`count` integer NOT NULL,
	`last_failure_at` integer NOT NULL,
	`locked_until` integer,
	PRIMARY KEY(`channel`, `channel_user_id`)
);
