import { describe, expect, it } from "vitest";
import { chooseExecutionTarget, type ProviderQuotaSnapshot } from "../services/provider-quotas.js";

function snapshot(overrides: Partial<ProviderQuotaSnapshot>): ProviderQuotaSnapshot {
  return {
    providerAccountId: "acct-openai",
    provider: "openai",
    accountLabel: "default",
    windowKind: "24h_rolling",
    windowStart: "2026-06-04T00:00:00.000Z",
    windowEnd: "2026-06-05T00:00:00.000Z",
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    hardLimitTokens: 5_000_000,
    hardLimitCostUsd: null,
    softLimitPct: 0.85,
    updatedAt: "2026-06-04T12:00:00.000Z",
    percentUsed: 0,
    ...overrides,
  };
}

describe("chooseExecutionTarget", () => {
  it("skips a primary candidate that passed the soft limit and uses fallback", () => {
    const selected = chooseExecutionTarget({
      agent: {
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4", providerAccountId: "acct-openai" },
        failoverChain: {
          primary: { adapterType: "codex_local", model: "gpt-5.4" },
          fallback: [{ adapterType: "claude_local", model: "claude-sonnet-4-6" }],
        },
      },
      defaultProviderAccountsByProvider: new Map([
        ["openai", "acct-openai"],
        ["anthropic", "acct-anthropic"],
      ]),
      quota24hByProviderAccountId: new Map([
        ["acct-openai", snapshot({ percentUsed: 92, tokensIn: 2_000_000, tokensOut: 2_600_000 })],
        ["acct-anthropic", snapshot({
          providerAccountId: "acct-anthropic",
          provider: "anthropic",
          hardLimitTokens: 50_000_000,
          percentUsed: 20,
        })],
      ]),
    });

    expect(selected.adapterType).toBe("claude_local");
    expect(selected.providerAccountId).toBe("acct-anthropic");
    expect(selected.selectedFrom).toBe("fallback");
    expect(selected.skipped).toEqual([
      expect.objectContaining({
        adapterType: "codex_local",
        reason: "soft_limit",
      }),
    ]);
  });

  it("keeps the current target when no quota data exists", () => {
    const selected = chooseExecutionTarget({
      agent: {
        adapterType: "gemini_local",
        adapterConfig: { model: "gemini-2.5-pro" },
        failoverChain: null,
      },
      defaultProviderAccountsByProvider: new Map([["google", "acct-google"]]),
      quota24hByProviderAccountId: new Map(),
    });

    expect(selected.adapterType).toBe("gemini_local");
    expect(selected.providerAccountId).toBe("acct-google");
    expect(selected.skipped).toEqual([]);
  });

  it("skips hard-limited candidates before considering lower-priority targets", () => {
    const selected = chooseExecutionTarget({
      agent: {
        adapterType: "claude_local",
        adapterConfig: { model: "claude-opus-4-7", providerAccountId: "acct-anthropic" },
        failoverChain: {
          primary: { adapterType: "claude_local", model: "claude-opus-4-7" },
          fallback: [
            { adapterType: "gemini_local", model: "gemini-2.5-pro" },
            { adapterType: "codex_local", model: "gpt-5.4" },
          ],
        },
      },
      defaultProviderAccountsByProvider: new Map([
        ["anthropic", "acct-anthropic"],
        ["google", "acct-google"],
        ["openai", "acct-openai"],
      ]),
      quota24hByProviderAccountId: new Map([
        ["acct-anthropic", snapshot({
          providerAccountId: "acct-anthropic",
          provider: "anthropic",
          hardLimitTokens: 10,
          tokensIn: 6,
          tokensOut: 4,
          percentUsed: 100,
        })],
        ["acct-google", snapshot({
          providerAccountId: "acct-google",
          provider: "google",
          hardLimitTokens: 20_000_000,
          percentUsed: 40,
        })],
      ]),
    });

    expect(selected.adapterType).toBe("gemini_local");
    expect(selected.skipped[0]).toEqual(
      expect.objectContaining({
        adapterType: "claude_local",
        reason: "hard_limit",
      }),
    );
  });
});
