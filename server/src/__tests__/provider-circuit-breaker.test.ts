import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  providerCircuitBreakerService,
  __resetCircuitBreakerStateForTests,
} from "../services/provider-circuit-breaker.js";

// Minimal Db stub — service only calls insert/onConflictDoUpdate and select
function makeDb() {
  const rows: Record<string, unknown>[] = [];
  const insert = vi.fn().mockReturnValue({
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
  });
  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockResolvedValue(rows),
  });
  return { insert, select } as unknown as import("@paperclipai/db").Db;
}

const ACCOUNT = "acct-anthropic";

describe("providerCircuitBreakerService", () => {
  let db: ReturnType<typeof makeDb>;
  let svc: ReturnType<typeof providerCircuitBreakerService>;
  let now: number;

  beforeEach(() => {
    __resetCircuitBreakerStateForTests();
    db = makeDb();
    svc = providerCircuitBreakerService(db);
    now = 1_000_000;
  });

  it("starts CLOSED and does not block", async () => {
    const result = await svc.checkAndBlock(ACCOUNT, now);
    expect(result.blocked).toBe(false);
    expect(result.state).toBe("CLOSED");
  });

  it("opens circuit after OPEN_THRESHOLD transient failures within window", async () => {
    for (let i = 0; i < 4; i++) {
      await svc.recordTransientFailure(ACCOUNT, now + i * 1000);
      const check = await svc.checkAndBlock(ACCOUNT, now + i * 1000);
      expect(check.blocked).toBe(false);
    }
    // 5th failure triggers open
    await svc.recordTransientFailure(ACCOUNT, now + 5000);
    const check = await svc.checkAndBlock(ACCOUNT, now + 5000);
    expect(check.blocked).toBe(true);
    expect(check.state).toBe("OPEN");
  });

  it("does not open circuit if failures are outside the 10-min window", async () => {
    // 4 old failures outside the window
    for (let i = 0; i < 4; i++) {
      await svc.recordTransientFailure(ACCOUNT, now - 11 * 60 * 1000 - i * 1000);
    }
    // 1 recent failure
    await svc.recordTransientFailure(ACCOUNT, now);
    const check = await svc.checkAndBlock(ACCOUNT, now);
    expect(check.blocked).toBe(false);
  });

  it("transitions OPEN → HALF_OPEN after recovery timeout", async () => {
    // Open circuit
    for (let i = 0; i < 5; i++) await svc.recordTransientFailure(ACCOUNT, now);
    expect((await svc.checkAndBlock(ACCOUNT, now)).blocked).toBe(true);

    // 15 min + 1 ms later
    const recovered = now + 15 * 60 * 1000 + 1;
    const check = await svc.checkAndBlock(ACCOUNT, recovered);
    expect(check.blocked).toBe(false);
    expect(check.state).toBe("HALF_OPEN");
  });

  it("blocks further probes in HALF_OPEN within 3 min interval", async () => {
    for (let i = 0; i < 5; i++) await svc.recordTransientFailure(ACCOUNT, now);
    // Advance to HALF_OPEN
    await svc.checkAndBlock(ACCOUNT, now + 15 * 60 * 1000 + 1);

    // Second check within 3 min → blocked
    const check = await svc.checkAndBlock(ACCOUNT, now + 15 * 60 * 1000 + 2);
    expect(check.blocked).toBe(true);
    expect(check.state).toBe("HALF_OPEN");
  });

  it("closes circuit on successful probe", async () => {
    for (let i = 0; i < 5; i++) await svc.recordTransientFailure(ACCOUNT, now);
    const probeTime = now + 15 * 60 * 1000 + 1;
    await svc.checkAndBlock(ACCOUNT, probeTime); // enters HALF_OPEN

    await svc.recordSuccess(ACCOUNT, probeTime + 1000);
    const check = await svc.checkAndBlock(ACCOUNT, probeTime + 2000);
    expect(check.blocked).toBe(false);
    expect(check.state).toBe("CLOSED");
  });

  it("reopens with doubled timeout on failed HALF_OPEN probe", async () => {
    for (let i = 0; i < 5; i++) await svc.recordTransientFailure(ACCOUNT, now);
    const probeTime = now + 15 * 60 * 1000 + 1;
    await svc.checkAndBlock(ACCOUNT, probeTime); // enters HALF_OPEN
    await svc.recordTransientFailure(ACCOUNT, probeTime + 500);

    // Circuit reopens with 30 min recovery
    const check = await svc.checkAndBlock(ACCOUNT, probeTime + 1000);
    expect(check.blocked).toBe(true);
    expect(check.state).toBe("OPEN");

    // Not yet recovered after 15 min from probe
    expect((await svc.checkAndBlock(ACCOUNT, probeTime + 15 * 60 * 1000)).blocked).toBe(true);
    // Recovered after 30 min from failure (openedAt = probeTime + 500)
    expect((await svc.checkAndBlock(ACCOUNT, probeTime + 500 + 30 * 60 * 1000 + 1)).blocked).toBe(false);
  });

  it("caps recovery timeout at 1 hour", async () => {
    for (let i = 0; i < 5; i++) await svc.recordTransientFailure(ACCOUNT, now);
    let probeTime = now + 15 * 60 * 1000 + 1;
    // Force multiple HALF_OPEN → OPEN cycles
    for (let cycle = 0; cycle < 10; cycle++) {
      await svc.checkAndBlock(ACCOUNT, probeTime); // HALF_OPEN
      await svc.recordTransientFailure(ACCOUNT, probeTime + 500);
      probeTime += 2 * 60 * 60 * 1000; // advance 2h to ensure we're past any recovery
    }
    const metrics = svc.getMetrics(probeTime);
    const m = metrics.find((x) => x.providerAccountId === ACCOUNT);
    expect(m?.recoveryTimeoutMs).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it("getMetrics includes open minutes", async () => {
    for (let i = 0; i < 5; i++) await svc.recordTransientFailure(ACCOUNT, now);
    const laterNow = now + 30 * 60 * 1000;
    const metrics = svc.getMetrics(laterNow);
    const m = metrics.find((x) => x.providerAccountId === ACCOUNT);
    expect(m?.openMinutesTotal).toBeCloseTo(30, 0);
  });

  it("reset closes an open circuit", async () => {
    for (let i = 0; i < 5; i++) await svc.recordTransientFailure(ACCOUNT, now);
    await svc.reset(ACCOUNT, now + 1000);
    const check = await svc.checkAndBlock(ACCOUNT, now + 2000);
    expect(check.blocked).toBe(false);
    expect(check.state).toBe("CLOSED");
  });
});
