CREATE TABLE IF NOT EXISTS "provider_circuit_state" (
	"provider_account_id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'CLOSED' NOT NULL,
	"opened_at" timestamp with time zone,
	"recovery_timeout_ms" integer DEFAULT 900000 NOT NULL,
	"half_open_probe_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_circuit_state_provider_account_id_provider_accounts_id_fk"
		FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts"("id") ON DELETE cascade
);
