import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueLabels,
  issues,
  labels,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: "claude_auth_required",
    errorMessage: "Please log in. Run `claude login` first.",
    provider: "anthropic",
    model: "sonnet-test",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat auth recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

async function waitForCondition(
  fn: () => Promise<boolean>,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await fn();
}

describeEmbeddedPostgres("heartbeat auth recovery issue creation", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-auth-recovery-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      if (!runs.some((run) => run.status === "queued" || run.status === "running")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("creates and reuses one open auth recovery issue per provider", async () => {
    const companyId = randomUUID();
    const workerAgentId = randomUUID();
    const devopsAgentId = randomUUID();
    const sourceIssueId = randomUUID();
    const secondIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: devopsAgentId,
        companyId,
        name: "DevOps",
        role: "devops",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
      {
        id: workerAgentId,
        companyId,
        name: "ClaudeWorker",
        role: "engineer",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
    ]);

    await db.insert(issues).values([
      {
        id: sourceIssueId,
        companyId,
        title: "Primary source issue",
        status: "todo",
        priority: "high",
        assigneeAgentId: workerAgentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: secondIssueId,
        companyId,
        title: "Second source issue",
        status: "todo",
        priority: "high",
        assigneeAgentId: workerAgentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);

    const firstRun = await heartbeat.wakeup(workerAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: sourceIssueId },
      contextSnapshot: { issueId: sourceIssueId, wakeReason: "issue_assigned" },
    });
    expect(firstRun).not.toBeNull();
    const finishedFirstRun = await waitForRunToFinish(heartbeat, firstRun!.id);
    expect(finishedFirstRun?.status).toBe("failed");
    expect(finishedFirstRun?.errorCode).toBe("claude_auth_required");
    await waitForCondition(async () => {
      const rows = await db
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.originKind, "admin_recovery"),
            eq(issues.originId, "claude"),
          ),
        );
      return rows.length === 1;
    });

    let recoveryIssues = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "admin_recovery"),
          eq(issues.originId, "claude"),
        ),
      );
    expect(recoveryIssues).toHaveLength(1);
    expect(recoveryIssues[0]?.title).toBe("Auth recovery: claude");
    expect(recoveryIssues[0]?.status).toBe("todo");
    expect(recoveryIssues[0]?.priority).toBe("critical");
    expect(recoveryIssues[0]?.assigneeAgentId).toBe(devopsAgentId);
    expect(recoveryIssues[0]?.description).toContain("Run `claude login` on the VM");
    expect(recoveryIssues[0]?.description).toContain("`T");

    const recoveryLabelNames = await db
      .select({ name: labels.name })
      .from(issueLabels)
      .innerJoin(labels, eq(labels.id, issueLabels.labelId))
      .where(eq(issueLabels.issueId, recoveryIssues[0]!.id));
    expect(recoveryLabelNames.map((label) => label.name).sort()).toEqual(["auth-recovery", "automated"]);

    const secondRun = await heartbeat.wakeup(workerAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: secondIssueId },
      contextSnapshot: { issueId: secondIssueId, wakeReason: "issue_assigned" },
    });
    expect(secondRun).not.toBeNull();
    const finishedSecondRun = await waitForRunToFinish(heartbeat, secondRun!.id);
    expect(finishedSecondRun?.status).toBe("failed");
    expect(finishedSecondRun?.errorCode).toBe("claude_auth_required");
    await waitForCondition(async () => {
      const rows = await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.createdByRunId, secondRun!.id));
      return rows.length > 0;
    });

    recoveryIssues = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "admin_recovery"),
          eq(issues.originId, "claude"),
        ),
      );
    expect(recoveryIssues).toHaveLength(1);
  });
});
