import {
  bigint,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { providerAccounts } from "./provider_accounts.js";

export const providerQuotaWindows = pgTable(
  "provider_quota_windows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerAccountId: uuid("provider_account_id")
      .notNull()
      .references(() => providerAccounts.id, { onDelete: "cascade" }),
    windowKind: text("window_kind").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    tokensIn: bigint("tokens_in", { mode: "number" }).notNull().default(0),
    tokensOut: bigint("tokens_out", { mode: "number" }).notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 18, scale: 6 }).notNull().default("0"),
    hardLimitTokens: bigint("hard_limit_tokens", { mode: "number" }),
    hardLimitCostUsd: numeric("hard_limit_cost_usd", { precision: 18, scale: 6 }),
    softLimitPct: numeric("soft_limit_pct", { precision: 5, scale: 4 }).notNull().default("0.85"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerAccountIdx: index("provider_quota_windows_provider_account_idx").on(table.providerAccountId),
    providerAccountWindowUq: uniqueIndex("provider_quota_windows_provider_account_window_uq").on(
      table.providerAccountId,
      table.windowKind,
    ),
  }),
);
