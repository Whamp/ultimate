import type { JsonObject } from '@earendil-works/pi-durable'
import {
  workspaceRepository as repository,
  workspaceFixture as fixture,
} from './workspace-fixture.ts'

/** Open a test-owned Git workspace with temporary lander settings and an optional faux board. */
export async function workspaceLanderFixture(
  settings: JsonObject,
  existing?: Awaited<ReturnType<typeof repository>>,
  boardEnabled = false,
) {
  const f = await fixture([], existing, boardEnabled)
  f.host.projectSettings = async () => ({ lander: settings })
  return f
}
