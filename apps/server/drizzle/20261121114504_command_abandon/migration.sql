CREATE TABLE `abandoned_commands` (
	`account` text NOT NULL,
	`id` text NOT NULL,
	`pr_id` text NOT NULL,
	`type` text NOT NULL,
	`decision` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `abandoned_commands_pk` PRIMARY KEY(`account`, `id`)
);
--> statement-breakpoint
CREATE TABLE `receipt_epochs` (
	`account` text PRIMARY KEY,
	`epoch` integer DEFAULT 0 NOT NULL
);
