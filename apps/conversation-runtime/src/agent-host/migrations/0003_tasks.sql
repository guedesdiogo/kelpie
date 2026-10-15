CREATE TABLE `task_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`at` integer NOT NULL,
	`author_kind` text NOT NULL,
	`author_id` text NOT NULL,
	`source` text NOT NULL,
	`text` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `task_comments_task` ON `task_comments` (`task_id`);--> statement-breakpoint
CREATE TABLE `task_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`at` integer NOT NULL,
	`actor_kind` text,
	`actor_id` text,
	`via` text NOT NULL,
	`kind` text NOT NULL,
	`from_status` text,
	`to_status` text
);
--> statement-breakpoint
CREATE INDEX `task_events_task` ON `task_events` (`task_id`);--> statement-breakpoint
CREATE TABLE `task_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`token` text NOT NULL,
	`attempt` integer NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`outcome` text
);
--> statement-breakpoint
CREATE INDEX `task_runs_task` ON `task_runs` (`task_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`status` text NOT NULL,
	`scheduled_start_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`creator_kind` text NOT NULL,
	`creator_id` text NOT NULL,
	`acting_user_id` text NOT NULL,
	`waiting_reason` text,
	`waits` integer DEFAULT 0 NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`lease_until` integer,
	`stop_requested_at` integer,
	`result` text
);
--> statement-breakpoint
CREATE INDEX `tasks_status` ON `tasks` (`status`);