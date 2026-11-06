CREATE TABLE `github_operations` (
	`account` text NOT NULL,
	`id` text NOT NULL,
	`pr_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `github_operations_pk` PRIMARY KEY(`account`, `id`)
);
--> statement-breakpoint
ALTER TABLE `review_drafts` ADD `active_operation_id` text;--> statement-breakpoint
CREATE INDEX `github_operations_by_account` ON `github_operations` (`account`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `github_operations_by_pr` ON `github_operations` (`account`,`pr_id`,`status`);