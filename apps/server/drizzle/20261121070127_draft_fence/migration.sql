CREATE TABLE `draft_versions` (
	`account` text NOT NULL,
	`pr_id` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`observation` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `draft_versions_pk` PRIMARY KEY(`account`, `pr_id`)
);
--> statement-breakpoint
CREATE TABLE `draft_writes` (
	`account` text NOT NULL,
	`id` text NOT NULL,
	`pr_id` text NOT NULL,
	`kind` text NOT NULL,
	`fingerprint` text NOT NULL,
	`base_revision` integer,
	`base_generation` integer,
	`state` text NOT NULL,
	`result` text,
	`created_at` text NOT NULL,
	CONSTRAINT `draft_writes_pk` PRIMARY KEY(`account`, `id`)
);
--> statement-breakpoint
CREATE INDEX `draft_writes_by_state` ON `draft_writes` (`state`,`created_at`);