CREATE TABLE `meter_profiles` (
	`account_id` text PRIMARY KEY NOT NULL,
	`profile` text NOT NULL,
	`magnitude` real NOT NULL,
	`since` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `utility_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `agent_policies` ADD `intelligence_cap_ngn` integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE `purchases` ADD `service_type` text DEFAULT 'utility_topup' NOT NULL;