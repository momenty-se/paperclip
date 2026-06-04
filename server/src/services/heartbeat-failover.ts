import type {
  AgentFailoverChain,
  AgentFailoverTarget,
} from "@paperclipai/shared";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

const AUTH_ERROR_CODE_RE = /^(claude|codex|gemini)_auth_required$/;

const FAILOVER_ELIGIBLE_EXACT_ERROR_CODES = new Set([
  "quota_exhausted",
  "credits_required",
  "max_turns_exhausted",
]);

export interface FailoverAttemptResultLike {
  errorFamily?: AdapterExecutionResult["errorFamily"];
  errorCode?: AdapterExecutionResult["errorCode"];
}

export interface FailoverPathEntry {
  adapterType: string;
  errorCode: string | null;
}

export interface FailoverChainInput {
  primary: AgentFailoverTarget;
  fallback: AgentFailoverTarget[];
}

export interface FailoverDecisionInput {
  attempt: FailoverAttemptResultLike;
  agentAdapterType: string;
  agentRequiredCapabilities?: string | null;
  failoverChain: FailoverChainInput | null;
  failoverOptOut: boolean;
  failoverCostMultiplierMax: number;
  baselineCostMultiplier: number;
  costMultiplierForTarget: (target: AgentFailoverTarget) => number;
  capabilitiesForTarget?: (target: AgentFailoverTarget) => string | null | undefined;
  alreadyAttemptedAdapterTypes: string[];
}

export type FailoverDecision =
  | { kind: "no_failover" }
  | { kind: "ineligible_error"; reason: string }
  | { kind: "opted_out" }
  | { kind: "no_chain" }
  | { kind: "exhausted" }
  | {
      kind: "use_target";
      target: AgentFailoverTarget;
      skippedCandidates: Array<{ target: AgentFailoverTarget; reason: string }>;
    };

export function isFailoverEligibleError(
  result: FailoverAttemptResultLike | null | undefined,
): boolean {
  if (!result) return false;
  if (result.errorFamily === "transient_upstream") return true;
  const code = typeof result.errorCode === "string" ? result.errorCode.trim() : "";
  if (!code) return false;
  if (AUTH_ERROR_CODE_RE.test(code)) return true;
  return FAILOVER_ELIGIBLE_EXACT_ERROR_CODES.has(code);
}

function capabilitiesSatisfied(
  required: string | null | undefined,
  target: string | null | undefined,
): boolean {
  const normRequired = (required ?? "").trim();
  if (!normRequired) return true;
  const normTarget = (target ?? "").trim();
  if (!normTarget) return false;
  const requiredTokens = new Set(
    normRequired.split(/[,\s]+/).map((entry) => entry.toLowerCase()).filter(Boolean),
  );
  const targetTokens = new Set(
    normTarget.split(/[,\s]+/).map((entry) => entry.toLowerCase()).filter(Boolean),
  );
  for (const token of requiredTokens) {
    if (!targetTokens.has(token)) return false;
  }
  return true;
}

export function selectNextFailoverTarget(
  input: FailoverDecisionInput,
): FailoverDecision {
  if (!isFailoverEligibleError(input.attempt)) {
    const code = typeof input.attempt.errorCode === "string" ? input.attempt.errorCode : null;
    return { kind: "ineligible_error", reason: code ? `errorCode=${code}` : "no_eligible_error" };
  }
  if (input.failoverOptOut) return { kind: "opted_out" };
  if (!input.failoverChain) return { kind: "no_chain" };

  const attempted = new Set(input.alreadyAttemptedAdapterTypes);
  const skipped: Array<{ target: AgentFailoverTarget; reason: string }> = [];
  const costCap = input.failoverCostMultiplierMax;

  for (const candidate of input.failoverChain.fallback) {
    if (attempted.has(candidate.adapterType)) {
      skipped.push({ target: candidate, reason: "already_attempted" });
      continue;
    }
    const candidateCapabilities = input.capabilitiesForTarget?.(candidate);
    if (!capabilitiesSatisfied(input.agentRequiredCapabilities, candidateCapabilities)) {
      skipped.push({ target: candidate, reason: "capabilities_mismatch" });
      continue;
    }
    const candidateMultiplier = input.costMultiplierForTarget(candidate);
    const allowedMultiplier = Math.max(1, input.baselineCostMultiplier) * Math.max(1, costCap);
    if (candidateMultiplier > allowedMultiplier) {
      skipped.push({ target: candidate, reason: `cost_cap_exceeded(${candidateMultiplier}>${allowedMultiplier})` });
      continue;
    }
    return { kind: "use_target", target: candidate, skippedCandidates: skipped };
  }
  return { kind: "exhausted" };
}

export function asFailoverChainInput(value: unknown): FailoverChainInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const primary = record.primary;
  const fallback = record.fallback;
  if (!primary || typeof primary !== "object" || Array.isArray(primary)) return null;
  if (!Array.isArray(fallback)) return null;
  const primaryTarget = asFailoverTarget(primary);
  if (!primaryTarget) return null;
  const fallbackTargets: AgentFailoverTarget[] = [];
  for (const entry of fallback) {
    const target = asFailoverTarget(entry);
    if (!target) return null;
    fallbackTargets.push(target);
  }
  return { primary: primaryTarget, fallback: fallbackTargets };
}

function asFailoverTarget(value: unknown): AgentFailoverTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const adapterType = typeof record.adapterType === "string" ? record.adapterType.trim() : "";
  const model = typeof record.model === "string" ? record.model.trim() : "";
  if (!adapterType || !model) return null;
  return { adapterType, model };
}

export type AgentFailoverChainExport = AgentFailoverChain;

/**
 * Counts heartbeat runs in the last `windowMs` ms that recorded an in-run
 * failover (i.e. `result_json.failoverPath` is non-empty).
 *
 * Intentionally lightweight - takes a row provider so callers wire in their
 * preferred db query. The metric is documented in MON-10645 as
 * "failoverCount per agent per 24h"; default window is 24h.
 */
export const DEFAULT_FAILOVER_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface FailoverCountRow {
  resultJson: unknown;
}

export function countFailoversInRows(rows: ReadonlyArray<FailoverCountRow>): number {
  let count = 0;
  for (const row of rows) {
    const resultJson = row.resultJson;
    if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) continue;
    const value = (resultJson as Record<string, unknown>).failoverPath;
    if (Array.isArray(value) && value.length > 0) count += 1;
  }
  return count;
}

