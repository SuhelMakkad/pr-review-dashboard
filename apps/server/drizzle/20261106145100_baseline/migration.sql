CREATE TABLE `activity_events` (
	`account` text NOT NULL,
	`key` text NOT NULL,
	`pr_id` text NOT NULL,
	`repository` text NOT NULL,
	`number` integer NOT NULL,
	`kind` text NOT NULL,
	`actor` text,
	`at` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	CONSTRAINT `activity_events_pk` PRIMARY KEY(`account`, `key`)
);
--> statement-breakpoint
CREATE TABLE `ai_runs` (
	`id` text PRIMARY KEY,
	`account` text NOT NULL,
	`pr_id` text NOT NULL,
	`task` text NOT NULL,
	`provider` text NOT NULL,
	`model` text,
	`effort` text NOT NULL,
	`head_oid` text NOT NULL,
	`prompt_version` integer NOT NULL,
	`cache_key` text NOT NULL,
	`status` text NOT NULL,
	`progress` text,
	`result` text,
	`error` text,
	`usage` text,
	`created_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE TABLE `draft_comments` (
	`id` text PRIMARY KEY,
	`account` text NOT NULL,
	`pr_id` text NOT NULL,
	`path` text NOT NULL,
	`line` integer,
	`side` text DEFAULT 'RIGHT' NOT NULL,
	`start_line` integer,
	`start_side` text,
	`subject_type` text DEFAULT 'LINE' NOT NULL,
	`body` text NOT NULL,
	`origin` text DEFAULT 'user' NOT NULL,
	`anchor_oid` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`github_thread_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `feed_membership` (
	`account` text NOT NULL,
	`id` text NOT NULL,
	`feed` text NOT NULL,
	`seen_at` text NOT NULL,
	CONSTRAINT `feed_membership_pk` PRIMARY KEY(`account`, `id`, `feed`)
);
--> statement-breakpoint
CREATE TABLE `notification_log` (
	`account` text NOT NULL,
	`key` text NOT NULL,
	`pr_id` text NOT NULL,
	`channel` text NOT NULL,
	`sent_at` text NOT NULL,
	CONSTRAINT `notification_log_pk` PRIMARY KEY(`account`, `key`)
);
--> statement-breakpoint
CREATE TABLE `pr_sync` (
	`account` text NOT NULL,
	`id` text NOT NULL,
	`fingerprint` text,
	`last_full_at` text,
	`next_full_at` text,
	CONSTRAINT `pr_sync_pk` PRIMARY KEY(`account`, `id`)
);
--> statement-breakpoint
CREATE TABLE `queue_samples` (
	`account` text NOT NULL,
	`at` text NOT NULL,
	`attention` integer NOT NULL,
	`waiting` integer NOT NULL,
	`authored_blocked` integer NOT NULL,
	`oldest_attention_at` text,
	CONSTRAINT `queue_samples_pk` PRIMARY KEY(`account`, `at`)
);
--> statement-breakpoint
CREATE TABLE `review_drafts` (
	`account` text NOT NULL,
	`pr_id` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`event` text DEFAULT 'COMMENT' NOT NULL,
	`github_review_id` text,
	`updated_at` text NOT NULL,
	CONSTRAINT `review_drafts_pk` PRIMARY KEY(`account`, `pr_id`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`account` text NOT NULL,
	`id` text NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `snapshots_pk` PRIMARY KEY(`account`, `id`)
);
--> statement-breakpoint
CREATE TABLE `triage` (
	`account` text NOT NULL,
	`id` text NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `triage_pk` PRIMARY KEY(`account`, `id`)
);
--> statement-breakpoint
CREATE INDEX `activity_events_by_time` ON `activity_events` (`account`,`at`);--> statement-breakpoint
CREATE INDEX `ai_runs_by_pr` ON `ai_runs` (`account`,`pr_id`,`task`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_runs_by_key` ON `ai_runs` (`cache_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `draft_comments_by_pr` ON `draft_comments` (`account`,`pr_id`,`created_at`);