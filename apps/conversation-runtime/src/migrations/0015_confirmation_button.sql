ALTER TABLE `confirmations` ADD `button_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `confirmations_button` ON `confirmations` (`button_id`);