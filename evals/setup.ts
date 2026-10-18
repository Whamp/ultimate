import { aroundEach } from 'vitest'
import { evalTestDeadline } from './turn.ts'

// Concurrent tests get independent deadlines; every fixture/turn in one test shares its budget.
aroundEach(async (runTest) => {
  await evalTestDeadline.run(performance.now() + 270_000, runTest)
})
