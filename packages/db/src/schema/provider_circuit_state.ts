import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { providerAccounts } from "./provider_accounts.js";

export const providerCircuitState = pgTable("provider_circuit_state", {
  providerAccountId: uuid("provider_account_id")
    .primaryKey()
    .references(() => providerAccounts.id, { onDelete: "cascade" }),
  state: text("state").notNull().default("CLOSED"),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  recoveryTimeoutMs: integer("recovery_timeout_ms").notNull().default(900_000),
  halfOpenProbeAt: timestamp("half_open_probe_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
