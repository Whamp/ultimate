import { join } from 'node:path'
import { setImmediate as yieldToIO } from 'node:timers/promises'
import { awaitWithContext } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTask, defineTool } from '@earendil-works/pi-durable'
import type { Conversation, Harness } from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import { evalTestDeadline, readEvalDiagnostics, waitForTurn } from '../evals/turn.ts'
import { context, prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import { temp } from './helpers.ts'

let opened: OpenHost | undefined
afterEach(async () => {
  await opened?.close()
  opened = undefined
  vi.useRealTimers()
})

const sleeper = defineTask<null, { phase: 'sleep' }, null>({
  name: 'eval.background-sleeper',
  version: 1,
  initial: () => ({ phase: 'sleep' }),
  phases: {
    sleep: async (_task, _runtime, caller) => {
      await awaitWithContext(new Promise<void>(() => {}), caller)
    },
  },
  abort: (_task, runtime, caller) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), caller),
})

async function fixture() {
  const home = await temp('ultimate-eval-turn-')
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home: join(home, 'state'),
    faux: true,
  })
  let held = false
  let release!: () => void
  prepared.registry.install(
    defineExtension({
      name: 'eval-hold',
      tasks: [sleeper],
      tools: [
        defineTool({
          name: 'hold',
          description: 'Wait for release',
          parameters: Type.Object({ reason: Type.String() }),
          // The tool has no effects; replaying its wait is safe.
          replay: 'safe',
          execute: async (_args, _api, ctx) => {
            held = true
            await awaitWithContext(
              new Promise<void>((resolve) => {
                release = resolve
              }),
              ctx,
            )
            return { output: [{ type: 'text', text: 'Released' }] }
          },
        }),
      ],
    }),
  )
  prepared.faux!.setResponses([
    () =>
      fauxAssistantMessage([fauxToolCall('hold', { reason: 'known diagnostic blocker' })], {
        stopReason: 'toolUse',
      }),
    () => fauxAssistantMessage([fauxText('done')]),
  ])
  opened = await prepared.open()
  const conversation = opened.root
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
  return {
    prepared,
    harness: opened.harness,
    conversation,
    held: () => held,
    release: () => release(),
  }
}

async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 1000; i++) {
    if (await predicate()) return
    await vi.advanceTimersByTimeAsync(1)
    await yieldToIO()
  }
  throw new Error('Known harness state not reached')
}
function turn(
  harness: Harness,
  conversation: Conversation,
  deadline = performance.now() + 270_000,
) {
  return waitForTurn(
    harness,
    conversation,
    () => conversation.submit({ type: 'input', content: 'HOLD' }, context),
    deadline,
  )
}

it('concurrent evals retain independent active-test deadlines across async work', async () => {
  const deadlines = await Promise.all(
    [270_000, 280_000].map((deadline) =>
      evalTestDeadline.run(deadline, async () => {
        await yieldToIO()
        return evalTestDeadline.getStore()
      }),
    ),
  )
  expect(deadlines).toEqual([270_000, 280_000])
  expect(evalTestDeadline.getStore()).toBeUndefined()
})

it('deadline identifies a real held tool, its arguments, submission and whole-harness scope', async () => {
  const f = await fixture()
  const result = turn(f.harness, f.conversation).catch((error: Error) => error)
  await until(f.held)
  await vi.advanceTimersByTimeAsync(240_000)
  const error = await result
  expect(error).toBeInstanceOf(Error)
  expect(String(error)).toContain('awaiting-submission')
  expect(String(error)).toContain('known diagnostic blocker')
  expect(String(error)).toContain('pi.tool')
  expect(String(error)).toContain('"phase"')
  expect(String(error)).toContain('"owner"')
  expect(String(error)).toContain('"background": false')
  expect(String(error)).toContain('"status": "placed"')
  expect(String(error)).toContain('"turnBudgetMs": 240000')
  expect(String(error)).toContain('"testDeadlineMs"')
  expect(String(error)).toContain('"recentEntries"')
  expect(String(error)).toContain('"live"')
  f.release()
})

it('terminal provider failure is not mislabeled idle timeout while unrelated work is held', async () => {
  const f = await fixture()
  const heldSubmission = await f.conversation.submit({ type: 'input', content: 'HOLD' }, context)
  await until(f.held)
  f.prepared.faux!.setResponses([
    () =>
      fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'terminal provider failure' }),
  ])
  const other = await f.harness.createConversation(
    { ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } },
    context,
  )
  let settled = false
  const result = turn(f.harness, other)
    .catch((error: Error) => error)
    .finally(() => {
      settled = true
    })
  await until(async () =>
    (await f.harness.inspect(context)).submissions.every((s) => s.id === heldSubmission.id),
  )
  await vi.advanceTimersByTimeAsync(240_000)
  const error = await result
  expect(settled).toBe(true)
  expect(String(error)).toContain('Model turn failed: terminal provider failure')
  expect(String(error)).not.toContain('Eval turn deadline exceeded')
  f.release()
})

it('a successful target can time out awaiting whole-harness idle on another conversation', async () => {
  const f = await fixture()
  await f.conversation.submit({ type: 'input', content: 'HOLD' }, context)
  await until(f.held)
  const other = await f.harness.createConversation(
    { ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } },
    context,
  )
  const result = turn(f.harness, other).catch((error: Error) => error)
  await until(async () =>
    (await readEvalDiagnostics(f.harness, other, 0)).recentEntries.some(
      (entry) => entry.kind === 'pi.assistant',
    ),
  )
  await vi.advanceTimersByTimeAsync(240_000)
  const error = await result
  expect(String(error)).toContain('awaiting-idle')
  expect(String(error)).toContain(`"targetConversationId": ${other.id}`)
  expect(String(error)).toContain('"status": "done"')
  expect(String(error)).toContain('whole-harness ownerless conversations')
  expect(String(error)).toContain('known diagnostic blocker')
  f.release()
})

it('successful turns finish while a genuine background sleeper remains live', async () => {
  const f = await fixture()
  const backgroundId = await f.conversation.commit(
    (tx) =>
      tx.createTask(sleeper, null, {
        ownership: { kind: 'conversation' },
        background: true,
      }),
    context,
  )
  let settled = false
  const result = turn(f.harness, f.conversation).finally(() => {
    settled = true
  })
  await until(f.held)
  f.release()
  await until(() => settled)
  await result
  const facts = await readEvalDiagnostics(f.harness, f.conversation, 0)
  expect(facts.nonBackgroundTasks).toEqual([])
  expect(facts.backgroundTasks).toEqual([
    expect.objectContaining({
      id: backgroundId,
      kind: 'eval.background-sleeper',
      state: { status: 'running', phase: 'sleep' },
    }),
  ])
  expect(facts.toolCalls).toEqual([
    expect.objectContaining({ name: 'hold', arguments: { reason: 'known diagnostic blocker' } }),
  ])
  await f.harness.abortTask(backgroundId, context)
  await f.harness.waitForTask(backgroundId, context)
})

it('later turns cannot restart a fresh 240s beyond the shared test deadline', async () => {
  const f = await fixture()
  const deadline = performance.now() + 270_000
  await vi.advanceTimersByTimeAsync(230_000)
  let settled = false
  const result = turn(f.harness, f.conversation, deadline)
    .catch((error: Error) => error)
    .finally(() => {
      settled = true
    })
  await until(f.held)
  await vi.advanceTimersByTimeAsync(40_000)
  expect(settled).toBe(true)
  expect(String(await result)).toContain('"testDeadlineMs": 270000')
  f.release()
})
