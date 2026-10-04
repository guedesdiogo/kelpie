CREATE TABLE `forms` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`kind` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `secrets` (
	`slot` text PRIMARY KEY NOT NULL,
	`key_version` integer NOT NULL,
	`iv` text NOT NULL,
	`ciphertext` text NOT NULL,
	`updated_at` integer NOT NULL
);
