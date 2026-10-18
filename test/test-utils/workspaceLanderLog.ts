import { realpath } from 'node:fs/promises'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { context } from '../../server/harness.ts'
import { Metadata } from '../../server/metadata.ts'
import { Workspaces } from '../../extensions/workspaces/workspaces.ts'
import type { LanderEntry } from '../../extensions/workspaces/types.ts'
import type { workspaceFixture as fixture } from './workspace-fixture.ts'

/** Read the owned project source's lander conversation and its durable landing log. */
export async function workspaceLanderLog(f: Awaited<ReturnType<typeof fixture>>) {
  const index = (await f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
  const id = index.landerConversations[await realpath(f.projectRoot)] as ConversationId
  const conversation = (await f.opened.harness.conversation(id, context))!
  const view = await conversation.viewState(context)
  try {
    return {
      id,
      metadata: await f.opened.harness.snapshot(Metadata, id, context),
      cwd: (await conversation.agent(context)).cwd,
      kinds: view.value.entries.map((entry) => entry.kind),
      log: view.value.entries
        .filter((entry) => entry.kind === 'ultimate.lander')
        .map((entry) => entry.data as LanderEntry),
    }
  } finally {
    view.dispose()
  }
}
