CREATE TABLE `activity_events` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`purchase_id` text,
	`decision_id` text,
	`category` text NOT NULL,
	`type` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`detail` text,
	`data` text,
	`sim_time` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_household_idx` ON `activity_events` (`household_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `events_purchase_idx` ON `activity_events` (`purchase_id`);--> statement-breakpoint
CREATE TABLE `agent_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`sim_time` integer NOT NULL,
	`trigger` text NOT NULL,
	`input_snapshot` text NOT NULL,
	`shortages` text NOT NULL,
	`urgency` text NOT NULL,
	`candidates` text NOT NULL,
	`selected_action` text NOT NULL,
	`reasoning` text NOT NULL,
	`budget_impact` text NOT NULL,
	`outcome` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `decisions_household_idx` ON `agent_decisions` (`household_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_policies` (
	`household_id` text PRIMARY KEY NOT NULL,
	`auto_purchase_enabled` integer NOT NULL,
	`per_purchase_limit_ngn` integer NOT NULL,
	`overall_agent_limit_ngn` integer NOT NULL,
	`manual_approval_threshold_ngn` integer NOT NULL,
	`priorities` text NOT NULL,
	`approved_services` text NOT NULL,
	`approved_networks` text NOT NULL,
	`approved_provider_ids` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `demo_faults` (
	`key` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `demo_scenarios` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`config` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fulfilments` (
	`id` text PRIMARY KEY NOT NULL,
	`purchase_id` text NOT NULL,
	`settlement_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`account_id` text NOT NULL,
	`quantity` real NOT NULL,
	`unit` text NOT NULL,
	`balance_before` real NOT NULL,
	`balance_after` real NOT NULL,
	`demo_token` text,
	`details` text,
	`fulfilled_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`settlement_id`) REFERENCES `provider_settlements`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`provider_id`) REFERENCES `utility_providers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `utility_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fulfilments_settlement_uq` ON `fulfilments` (`settlement_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `fulfilments_purchase_uq` ON `fulfilments` (`purchase_id`);--> statement-breakpoint
CREATE TABLE `household_budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`period` text NOT NULL,
	`amount_ngn` integer NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`prior_spend_ngn` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `budgets_household_idx` ON `household_budgets` (`household_id`,`active`);--> statement-breakpoint
CREATE TABLE `household_members` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `households` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`country_code` text DEFAULT 'NG' NOT NULL,
	`currency` text DEFAULT 'NGN' NOT NULL,
	`simulated_now` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`purchase_id` text NOT NULL,
	`network` text NOT NULL,
	`scheme` text,
	`asset` text,
	`asset_code` text DEFAULT 'USDC' NOT NULL,
	`amount_atomic` text,
	`decimals` integer DEFAULT 7 NOT NULL,
	`pay_to` text,
	`payer` text,
	`status` text NOT NULL,
	`payment_required` text,
	`settle_response` text,
	`tx_hash` text,
	`ledger` integer,
	`error_code` text,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`settled_at` integer,
	`confirmed_at` integer,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_purchase_uq` ON `payments` (`purchase_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payments_tx_hash_uq` ON `payments` (`tx_hash`);--> statement-breakpoint
CREATE TABLE `provider_settlements` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`purchase_id` text NOT NULL,
	`tx_hash` text NOT NULL,
	`payer` text,
	`amount_atomic` text NOT NULL,
	`asset` text NOT NULL,
	`network` text NOT NULL,
	`order` text NOT NULL,
	`fulfilment_status` text NOT NULL,
	`fulfilment_attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`settled_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `utility_providers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `settlements_tx_uq` ON `provider_settlements` (`tx_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `settlements_provider_purchase_uq` ON `provider_settlements` (`provider_id`,`purchase_id`);--> statement-breakpoint
CREATE TABLE `purchases` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`decision_id` text,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`kind` text NOT NULL,
	`product_code` text NOT NULL,
	`amount_ngn` integer NOT NULL,
	`quantity` real NOT NULL,
	`unit` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`initiated_by` text NOT NULL,
	`stage` text NOT NULL,
	`payment_status` text NOT NULL,
	`fulfilment_status` text NOT NULL,
	`failure_code` text,
	`failure_message` text,
	`sim_time` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decision_id`) REFERENCES `agent_decisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `utility_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`provider_id`) REFERENCES `utility_providers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchases_idempotency_uq` ON `purchases` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `purchases_household_sim_idx` ON `purchases` (`household_id`,`sim_time`);--> statement-breakpoint
CREATE INDEX `purchases_household_idx` ON `purchases` (`household_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `purchases_account_stage_idx` ON `purchases` (`account_id`,`stage`);--> statement-breakpoint
CREATE TABLE `receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`purchase_id` text NOT NULL,
	`provider_receipt_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_purchase_uq` ON `receipts` (`purchase_id`);--> statement-breakpoint
CREATE TABLE `usage_records` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`sim_time` integer NOT NULL,
	`delta` real NOT NULL,
	`balance_after` real NOT NULL,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `utility_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `usage_account_time_idx` ON `usage_records` (`account_id`,`sim_time`);--> statement-breakpoint
CREATE TABLE `utility_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`kind` text NOT NULL,
	`provider_id` text NOT NULL,
	`label` text NOT NULL,
	`identifier` text NOT NULL,
	`network` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `utility_providers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `accounts_household_idx` ON `utility_accounts` (`household_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_kind_identifier_uq` ON `utility_accounts` (`kind`,`identifier`);--> statement-breakpoint
CREATE TABLE `utility_balances` (
	`account_id` text PRIMARY KEY NOT NULL,
	`balance` real NOT NULL,
	`unit` text NOT NULL,
	`baseline_usage_per_hour` real NOT NULL,
	`usage_multiplier` real DEFAULT 1 NOT NULL,
	`expires_at` integer,
	`active_bundle` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `utility_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `utility_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`country_code` text NOT NULL,
	`networks` text NOT NULL,
	`min_amount_ngn` integer NOT NULL,
	`max_amount_ngn` integer NOT NULL,
	`available` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
