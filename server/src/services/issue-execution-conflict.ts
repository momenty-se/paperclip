// Detects PostgreSQL 23505 violations against `issues_open_routine_execution_uq`.
// Walks the error's `cause` chain so the drizzle `DrizzleQueryError` wrapper does
// not hide the underlying `code` / `constraint` / `message` exposed by postgres-js.
export function isOpenRoutineExecutionConflict(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const maybe = current as { code?: string; constraint?: string; message?: string; cause?: unknown };
    if (
      maybe.code === "23505" &&
      (
        maybe.constraint === "issues_open_routine_execution_uq" ||
        (typeof maybe.message === "string" && maybe.message.includes("issues_open_routine_execution_uq"))
      )
    ) {
      return true;
    }
    current = maybe.cause;
  }
  return false;
}
