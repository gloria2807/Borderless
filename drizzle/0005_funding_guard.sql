CREATE TABLE `funding_guards` (
	`household_id` text PRIMARY KEY NOT NULL,
	`treasury` text NOT NULL,
	`spender` text NOT NULL,
	`cap_atomic` text NOT NULL,
	`expiration_ledger` integer NOT NULL,
	`granted_at` integer NOT NULL,
	`grant_tx_hash` text NOT NULL,
	`revoked_at` integer,
	`revoke_tx_hash` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
