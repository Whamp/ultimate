import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { openRecoveryCatalogue } from './recovery-catalogue.ts'

async function temporaryCatalogue(testContext: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'ultimate-recovery-'))
  testContext.after(() => rm(home, { recursive: true, force: true }))
  const project = join(home, 'project-a')
  await mkdir(project)
  await mkdir(join(home, 'effects'))
  return { home, project }
}

async function killAtEffectBoundary(home: string, project: string, mode: 'safe' | 'counterfeit') {
  const child = fork(
    new URL('./crash-worker.test-utils.ts', import.meta.url),
    [home, project, mode],
    {
      execArgv: [],
      cwd: home,
      env: { HOME: home, TMPDIR: home },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  )
  let diagnostics = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    diagnostics += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    diagnostics += chunk.toString()
  })
  const exited = once(child, 'exit')
  // This deadline is a broken-worker guard, not the crash trigger.
  const deadline = setTimeout(() => child.kill('SIGKILL'), 15_000)
  try {
    const boundary = new Promise<void>((resolve, reject) => {
      child.once('message', (message) => {
        try {
          assert.equal(message, 'effect-before-checkpoint')
          resolve()
        } catch (cause) {
          reject(cause)
        }
      })
      child.once('error', reject)
      child.once('exit', () =>
        reject(new Error(`Recovery worker exited before boundary: ${diagnostics}`)),
      )
    })
    await boundary
    assert(child.kill('SIGKILL'), 'Parent must kill a live process after the effect')
    const [code, signal] = await exited
    assert.equal(code, null)
    assert.equal(signal, 'SIGKILL')
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    await exited
  }
}

function assertOneEffect(effects: string[]) {
  assert.equal(effects.length, 1, 'Recovery must leave exactly one filesystem effect')
}

await test('canonical duplicate registration, postcompletion retry, distinct projects, visible failure', async (t) => {
  const { home, project } = await temporaryCatalogue(t)
  const alias = join(home, 'project-alias')
  await symlink(project, alias)
  const catalogue = await openRecoveryCatalogue({ home })
  t.after(() => catalogue.close())
  const ids = await Promise.all(
    Array.from({ length: 32 }, (_, index) =>
      catalogue.registerProject(index % 2 === 0 ? project : alias),
    ),
  )
  const first = ids[0]
  assert(first !== undefined)
  assert.equal(new Set(ids).size, 1)
  assert.equal((await catalogue.snapshotProjects()).length, 1)
  const receipt = await catalogue.harness.waitForTask(first, BACKGROUND_CONTEXT)
  assert.equal(receipt.state.outcome.status, 'completed')
  assert.equal(await catalogue.registerProject(alias), first)
  assert.deepEqual(
    (await catalogue.snapshotProjects()).map((item) => item.provision),
    [{ status: 'ready' }],
  )
  assertOneEffect(await readdir(join(home, 'effects')))

  const secondPath = join(home, 'project-b')
  await mkdir(secondPath)
  const second = await catalogue.registerProject(secondPath)
  assert.notEqual(second, first)
  assert.equal(
    (await catalogue.harness.waitForTask(second, BACKGROUND_CONTEXT)).state.outcome.status,
    'completed',
  )
  assert.equal((await catalogue.snapshotProjects()).length, 2)
  assert.equal((await readdir(join(home, 'effects'))).length, 2)

  // Reopen without scheduling so a real filesystem conflict is installed before execution.
  await catalogue.close()
  const reopened = await openRecoveryCatalogue({ home })
  t.after(() => reopened.close())
  const failurePath = join(home, 'project-failure')
  await mkdir(failurePath)
  const failed = await reopened.registerProject(failurePath)
  const failedRecord = (await reopened.snapshotProjects()).find((item) => item.taskId === failed)
  assert(failedRecord)
  await writeFile(failedRecord.effectPath, 'not a directory')
  const failureReceipt = await reopened.harness.waitForTask(failed, BACKGROUND_CONTEXT)
  assert.equal(failureReceipt.state.outcome.status, 'failed')
  const visible = (await reopened.snapshotProjects()).find(
    (item) => item.taskId === failed,
  )?.provision
  assert(visible?.status === 'failed')
  assert.match(visible.error, /not a directory/)
  assert.equal(await reopened.registerProject(failurePath), failed)
  assert.equal((await reopened.snapshotProjects()).length, 3)
})

await test('non-Error effect rejection becomes a meaningful failed catalogue record', async (t) => {
  const { home, project } = await temporaryCatalogue(t)
  const catalogue = await openRecoveryCatalogue({
    home,
    effect: async () => {
      // Deliberately violate the effect boundary's error contract to exercise normalization.
      // oxlint-disable-next-line typescript/only-throw-error
      throw 'injected-effect-denial'
    },
  })
  t.after(() => catalogue.close())
  const taskId = await catalogue.registerProject(project)
  const receipt = await catalogue.harness.waitForTask(taskId, BACKGROUND_CONTEXT)
  assert.equal(receipt.state.outcome.status, 'failed')
  const provision = (await catalogue.snapshotProjects())[0]?.provision
  assert.ok(provision?.status === 'failed')
  assert.equal(provision.error, 'Recovery effect failed: injected-effect-denial')
  assert.equal(await catalogue.registerProject(project), taskId)
  assert.deepEqual(await readdir(join(home, 'effects')), [])
})

await test('SIGKILL after idempotent effect, reopen same SQLite, replay, then stable retry', async (t) => {
  const { home, project } = await temporaryCatalogue(t)
  await killAtEffectBoundary(home, project, 'safe')
  const beforeEffects = await readdir(join(home, 'effects'))
  assertOneEffect(beforeEffects)
  const [effect] = beforeEffects
  assert(effect)
  const originalInode = (await stat(join(home, 'effects', effect))).ino
  let replayAttempts = 0
  const catalogue = await openRecoveryCatalogue({
    home,
    afterEffect: async () => {
      replayAttempts += 1
    },
  })
  t.after(() => catalogue.close())
  const [record] = await catalogue.snapshotProjects()
  assert(record)
  assert.equal((await catalogue.snapshotProjects()).length, 1)
  assert.equal(record.provision.status, 'provisioning')
  const pending = await catalogue.harness.getTask(record.taskId, BACKGROUND_CONTEXT)
  assert(pending)
  assert.equal(pending.state.status, 'pending')
  assert.deepEqual(pending.state.checkpoint, { phase: 'provision' })
  const retryIds = await Promise.all(
    Array.from({ length: 16 }, () => catalogue.registerProject(project)),
  )
  assert(retryIds.every((id) => id === record.taskId))
  catalogue.harness.resume()
  const receipt = await catalogue.harness.waitForTask(record.taskId, BACKGROUND_CONTEXT)
  assert.equal(receipt.state.outcome.status, 'completed')
  assert.equal(replayAttempts, 1, 'The uncheckpointed phase must really run again')
  assert.deepEqual(await readdir(join(home, 'effects')), beforeEffects)
  assert.equal((await stat(record.effectPath)).ino, originalInode)
  assert.equal(await catalogue.registerProject(project), record.taskId)
  assert.equal((await catalogue.snapshotProjects()).length, 1)
  assert.equal((await catalogue.snapshotProjects())[0]?.provision.status, 'ready')

  await catalogue.close()
  const completed = await openRecoveryCatalogue({ home })
  t.after(() => completed.close())
  assert.equal(await completed.registerProject(project), record.taskId)
  assert.equal(
    (await completed.harness.waitForTask(record.taskId, BACKGROUND_CONTEXT)).state.outcome.status,
    'completed',
  )
  assert.deepEqual(await readdir(join(home, 'effects')), beforeEffects)
  assert.equal((await completed.snapshotProjects()).length, 1)
  assert.equal((await completed.snapshotProjects())[0]?.provision.status, 'ready')
})

await test('expected-red counterfeit: durable replay does not deduplicate arbitrary filesystem effects', async (t) => {
  const { home, project } = await temporaryCatalogue(t)
  await killAtEffectBoundary(home, project, 'counterfeit')
  assertOneEffect(await readdir(join(home, 'effects')))
  const catalogue = await openRecoveryCatalogue({
    home,
    effect: async () => {
      await mkdtemp(`${home}/effects/counterfeit-`)
    },
  })
  t.after(() => catalogue.close())
  const [record] = await catalogue.snapshotProjects()
  assert(record)
  assert.equal(record.provision.status, 'provisioning')
  const receipt = await catalogue.harness.waitForTask(record.taskId, BACKGROUND_CONTEXT)
  assert.equal(receipt.state.outcome.status, 'completed')
  assert.equal((await catalogue.snapshotProjects()).length, 1)
  assert.equal((await catalogue.snapshotProjects())[0]?.provision.status, 'ready')
  const effects = await readdir(join(home, 'effects'))
  assert.equal(effects.length, 2)
  assert.throws(
    () => assertOneEffect(effects),
    (cause: unknown) =>
      cause instanceof assert.AssertionError && cause.actual === 2 && cause.expected === 1,
  )
  t.diagnostic(
    'EXPECTED RED: the same one-effect oracle rejects the real non-idempotent replay (2 effects)',
  )
})
