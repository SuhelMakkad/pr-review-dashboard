CREATE TABLE `auto_review_log` (
	`account` text NOT NULL,
	`key` text NOT NULL,
	`pr_id` text NOT NULL,
	`status` text NOT NULL,
	`run_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`updated_at` text NOT NULL,
	CONSTRAINT `auto_review_log_pk` PRIMARY KEY(`account`, `key`)
);
--> statement-breakpoint
ALTER TABLE `ai_runs` ADD `trigger` text DEFAULT 'manual' NOT NULL;