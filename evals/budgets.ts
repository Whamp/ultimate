// Keep the runner ceiling unchanged; leave diagnostic/cleanup time after all active turns.
const OUTER_TEST_MS = 300_000
const DIAGNOSTIC_CLEANUP_MS = 30_000

/** Eval timing limits in milliseconds, shared by config, per-test setup and failure diagnostics. */
export const EVAL_BUDGETS = {
  outerTestMs: OUTER_TEST_MS,
  diagnosticCleanupMs: DIAGNOSTIC_CLEANUP_MS,
  activeTestMs: OUTER_TEST_MS - DIAGNOSTIC_CLEANUP_MS,
  turnMs: 240_000,
} as const
