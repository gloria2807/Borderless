CREATE TABLE `agent_run_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`at` integer NOT NULL,
	`stage` text NOT NULL,
	`type` text NOT NULL,
	`utility` text,
	`tool` text,
	`input` text,
	`result` text,
	`decision` text,
	`reason` text,
	`payment_status` text,
	`tx_hash` text,
	`purchase_id` text,
	`error` text,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_events_seq_uq` ON `agent_run_events` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`mode` text NOT NULL,
	`model` text,
	`task` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`summary` text,
	`error` text,
	`steps` integer DEFAULT 0 NOT NULL,
	`usage` text,
	`sim_time` integer NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runs_household_idx` ON `agent_runs` (`household_id`,`started_at`);--> statement-breakpoint
ALTER TABLE `agent_policies` ADD `daily_agent_budget_ngn` integer DEFAULT 8000 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_policies` ADD `task_budget_ngn` integer DEFAULT 6000 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_policies` ADD `reserve_ngn` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_policies` ADD `max_per_utility_ngn` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_policies` ADD `approval_ttl_seconds` integer DEFAULT 180 NOT NULL;--> statement-breakpoint
ALTER TABLE `purchases` ADD `run_id` text REFERENCES agent_runs(id);