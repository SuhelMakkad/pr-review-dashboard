CREATE TABLE `claim_ledger` (
	`id` integer PRIMARY KEY,
	`last` integer DEFAULT 0 NOT NULL,
	`secret` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `claim_watermarks` (
	`account` text PRIMARY KEY,
	`watermark` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `draft_writes` ADD `seq` integer;--> statement-breakpoint
-- Claims from before the ledger kept a sequence: numbered in the order they were made.
UPDATE `draft_writes` SET `seq` = `ordered`.`n`
FROM (
	SELECT `account`, `id`, ROW_NUMBER() OVER (ORDER BY `created_at`, `account`, `id`) AS `n`
	FROM `draft_writes`
) AS `ordered`
WHERE `draft_writes`.`account` = `ordered`.`account` AND `draft_writes`.`id` = `ordered`.`id`;
--> statement-breakpoint
INSERT INTO `claim_ledger` (`id`, `last`, `secret`)
	SELECT 1, COALESCE(MAX(`seq`), 0), lower(hex(randomblob(32))) FROM `draft_writes`;
