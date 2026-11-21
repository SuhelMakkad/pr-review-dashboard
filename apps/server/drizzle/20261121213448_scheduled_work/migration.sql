CREATE TABLE `scheduled_work` (
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`account` text,
	`class` text NOT NULL,
	`requested_at` text,
	`not_before` text,
	`claimed_by` text,
	`claimed_at` text,
	`rearm_at` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `scheduled_work_pk` PRIMARY KEY(`kind`, `key`)
);
