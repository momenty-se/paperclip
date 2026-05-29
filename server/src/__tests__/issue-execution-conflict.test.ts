import { describe, expect, it } from "vitest";
import { isOpenRoutineExecutionConflict } from "../services/issue-execution-conflict.js";

describe("isOpenRoutineExecutionConflict", () => {
  it("detects direct PostgresError with code + constraint", () => {
    const err = { code: "23505", constraint: "issues_open_routine_execution_uq" };
    expect(isOpenRoutineExecutionConflict(err)).toBe(true);
  });

  it("detects the conflict via the DrizzleQueryError cause chain", () => {
    const cause = { code: "23505", constraint: "issues_open_routine_execution_uq" };
    const wrapped = { name: "DrizzleQueryError", message: "Failed query: update issues...", cause };
    expect(isOpenRoutineExecutionConflict(wrapped)).toBe(true);
  });

  it("falls back to the message when the constraint property is missing", () => {
    const err = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "issues_open_routine_execution_uq"',
    };
    expect(isOpenRoutineExecutionConflict(err)).toBe(true);
  });

  it("returns false for unrelated 23505 violations", () => {
    expect(
      isOpenRoutineExecutionConflict({ code: "23505", constraint: "issues_active_liveness_recovery_incident_uq" }),
    ).toBe(false);
  });

  it("returns false for non-23505 PostgresErrors", () => {
    expect(
      isOpenRoutineExecutionConflict({ code: "23503", constraint: "issues_open_routine_execution_uq" }),
    ).toBe(false);
  });

  it("returns false for null/undefined/strings/numbers", () => {
    expect(isOpenRoutineExecutionConflict(null)).toBe(false);
    expect(isOpenRoutineExecutionConflict(undefined)).toBe(false);
    expect(isOpenRoutineExecutionConflict("23505")).toBe(false);
    expect(isOpenRoutineExecutionConflict(23505)).toBe(false);
  });

  it("does not loop forever on a cyclic cause chain", () => {
    const a: { code?: string; cause?: unknown } = {};
    const b: { cause?: unknown } = { cause: a };
    a.cause = b;
    expect(isOpenRoutineExecutionConflict(a)).toBe(false);
  });
});
