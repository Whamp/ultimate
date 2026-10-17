import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TestContext } from 'node:test'
import { decodeTransportPreview } from './transport-boundary.js'
import type { TransportPreview } from './types.ts'

/** Starts the actual launcher entrypoint; test cleanup owns only this process and its temp home. */
export async function launchTransportFixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'ultimate-transport-test-'))
  const launcher = spawn(
    process.execPath,
    [fileURLToPath(new URL('./transport-launch.ts', import.meta.url))],
    {
      env: { PATH: process.env.PATH, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const exited = once(launcher, 'exit')
  const stop = async () => {
    if (launcher.exitCode === null && launcher.signalCode === null) {
      launcher.kill('SIGTERM')
      const deadline = setTimeout(() => launcher.kill('SIGKILL'), 10000)
      try {
        await exited
      } finally {
        clearTimeout(deadline)
      }
    }
  }
  t.after(async () => {
    await stop()
    await rm(home, { recursive: true, force: true })
  })
  let output = ''
  let diagnostics = ''
  launcher.stderr.on('data', (chunk: Buffer) => {
    diagnostics += chunk.toString()
  })
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const receipt = new Promise<TransportPreview>((resolve, reject) => {
      // A broken-launcher guard, not a sleep or a readiness substitute.
      deadline = setTimeout(
        () => reject(new Error(`Transport test launcher timed out: ${diagnostics}`)),
        60000,
      )
      launcher.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        // The launcher emits one pretty-printed JSON receipt, terminated by its outer brace.
        if (output.endsWith('\n}\n')) {
          try {
            resolve(decodeTransportPreview(output))
          } catch (cause) {
            reject(new Error('Transport test launcher receipt is invalid', { cause }))
          }
        }
      })
    })
    const preview = await Promise.race([
      receipt,
      exited.then(() => {
        throw new Error(`Transport test launcher exited before readiness: ${diagnostics}`)
      }),
    ])
    return { preview, home, stop }
  } finally {
    clearTimeout(deadline)
  }
}
