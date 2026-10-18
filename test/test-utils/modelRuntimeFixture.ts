import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { onTestFinished } from 'vitest'

/** Own temporary model and auth files until the test finishes; never refresh over the network. */
export async function modelRuntimeFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ultimate-models-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const modelsPath = join(directory, 'models.json')
  const runtime = await ModelRuntime.create({
    authPath: join(directory, 'auth.json'),
    modelsPath,
    modelsStorePath: join(directory, 'models-store.json'),
    refreshOnCreate: false,
  })
  return { runtime, modelsPath }
}
