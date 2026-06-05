import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const providerAccounts = pgTable(
  "provider_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    accountLabel: text("account_label").notNull(),
    apiKeySecretRef: text("api_key_secret_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerIdx: index("provider_accounts_provider_idx").on(table.provider),
    providerLabelUq: uniqueIndex("provider_accounts_provider_label_uq").on(table.provider, table.accountLabel),
  }),
);
