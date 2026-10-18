import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { expect } from 'vitest'
import { context } from '../../server/harness.ts'
import { Workspaces } from '../../extensions/workspaces/workspaces.ts'
import type { WorkspaceIndex } from '../../extensions/workspaces/types.ts'
import { until } from '../helpers.ts'
import type { workspaceFixture as fixture } from './workspace-fixture.ts'

/** Wait for the owned landing to finish and check its durable reports before returning their text. */
export async function submittedWorkspaceReports(
  f: Awaited<ReturnType<typeof fixture>>,
  id: ConversationId,
) {
  await until(async () => {
    const index = (await f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
    return !index.queue.length && !Object.keys(index.landers).length
  })
  const conversation = (await f.opened.harness.conversation(id, context))!
  await conversation.waitForIdle(context)
  const view = await conversation.viewState(context)
  try {
    const reports = view.value.entries.filter((entry) => entry.kind === 'workspaces.lander-report')
    for (const report of reports) {
      const { id: submission, outcome } = report.data as {
        id: string
        outcome: WorkspaceIndex['results'][string]
      }
      const index = (await f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
      expect(outcome).toEqual(index.results[submission])
      expect(outcome.lander).toBeGreaterThan(0)
      expect(outcome.steps.length).toBeGreaterThan(0)
    }
    return reports.map((entry) => JSON.stringify(entry.model))
  } finally {
    view.dispose()
  }
}
