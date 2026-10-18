import { defineConfig } from 'vitest/config'
import { EVAL_BUDGETS } from './budgets.ts'

export default defineConfig({
  test: {
    include: ['evals/**/*.eval.ts'],
    setupFiles: ['./evals/setup.ts'],
    testTimeout: EVAL_BUDGETS.outerTestMs,
    hookTimeout: EVAL_BUDGETS.outerTestMs,
    maxWorkers: 4,
    maxConcurrency: 4,
    sequence: { concurrent: true },
    reporters: ['./evals/reporter.ts'],
    retry: 0,
  },
})
