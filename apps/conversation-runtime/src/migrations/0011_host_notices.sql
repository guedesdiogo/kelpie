ALTER TABLE `outbox` ADD `link` text;--> statement-breakpoint
ALTER TABLE `outbox` ADD `confirmation_id` integer;--> statement-breakpoint
ALTER TABLE `turns` ADD `links` text;