CREATE TABLE IF NOT EXISTS "provider_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"account_label" text NOT NULL,
	"api_key_secret_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_accounts_provider_idx"
ON "provider_accounts" USING btree ("provider");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_accounts_provider_label_uq"
ON "provider_accounts" USING btree ("provider","account_label");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_quota_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_account_id" uuid NOT NULL,
	"window_kind" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric(18, 6) DEFAULT 0 NOT NULL,
	"hard_limit_tokens" bigint,
	"hard_limit_cost_usd" numeric(18, 6),
	"soft_limit_pct" numeric(5, 4) DEFAULT 0.85 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_quota_windows_provider_account_id_provider_accounts_id_fk"
		FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_quota_windows_provider_account_idx"
ON "provider_quota_windows" USING btree ("provider_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_quota_windows_provider_account_window_uq"
ON "provider_quota_windows" USING btree ("provider_account_id","window_kind");--> statement-breakpoint
