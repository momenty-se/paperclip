import { eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  heartbeatRuns,
  providerAccounts,
  providerQuotaWindows,
} from "@paperclipai/db";

const QUOTA_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const WINDOW_KIND_24H = "24h_rolling";
const WINDOW_KIND_30D = "30d_rolling";
const WINDOW_MS: Record<string, number> = {
  [WINDOW_KIND_24H]: 24 * 60 * 60 * 1000,
  [WINDOW_KIND_30D]: 30 * 24 * 60 * 60 * 1000,
};
const DEFAULT_SOFT_LIMIT_PCT = 0.85;
const DEFAULT_HARD_LIMIT_TOKENS_24H: Record<string, number> = {
  openai: 5_000_000,
  anthropic: 50_000_000,
  google: 20_000_000,
};

export interface ProviderQuotaSnapshot {
  providerAccountId: string;
  provider: string;
  accountLabel: string;
  windowKind: string;
  windowStart: string;
  windowEnd: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  hardLimitTokens: number | null;
  hardLimitCostUsd: number | null;
  softLimitPct: number;
  updatedAt: string;
  percentUsed: number | null;
}

export interface ExecutionTargetSelection {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  providerAccountId: string | null;
  provider: string | null;
  selectedFrom: "primary" | "fallback" | "current";
  skipped: Array<{
    adapterType: string;
    model: string;
    providerAccountId: string | null;
    reason: "soft_limit" | "hard_limit";
    percentUsed: number | null;
  }>;
}

type QuotaTarget = {
  adapterType: string;
  model: string;
  provider: string | null;
  providerAccountId: string | null;
  selectedFrom: "primary" | "fallback" | "current";
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function providerForAdapterType(adapterType: string): string | null {
  switch (adapterType) {
    case "claude_local":
      return "anthropic";
    case "codex_local":
    case "cursor":
    case "cursor_cloud":
    case "opencode_local":
    case "pi_local":
      return "openai";
    case "gemini_local":
      return "google";
    default:
      return null;
  }
}

function envKey(provider: string, accountLabel: string, windowKind: string, suffix: string) {
  const normalizedProvider = provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const normalizedLabel = accountLabel.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const normalizedWindow = windowKind.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return `PAPERCLIP_PROVIDER_QUOTA_${normalizedProvider}_${normalizedLabel}_${normalizedWindow}_${suffix}`;
}

function resolveHardLimitTokens(provider: string, accountLabel: string, windowKind: string): number | null {
  const explicit = readNumber(process.env[envKey(provider, accountLabel, windowKind, "HARD_LIMIT_TOKENS")]);
  if (explicit > 0) return explicit;
  if (windowKind === WINDOW_KIND_24H) {
    return DEFAULT_HARD_LIMIT_TOKENS_24H[provider] ?? null;
  }
  return null;
}

function resolveHardLimitCostUsd(provider: string, accountLabel: string, windowKind: string): number | null {
  const explicit = readNumber(process.env[envKey(provider, accountLabel, windowKind, "HARD_LIMIT_COST_USD")]);
  return explicit > 0 ? explicit : null;
}

function computePercentUsed(input: {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  hardLimitTokens: number | null;
  hardLimitCostUsd: number | null;
}): number | null {
  const tokenPercent = input.hardLimitTokens && input.hardLimitTokens > 0
    ? ((input.tokensIn + input.tokensOut) / input.hardLimitTokens) * 100
    : null;
  const costPercent = input.hardLimitCostUsd && input.hardLimitCostUsd > 0
    ? (input.costUsd / input.hardLimitCostUsd) * 100
    : null;
  const values = [tokenPercent, costPercent].filter((value): value is number => value != null);
  return values.length > 0 ? Math.max(...values) : null;
}

export function chooseExecutionTarget(options: {
  agent: {
    adapterType: string;
    adapterConfig: Record<string, unknown> | null;
    failoverChain: Record<string, unknown> | null;
    failoverOptOut?: boolean;
  };
  defaultProviderAccountsByProvider: Map<string, string>;
  quota24hByProviderAccountId: Map<string, ProviderQuotaSnapshot>;
}): ExecutionTargetSelection {
  const baseConfig = { ...asRecord(options.agent.adapterConfig) };
  const baseProviderAccountId = readNonEmptyString(baseConfig.providerAccountId);
  const currentProvider = providerForAdapterType(options.agent.adapterType);
  const current: QuotaTarget = {
    adapterType: options.agent.adapterType,
    model: readNonEmptyString(baseConfig.model) ?? "",
    provider: currentProvider,
    providerAccountId:
      baseProviderAccountId ??
      (currentProvider ? options.defaultProviderAccountsByProvider.get(currentProvider) ?? null : null),
    selectedFrom: "current",
  };

  if (options.agent.failoverOptOut === true) {
    return { ...current, adapterConfig: baseConfig, skipped: [] };
  }

  const failoverChain = asRecord(options.agent.failoverChain);
  const primary = asRecord(failoverChain.primary);
  const fallback = Array.isArray(failoverChain.fallback)
    ? failoverChain.fallback.map((value) => asRecord(value))
    : [];
  const targets: QuotaTarget[] = [];
  const primaryAdapterType = readNonEmptyString(primary.adapterType);
  const primaryModel = readNonEmptyString(primary.model);
  if (primaryAdapterType && primaryModel) {
    targets.push({
      adapterType: primaryAdapterType,
      model: primaryModel,
      provider: providerForAdapterType(primaryAdapterType),
      providerAccountId: null,
      selectedFrom: "primary",
    });
    for (const target of fallback) {
      const adapterType = readNonEmptyString(target.adapterType);
      const model = readNonEmptyString(target.model);
      if (!adapterType || !model) continue;
      targets.push({
        adapterType,
        model,
        provider: providerForAdapterType(adapterType),
        providerAccountId: null,
        selectedFrom: "fallback",
      });
    }
  } else {
    targets.push(current);
  }

  for (const target of targets) {
    target.providerAccountId =
      target.adapterType === options.agent.adapterType && baseProviderAccountId
        ? baseProviderAccountId
        : target.provider
          ? options.defaultProviderAccountsByProvider.get(target.provider) ?? null
          : null;
  }

  const skipped: ExecutionTargetSelection["skipped"] = [];
  for (const target of targets) {
    const adapterConfig = {
      ...baseConfig,
      ...(target.model ? { model: target.model } : {}),
      ...(target.providerAccountId ? { providerAccountId: target.providerAccountId } : {}),
    };
    if (!target.providerAccountId) {
      return { ...target, adapterConfig, skipped };
    }
    const quota = options.quota24hByProviderAccountId.get(target.providerAccountId);
    if (!quota) {
      return { ...target, adapterConfig, skipped };
    }
    const tokenLimitReached =
      quota.hardLimitTokens != null && quota.tokensIn + quota.tokensOut >= quota.hardLimitTokens;
    const costLimitReached =
      quota.hardLimitCostUsd != null && quota.costUsd >= quota.hardLimitCostUsd;
    if (tokenLimitReached || costLimitReached) {
      skipped.push({
        adapterType: target.adapterType,
        model: target.model,
        providerAccountId: target.providerAccountId,
        reason: "hard_limit",
        percentUsed: quota.percentUsed,
      });
      continue;
    }
    if (quota.percentUsed != null && quota.percentUsed >= quota.softLimitPct * 100) {
      skipped.push({
        adapterType: target.adapterType,
        model: target.model,
        providerAccountId: target.providerAccountId,
        reason: "soft_limit",
        percentUsed: quota.percentUsed,
      });
      continue;
    }
    return { ...target, adapterConfig, skipped };
  }

  return { ...current, adapterConfig: baseConfig, skipped };
}

export function providerQuotaService(db: Db) {
  async function refreshWindows(now = new Date()) {
    const accounts = await db.select().from(providerAccounts);
    if (accounts.length === 0) return [];
    const oldestWindowStart = new Date(now.getTime() - WINDOW_MS[WINDOW_KIND_30D]);
    const activityAtExpr = sql<Date>`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt})`;
    const rows = await db
      .select({
        activityAt: activityAtExpr,
        usageJson: heartbeatRuns.usageJson,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        adapterConfig: agents.adapterConfig,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .where(gte(activityAtExpr, oldestWindowStart));

    const totals = new Map<string, { tokensIn: number; tokensOut: number; costUsd: number }>();
    for (const row of rows) {
      const usage = asRecord(row.usageJson);
      const inputTokens = readNumber(usage.inputTokens ?? usage.input_tokens);
      const outputTokens = readNumber(usage.outputTokens ?? usage.output_tokens);
      const costUsd = readNumber(usage.costUsd ?? usage.cost_usd ?? usage.total_cost_usd);
      if (inputTokens <= 0 && outputTokens <= 0 && costUsd <= 0) continue;

      const context = asRecord(row.contextSnapshot);
      const selection = asRecord(context.paperclipProviderSelection);
      const agentConfig = asRecord(row.adapterConfig);
      const providerAccountId =
        readNonEmptyString(selection.providerAccountId) ??
        readNonEmptyString(agentConfig.providerAccountId);
      if (!providerAccountId) continue;

      const activityAt = row.activityAt instanceof Date ? row.activityAt : new Date(row.activityAt);
      if (Number.isNaN(activityAt.getTime())) continue;

      for (const [windowKind, windowMs] of Object.entries(WINDOW_MS)) {
        if (activityAt.getTime() < now.getTime() - windowMs) continue;
        const key = `${providerAccountId}:${windowKind}`;
        const aggregate = totals.get(key) ?? { tokensIn: 0, tokensOut: 0, costUsd: 0 };
        aggregate.tokensIn += inputTokens;
        aggregate.tokensOut += outputTokens;
        aggregate.costUsd += costUsd;
        totals.set(key, aggregate);
      }
    }

    for (const account of accounts) {
      for (const [windowKind, windowMs] of Object.entries(WINDOW_MS)) {
        const aggregate = totals.get(`${account.id}:${windowKind}`) ?? {
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
        };
        const hardLimitTokens = resolveHardLimitTokens(account.provider, account.accountLabel, windowKind);
        const hardLimitCostUsd = resolveHardLimitCostUsd(account.provider, account.accountLabel, windowKind);
        await db
          .insert(providerQuotaWindows)
          .values({
            providerAccountId: account.id,
            windowKind,
            windowStart: new Date(now.getTime() - windowMs),
            windowEnd: now,
            tokensIn: aggregate.tokensIn,
            tokensOut: aggregate.tokensOut,
            costUsd: aggregate.costUsd.toFixed(6),
            hardLimitTokens,
            hardLimitCostUsd: hardLimitCostUsd != null ? hardLimitCostUsd.toFixed(6) : null,
            softLimitPct: DEFAULT_SOFT_LIMIT_PCT.toFixed(4),
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [providerQuotaWindows.providerAccountId, providerQuotaWindows.windowKind],
            set: {
              windowStart: new Date(now.getTime() - windowMs),
              windowEnd: now,
              tokensIn: aggregate.tokensIn,
              tokensOut: aggregate.tokensOut,
              costUsd: aggregate.costUsd.toFixed(6),
              hardLimitTokens,
              hardLimitCostUsd: hardLimitCostUsd != null ? hardLimitCostUsd.toFixed(6) : null,
              softLimitPct: DEFAULT_SOFT_LIMIT_PCT.toFixed(4),
              updatedAt: now,
            },
          });
      }
    }
  }

  async function ensureFresh(now = new Date()) {
    const latest = await db
      .select({ updatedAt: providerQuotaWindows.updatedAt })
      .from(providerQuotaWindows)
      .orderBy(sql`${providerQuotaWindows.updatedAt} desc`)
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!latest?.updatedAt || now.getTime() - latest.updatedAt.getTime() > QUOTA_REFRESH_INTERVAL_MS) {
      await refreshWindows(now);
    }
  }

  async function listSnapshots(now = new Date()): Promise<ProviderQuotaSnapshot[]> {
    await ensureFresh(now);
    const rows = await db
      .select({
        providerAccountId: providerQuotaWindows.providerAccountId,
        provider: providerAccounts.provider,
        accountLabel: providerAccounts.accountLabel,
        windowKind: providerQuotaWindows.windowKind,
        windowStart: providerQuotaWindows.windowStart,
        windowEnd: providerQuotaWindows.windowEnd,
        tokensIn: providerQuotaWindows.tokensIn,
        tokensOut: providerQuotaWindows.tokensOut,
        costUsd: providerQuotaWindows.costUsd,
        hardLimitTokens: providerQuotaWindows.hardLimitTokens,
        hardLimitCostUsd: providerQuotaWindows.hardLimitCostUsd,
        softLimitPct: providerQuotaWindows.softLimitPct,
        updatedAt: providerQuotaWindows.updatedAt,
      })
      .from(providerQuotaWindows)
      .innerJoin(providerAccounts, eq(providerAccounts.id, providerQuotaWindows.providerAccountId));

    return rows.map((row) => {
      const costUsd = readNumber(row.costUsd);
      const hardLimitTokens = row.hardLimitTokens == null ? null : readNumber(row.hardLimitTokens);
      const hardLimitCostUsd = row.hardLimitCostUsd == null ? null : readNumber(row.hardLimitCostUsd);
      const softLimitPct = readNumber(row.softLimitPct) || DEFAULT_SOFT_LIMIT_PCT;
      return {
        providerAccountId: row.providerAccountId,
        provider: row.provider,
        accountLabel: row.accountLabel,
        windowKind: row.windowKind,
        windowStart: row.windowStart.toISOString(),
        windowEnd: row.windowEnd.toISOString(),
        tokensIn: readNumber(row.tokensIn),
        tokensOut: readNumber(row.tokensOut),
        costUsd,
        hardLimitTokens,
        hardLimitCostUsd,
        softLimitPct,
        updatedAt: row.updatedAt.toISOString(),
        percentUsed: computePercentUsed({
          tokensIn: readNumber(row.tokensIn),
          tokensOut: readNumber(row.tokensOut),
          costUsd,
          hardLimitTokens,
          hardLimitCostUsd,
        }),
      };
    });
  }

  async function chooseForAgent(
    agent: {
      adapterType: string;
      adapterConfig: Record<string, unknown> | null;
      failoverChain: Record<string, unknown> | null;
      failoverOptOut?: boolean;
    },
    now = new Date(),
  ) {
    const snapshots = await listSnapshots(now);
    const defaultProviderAccountsByProvider = new Map<string, string>();
    const quota24hByProviderAccountId = new Map<string, ProviderQuotaSnapshot>();
    for (const snapshot of snapshots) {
      if (snapshot.accountLabel === "default" && !defaultProviderAccountsByProvider.has(snapshot.provider)) {
        defaultProviderAccountsByProvider.set(snapshot.provider, snapshot.providerAccountId);
      }
      if (snapshot.windowKind === WINDOW_KIND_24H) {
        quota24hByProviderAccountId.set(snapshot.providerAccountId, snapshot);
      }
    }
    return chooseExecutionTarget({
      agent,
      defaultProviderAccountsByProvider,
      quota24hByProviderAccountId,
    });
  }

  return {
    refreshWindows,
    listSnapshots,
    chooseForAgent,
  };
}
