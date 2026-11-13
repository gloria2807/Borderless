CREATE TABLE `provider_quotes` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`account_identifier` text NOT NULL,
	`network` text,
	`product_code` text NOT NULL,
	`amount_ngn` integer NOT NULL,
	`quantity` real NOT NULL,
	`unit` text NOT NULL,
	`amount_atomic` text NOT NULL,
	`asset` text NOT NULL,
	`pay_to` text NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`redeemed_by_purchase_id` text,
	FOREIGN KEY (`provider_id`) REFERENCES `utility_providers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quotes_redeemed_uq` ON `provider_quotes` (`redeemed_by_purchase_id`);--> statement-breakpoint
ALTER TABLE `purchases` ADD `quote_id` text;--> statement-breakpoint
ALTER TABLE `purchases` ADD `quote_amount_atomic` text;--> statement-breakpoint
ALTER TABLE `purchases` ADD `quote_pay_to` text;--> statement-breakpoint
ALTER TABLE `purchases` ADD `quote_expires_at` integer;