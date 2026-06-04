ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "failover_chain" jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "failover_cost_multiplier_max" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "failover_opt_out" boolean DEFAULT false NOT NULL;
