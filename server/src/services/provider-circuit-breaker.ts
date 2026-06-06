/**
 * Circuit breaker per provider account (MON-10655).
 *
 * State machine per providerAccountId: CLOSED → OPEN → HALF_OPEN → CLOSED.
 *
 * Trigger: ≥5 runs with errorFamily=transient_upstream within 10 min window,
 * across all agents sharing the same providerAccountId.
 *
 * OPEN (15 min default): pre-flight skips the adapter entirely — no API call.
 * HALF_OPEN: 1 probe every 3 min; success → CLOSED, fail → OPEN with doubled T
 * (capped 1 h).
 *
 * In-memory state is the primary path (fast, no DB latency). DB is a backup
 * for restart-resilience: only state *transitions* are persisted.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { providerCircuitState } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

// ── Constants ────────────────────────────────────────────────────────────────

const TRANSIENT_WINDOW_MS = 10 * 60 * 1000; // 10 min sliding window for failure counting
const OPEN_THRESHOLD = 5; // transient failures within window before opening
const DEFAULT_RECOVERY_MS = 15 * 60 * 1000; // 15 min OPEN duration
const MAX_RECOVERY_MS = 60 * 60 * 1000; // 1 hr cap for exponential backoff
const HALF_OPEN_PROBE_INTERVAL_MS = 3 * 60 * 1000; // min gap between half-open probes

export type ProviderCircuitStateValue = "CLOSED" | "OPEN" | "HALF_OPEN";

interface InMemoryState {
  state: ProviderCircuitStateValue;
  /** Timestamps (ms) of recent transient failures within the sliding window */
  recentTransientFailures: number[];
  openedAt: number | null;
  recoveryTimeoutMs: number;
  halfOpenProbeAt: number | null;
  /** Accumulated OPEN minutes for metrics */
  openMinutesAccum: number;
  lastOpenMinutesAccumAt: number | null;
}

export interface CircuitCheckResult {
  blocked: boolean;
  state: ProviderCircuitStateValue;
}

export interface ProviderCircuitMetric {
  providerAccountId: string;
  state: ProviderCircuitStateValue;
  openMinutesTotal: number;
  openedAt: number | null;
  recoveryTimeoutMs: number;
}

// ── Module-level in-memory store ─────────────────────────────────────────────

const memStore = new Map<string, InMemoryState>();

/** Clears all in-memory circuit state. Intended only for use in tests. */
export function __resetCircuitBreakerStateForTests(): void {
  memStore.clear();
}

function getOrInit(providerAccountId: string): InMemoryState {
  let s = memStore.get(providerAccountId);
  if (!s) {
    s = {
      state: "CLOSED",
      recentTransientFailures: [],
      openedAt: null,
      recoveryTimeoutMs: DEFAULT_RECOVERY_MS,
      halfOpenProbeAt: null,
      openMinutesAccum: 0,
      lastOpenMinutesAccumAt: null,
    };
    memStore.set(providerAccountId, s);
  }
  return s;
}

function pruneWindow(s: InMemoryState, now: number): void {
  const cutoff = now - TRANSIENT_WINDOW_MS;
  s.recentTransientFailures = s.recentTransientFailures.filter((t) => t >= cutoff);
}

function accumulateOpenMinutes(s: InMemoryState, now: number): void {
  if (s.state === "OPEN" && s.lastOpenMinutesAccumAt !== null) {
    s.openMinutesAccum += (now - s.lastOpenMinutesAccumAt) / 60_000;
  }
  s.lastOpenMinutesAccumAt = s.state === "OPEN" ? now : null;
}

// ── DB persistence ────────────────────────────────────────────────────────────

async function persistState(
  db: Db,
  providerAccountId: string,
  s: InMemoryState,
): Promise<void> {
  try {
    await db
      .insert(providerCircuitState)
      .values({
        providerAccountId,
        state: s.state,
        openedAt: s.openedAt ? new Date(s.openedAt) : null,
        recoveryTimeoutMs: s.recoveryTimeoutMs,
        halfOpenProbeAt: s.halfOpenProbeAt ? new Date(s.halfOpenProbeAt) : null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: providerCircuitState.providerAccountId,
        set: {
          state: s.state,
          openedAt: s.openedAt ? new Date(s.openedAt) : null,
          recoveryTimeoutMs: s.recoveryTimeoutMs,
          halfOpenProbeAt: s.halfOpenProbeAt ? new Date(s.halfOpenProbeAt) : null,
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    logger.warn(
      { providerAccountId, err },
      "[circuit-breaker] Failed to persist circuit state to DB",
    );
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function providerCircuitBreakerService(db: Db) {
  /**
   * Load persisted OPEN/HALF_OPEN states from DB at startup.
   * CLOSED states are always the safe default on restart.
   */
  async function loadFromDb(now = Date.now()): Promise<void> {
    try {
      const rows = await db.select().from(providerCircuitState);
      for (const row of rows) {
        if (row.state !== "OPEN" && row.state !== "HALF_OPEN") continue;
        const s = getOrInit(row.providerAccountId);
        s.state = row.state as ProviderCircuitStateValue;
        s.openedAt = row.openedAt ? row.openedAt.getTime() : null;
        s.recoveryTimeoutMs = row.recoveryTimeoutMs;
        s.halfOpenProbeAt = row.halfOpenProbeAt ? row.halfOpenProbeAt.getTime() : null;
        if (s.state === "OPEN") {
          s.lastOpenMinutesAccumAt = now;
        }
        logger.info(
          { providerAccountId: row.providerAccountId, state: row.state },
          "[circuit-breaker] Restored persisted circuit state",
        );
      }
    } catch (err) {
      logger.warn({ err }, "[circuit-breaker] Could not load persisted states from DB");
    }
  }

  /**
   * Check whether a provider account is currently blocked by an open circuit.
   * Atomically transitions OPEN → HALF_OPEN when the recovery window expires.
   *
   * Returns { blocked: true } if the caller should skip this adapter without
   * making an API call; { blocked: false } if the call should proceed.
   */
  async function checkAndBlock(
    providerAccountId: string,
    now = Date.now(),
  ): Promise<CircuitCheckResult> {
    const s = getOrInit(providerAccountId);

    if (s.state === "CLOSED") {
      return { blocked: false, state: "CLOSED" };
    }

    if (s.state === "OPEN") {
      const elapsed = now - (s.openedAt ?? 0);
      if (elapsed < s.recoveryTimeoutMs) {
        return { blocked: true, state: "OPEN" };
      }
      // Recovery window elapsed: transition to HALF_OPEN and allow the probe.
      accumulateOpenMinutes(s, now);
      s.state = "HALF_OPEN";
      s.halfOpenProbeAt = now;
      await persistState(db, providerAccountId, s);
      logger.info(
        { providerAccountId, recoveryMs: s.recoveryTimeoutMs },
        "[circuit-breaker] OPEN → HALF_OPEN (probe allowed)",
      );
      return { blocked: false, state: "HALF_OPEN" };
    }

    // HALF_OPEN: allow at most 1 probe per HALF_OPEN_PROBE_INTERVAL_MS.
    if (
      s.halfOpenProbeAt !== null &&
      now - s.halfOpenProbeAt < HALF_OPEN_PROBE_INTERVAL_MS
    ) {
      return { blocked: true, state: "HALF_OPEN" };
    }
    s.halfOpenProbeAt = now;
    await persistState(db, providerAccountId, s);
    return { blocked: false, state: "HALF_OPEN" };
  }

  /**
   * Record a transient failure for a provider account.
   * Opens the circuit when ≥OPEN_THRESHOLD failures fall within TRANSIENT_WINDOW_MS.
   * If called while HALF_OPEN, reopens the circuit with doubled recovery timeout.
   */
  async function recordTransientFailure(
    providerAccountId: string,
    now = Date.now(),
  ): Promise<void> {
    const s = getOrInit(providerAccountId);
    s.recentTransientFailures.push(now);
    pruneWindow(s, now);

    if (s.state === "HALF_OPEN") {
      const newRecovery = Math.min(s.recoveryTimeoutMs * 2, MAX_RECOVERY_MS);
      accumulateOpenMinutes(s, now);
      s.state = "OPEN";
      s.openedAt = now;
      s.recoveryTimeoutMs = newRecovery;
      s.lastOpenMinutesAccumAt = now;
      await persistState(db, providerAccountId, s);
      logger.warn(
        { providerAccountId, newRecoveryMs: newRecovery },
        "[circuit-breaker] HALF_OPEN probe failed → OPEN (backoff doubled)",
      );
      return;
    }

    if (s.state === "CLOSED" && s.recentTransientFailures.length >= OPEN_THRESHOLD) {
      s.state = "OPEN";
      s.openedAt = now;
      s.recoveryTimeoutMs = DEFAULT_RECOVERY_MS;
      s.lastOpenMinutesAccumAt = now;
      await persistState(db, providerAccountId, s);
      logger.warn(
        { providerAccountId, failures: s.recentTransientFailures.length },
        `[circuit-breaker] ${s.recentTransientFailures.length} transient failures in ${TRANSIENT_WINDOW_MS / 60_000} min → OPEN`,
      );
    }
  }

  /**
   * Record a successful run for a provider account.
   * Closes the circuit if it was HALF_OPEN.
   */
  async function recordSuccess(
    providerAccountId: string,
    now = Date.now(),
  ): Promise<void> {
    const s = memStore.get(providerAccountId);
    if (!s) return;

    if (s.state === "HALF_OPEN") {
      accumulateOpenMinutes(s, now);
      s.state = "CLOSED";
      s.openedAt = null;
      s.recoveryTimeoutMs = DEFAULT_RECOVERY_MS;
      s.halfOpenProbeAt = null;
      s.recentTransientFailures = [];
      s.lastOpenMinutesAccumAt = null;
      await persistState(db, providerAccountId, s);
      logger.info(
        { providerAccountId },
        "[circuit-breaker] HALF_OPEN probe succeeded → CLOSED",
      );
    } else if (s.state === "CLOSED") {
      s.recentTransientFailures = [];
    }
  }

  /**
   * Returns circuit_open_minutes_total per provider account for dashboard metrics.
   */
  function getMetrics(now = Date.now()): ProviderCircuitMetric[] {
    const out: ProviderCircuitMetric[] = [];
    for (const [providerAccountId, s] of memStore) {
      let openMinutesTotal = s.openMinutesAccum;
      if (s.state === "OPEN" && s.lastOpenMinutesAccumAt !== null) {
        openMinutesTotal += (now - s.lastOpenMinutesAccumAt) / 60_000;
      }
      out.push({
        providerAccountId,
        state: s.state,
        openMinutesTotal,
        openedAt: s.openedAt,
        recoveryTimeoutMs: s.recoveryTimeoutMs,
      });
    }
    return out;
  }

  /**
   * Admin override: force-reset a circuit to CLOSED.
   */
  async function reset(providerAccountId: string, now = Date.now()): Promise<void> {
    const s = getOrInit(providerAccountId);
    accumulateOpenMinutes(s, now);
    s.state = "CLOSED";
    s.openedAt = null;
    s.recoveryTimeoutMs = DEFAULT_RECOVERY_MS;
    s.halfOpenProbeAt = null;
    s.recentTransientFailures = [];
    s.lastOpenMinutesAccumAt = null;
    await persistState(db, providerAccountId, s);
    logger.info({ providerAccountId }, "[circuit-breaker] Manually reset to CLOSED");
  }

  return { loadFromDb, checkAndBlock, recordTransientFailure, recordSuccess, getMetrics, reset };
}

export type ProviderCircuitBreakerService = ReturnType<typeof providerCircuitBreakerService>;
