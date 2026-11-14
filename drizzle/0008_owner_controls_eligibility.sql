ALTER TABLE `agent_policies` ADD `agent_paused` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `utility_accounts` ADD `distribution_company` text;--> statement-breakpoint
UPDATE `utility_accounts` SET `distribution_company` = 'Demo Eko DisCo' WHERE `kind` = 'electricity' AND `distribution_company` IS NULL;