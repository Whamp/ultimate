import { aroundEach } from 'vitest'
import { EVAL_BUDGETS } from './budgets.ts'
import { evalTestContext } from './turn.ts'

// Concurrent tests get independent deadlines; every fixture/turn in one test shares its budget.
aroundEach(async (runTest, { task }) => {
  await evalTestContext.run(
    {
      testId: task.id,
      deadlineMs: performance.now() + EVAL_BUDGETS.activeTestMs,
    },
    runTest,
  )
})
