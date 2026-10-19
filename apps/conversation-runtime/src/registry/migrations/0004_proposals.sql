CREATE TABLE `proposal_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`proposal_id` text NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`user_id` text,
	`via` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `proposal_events_proposal` ON `proposal_events` (`proposal_id`);--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`proposer_id` text NOT NULL,
	`target_id` text NOT NULL,
	`acting_user_id` text NOT NULL,
	`task_id` text,
	`changes` text NOT NULL,
	`before` text NOT NULL,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`claimed_at` integer,
	`decided_at` integer,
	`decided_by` text,
	`told_at` integer,
	`tell_attempts` integer DEFAULT 0 NOT NULL,
	`next_tell_at` integer
);
--> statement-breakpoint
CREATE INDEX `proposals_status` ON `proposals` (`status`);--> statement-breakpoint
CREATE INDEX `proposals_proposer` ON `proposals` (`proposer_id`);