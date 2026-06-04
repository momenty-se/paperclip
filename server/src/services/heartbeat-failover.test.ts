import { describe, expect, it } from "vitest";

import {
  asFailoverChainInput,
  isFailoverEligibleError,
  selectNextFailoverTarget,
  type FailoverChainInput,
  type FailoverDecisionInput,
} from "./heartbeat-failover.js";

const PRIMARY = { adapterType: "codex_local", model: "gpt-5" };

const chain: FailoverChainInput = {
  primary: PRIMARY,
  fallback: [
    { adapterType: "claude_local", model: "sonnet-4-6" },
    { adapterType: "gemini_local", model: "pro-2-5" },
  ],
};

function baseInput(
  overrides: Partial<FailoverDecisionInput> = {},
): FailoverDecisionInput {
  return {
    attempt: { errorFamily: "transient_upstream" },
    agentAdapterType: "codex_local",
    agentRequiredCapabilities: null,
    failoverChain: chain,
    failoverOptOut: false,
    failoverCostMultiplierMax: 3,
    baselineCostMultiplier: 1,
    costMultiplierForTarget: () => 1,
    alreadyAttemptedAdapterTypes: ["codex_local"],
    ...overrides,
  };
}

describe("isFailoverEligibleError", () => {
  it("matches transient_upstream errorFamily", () => {
    expect(isFailoverEligibleError({ errorFamily: "transient_upstream" })).toBe(true);
  });
  it("matches provider auth_required errorCodes", () => {
    for (const code of ["claude_auth_required", "codex_auth_required", "gemini_auth_required"]) {
      expect(isFailoverEligibleError({ errorCode: code })).toBe(true);
    }
  });
  it("matches quota_exhausted / credits_required / max_turns_exhausted", () => {
    for (const code of ["quota_exhausted", "credits_required", "max_turns_exhausted"]) {
      expect(isFailoverEligibleError({ errorCode: code })).toBe(true);
    }
  });
  it("does not match unrelated errors", () => {
    expect(isFailoverEligibleError({ errorCode: "timeout" })).toBe(false);
    expect(isFailoverEligibleError({ errorCode: "" })).toBe(false);
    expect(isFailoverEligibleError(null)).toBe(false);
    expect(isFailoverEligibleError({})).toBe(false);
  });
});

describe("selectNextFailoverTarget", () => {
  it("returns first eligible fallback for transient_upstream", () => {
    const decision = selectNextFailoverTarget(baseInput());
    expect(decision.kind).toBe("use_target");
    if (decision.kind !== "use_target") return;
    expect(decision.target.adapterType).toBe("claude_local");
  });

  it("returns ineligible_error for non-failover-eligible errors", () => {
    const decision = selectNextFailoverTarget(
      baseInput({ attempt: { errorCode: "timeout" } }),
    );
    expect(decision.kind).toBe("ineligible_error");
  });

  it("respects failoverOptOut", () => {
    const decision = selectNextFailoverTarget(baseInput({ failoverOptOut: true }));
    expect(decision.kind).toBe("opted_out");
  });

  it("returns no_chain when failoverChain is null", () => {
    const decision = selectNextFailoverTarget(baseInput({ failoverChain: null }));
    expect(decision.kind).toBe("no_chain");
  });

  it("skips candidates already attempted in the same run", () => {
    const decision = selectNextFailoverTarget(
      baseInput({
        alreadyAttemptedAdapterTypes: ["codex_local", "claude_local"],
      }),
    );
    expect(decision.kind).toBe("use_target");
    if (decision.kind !== "use_target") return;
    expect(decision.target.adapterType).toBe("gemini_local");
    expect(decision.skippedCandidates.map((s) => s.target.adapterType)).toEqual([
      "claude_local",
    ]);
  });

  it("returns exhausted when all candidates already attempted", () => {
    const decision = selectNextFailoverTarget(
      baseInput({
        alreadyAttemptedAdapterTypes: ["codex_local", "claude_local", "gemini_local"],
      }),
    );
    expect(decision.kind).toBe("exhausted");
  });

  it("skips candidates exceeding cost cap", () => {
    const decision = selectNextFailoverTarget(
      baseInput({
        baselineCostMultiplier: 1,
        failoverCostMultiplierMax: 2,
        costMultiplierForTarget: (target) => (target.adapterType === "claude_local" ? 5 : 1),
      }),
    );
    expect(decision.kind).toBe("use_target");
    if (decision.kind !== "use_target") return;
    expect(decision.target.adapterType).toBe("gemini_local");
    expect(decision.skippedCandidates).toHaveLength(1);
    expect(decision.skippedCandidates[0]?.reason).toMatch(/cost_cap_exceeded/);
  });

  it("skips candidates missing required capabilities", () => {
    const decision = selectNextFailoverTarget(
      baseInput({
        agentRequiredCapabilities: "tool-use",
        capabilitiesForTarget: (target) =>
          target.adapterType === "claude_local" ? "" : "tool-use code",
      }),
    );
    expect(decision.kind).toBe("use_target");
    if (decision.kind !== "use_target") return;
    expect(decision.target.adapterType).toBe("gemini_local");
    expect(decision.skippedCandidates[0]?.reason).toBe("capabilities_mismatch");
  });
});

describe("countFailoversInRows", () => {
  it("counts rows whose resultJson.failoverPath is a non-empty array", async () => {
    const { countFailoversInRows } = await import("./heartbeat-failover.js");
    expect(countFailoversInRows([])).toBe(0);
    expect(
      countFailoversInRows([
        { resultJson: { failoverPath: [{ adapterType: "codex_local", errorCode: "quota_exhausted" }] } },
        { resultJson: { failoverPath: [] } },
        { resultJson: null },
        { resultJson: {} },
        { resultJson: { failoverPath: "nope" } },
        { resultJson: { failoverPath: [{ adapterType: "claude_local", errorCode: null }] } },
      ]),
    ).toBe(2);
  });
});

describe("asFailoverChainInput", () => {
  it("parses a well-formed chain", () => {
    const parsed = asFailoverChainInput({
      primary: { adapterType: "codex_local", model: "gpt-5" },
      fallback: [{ adapterType: "claude_local", model: "sonnet-4-6" }],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.fallback).toHaveLength(1);
  });

  it("returns null for malformed inputs", () => {
    expect(asFailoverChainInput(null)).toBeNull();
    expect(asFailoverChainInput("nope")).toBeNull();
    expect(asFailoverChainInput({ primary: {}, fallback: [] })).toBeNull();
    expect(asFailoverChainInput({ primary: { adapterType: "x", model: "y" }, fallback: "no" })).toBeNull();
    expect(asFailoverChainInput({ primary: { adapterType: "", model: "y" }, fallback: [] })).toBeNull();
  });
});
