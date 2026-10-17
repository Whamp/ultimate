import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { openRecoveryCatalogue } from './recovery-catalogue.ts'

const [home, project, mode] = process.argv.slice(2)
assert(home && project && (mode === 'safe' || mode === 'counterfeit'))
assert(process.connected, 'Recovery crash worker requires a parent IPC channel')
const catalogue = await openRecoveryCatalogue({
  home,
  effect:
    mode === 'counterfeit'
      ? async () => {
          await mkdtemp(`${home}/effects/counterfeit-`)
        }
      : undefined,
  afterEffect: async () => {
    // No task checkpoint can occur until this hook returns. SIGKILL must interrupt it.
    process.send?.('effect-before-checkpoint')
    await new Promise<void>(() => {})
  },
})
await Promise.all(Array.from({ length: 16 }, () => catalogue.registerProject(project)))
catalogue.harness.resume()
