// Load the existing shared faux pacing seam before prepareHarness imports its provider.
import { removeTemp, temp } from './helpers.ts'
import { ok as assert } from 'node:assert/strict'
import { join } from 'node:path'
import { setImmediate as yieldToIO } from 'node:timers/promises'
import { awaitWithContext } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord'
import { Type } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { createEventBus } from '@earendil-works/pi-coding-agent'
import type { ConversationId, TaskGraph, TaskId } from '@earendil-works/pi-durable'
import * as fc from 'fast-check'
import { expect, it, vi } from 'vitest'
import automations, { actions, Automations } from '../extensions/automations/server.ts'
import type { Automation } from '../extensions/automations/server.ts'
import type { ActionContext } from '../server/actions.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import type { ExtensionInfo } from '../shared/protocol.ts'
import { context, prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'

// Independent lifecycle model: no production parser, next-fire calculator or scheduler is used here.
// Cron is deliberately UTC and regular minute divisors; calendar/DST search belongs to schedule properties.
interface Spec {
  kind: 'at' | 'every' | 'cron'
  n: number
}
type ClockSchedule =
  | { kind: 'at'; time: number }
  | { kind: 'every'; interval: number }
  | { kind: 'cron'; interval: number }
interface ExpectedRun {
  firedAt: number
  status: 'running' | 'done' | 'skipped'
}
interface Model {
  enabled: boolean
  schedule: ClockSchedule
  due?: number
  runs: ExpectedRun[]
}
type Reach = Map<string, number>
function mark(reach: Reach, category: string) {
  reach.set(category, (reach.get(category) ?? 0) + 1)
}
type Placement = 'before' | 'woken' | 'after'
type Operation =
  | { kind: 'pause' | 'resume' | 'rename' | 'manual' | 'release' }
  | { kind: 'update'; spec: Spec }
  | { kind: 'tick'; edge: -1 | 0 | 1 }
  | { kind: 'race'; mutation: 'pause' | 'update'; spec: Spec; placement: Placement }

function schedule(spec: Spec, now: number): ClockSchedule {
  if (spec.kind === 'at') {
    return { kind: 'at', time: now + spec.n * 1000 }
  }
  return { kind: spec.kind, interval: spec.n * (spec.kind === 'cron' ? 60000 : 1000) }
}
function input(s: ClockSchedule) {
  if (s.kind === 'at') {
    return `at ${new Date(s.time).toISOString()}`
  }
  if (s.kind === 'every') {
    return `every ${s.interval / 1000}s`
  }
  return `cron "*/${s.interval / 60000} * * * *" UTC`
}
function next(s: ClockSchedule, now: number) {
  if (s.kind === 'at') {
    return s.time
  }
  return s.kind === 'every' ? now + s.interval : (Math.floor(now / s.interval) + 1) * s.interval
}
function fire(m: Model, now: number, scheduled = false) {
  m.runs.push({
    firedAt: now,
    status: m.runs.some((r) => r.status === 'running') ? 'skipped' : 'running',
  })
  if (scheduled) {
    if (m.schedule.kind === 'at') {
      m.enabled = false
      delete m.due
    } else {
      m.due = next(m.schedule, now)
    }
  }
}
function mutate(m: Model, kind: 'pause' | 'update', spec: Spec, now: number) {
  if (kind === 'pause') {
    m.enabled = false
    delete m.due
  } else {
    const updated = schedule(spec, now)
    if (JSON.stringify(updated) !== JSON.stringify(m.schedule)) {
      delete m.due
    }
    m.schedule = updated
    if (m.enabled) {
      m.due ??= next(m.schedule, now)
    }
  }
}
function projection(m: Model) {
  const s = m.schedule
  const persisted =
    s.kind === 'at'
      ? { kind: 'at', time: new Date(s.time).toISOString() }
      : s.kind === 'every'
        ? { kind: 'every', ms: s.interval }
        : { kind: 'cron', expr: `*/${s.interval / 60000} * * * *`, tz: 'UTC' }
  return { enabled: m.enabled, schedule: persisted, nextAt: m.due, runs: m.runs }
}
function observed(a: Automation) {
  return {
    enabled: a.enabled,
    schedule: a.schedule,
    nextAt: a.nextAt,
    runs: a.runs.map(({ firedAt, status }) => ({ firedAt, status })),
  }
}

// Traverse the PUBLIC ownership graph, not all session tasks. A background task's child
// conversation may have ordinary work without holding root idle (TaskOptions.background).
function ordinaryScope(graph: TaskGraph, conversation: ConversationId) {
  const conversations = new Set([conversation])
  const included = new Set<number>()
  let changed = true
  while (changed) {
    changed = false
    for (const task of Object.values(graph.tasks)) {
      if (
        !task.background &&
        !included.has(task.id) &&
        (task.owner ? included.has(task.owner) : conversations.has(task.conversationId))
      ) {
        included.add(task.id)
        for (const child of task.conversations) {
          conversations.add(child)
        }
        changed = true
      }
    }
  }
  return [...included]
}

function unavailable(): never {
  throw new Error('Automation lifecycle fixture must not use unrelated host capabilities')
}

async function fixture(now: number) {
  const root = await temp('ultimate-lifecycle-property-')
  const prepared = await prepareHarness({
    ultimateRoot: root,
    userHome: join(root, 'user'),
    home: join(root, 'home'),
    faux: true,
  })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(now)
  const held = new Map<ConversationId, () => void>()
  let opened: OpenHost
  prepared.registry.install(
    defineExtension({
      name: 'subagents',
      tools: [
        defineTool({
          name: 'hold',
          description: 'Hold this run until the test releases it',
          parameters: Type.Object({}),
          // The test-owned promise has no external effects.
          replay: 'safe',
          execute: async (...[, api, ctx]) => {
            try {
              await awaitWithContext(
                new Promise<void>((resolve) => {
                  held.set(api.conversationId, resolve)
                }),
                ctx,
              )
              return { output: [{ type: 'text', text: 'released' }] }
            } finally {
              held.delete(api.conversationId)
            }
          },
        }),
      ],
    }),
  )
  const host: ExtensionHost = {
    ...prepared,
    events: createEventBus(),
    access: { allow: unavailable },
    notice: unavailable,
    provide: unavailable,
    use: unavailable,
    resource: unavailable,
    onClose: unavailable,
    system: unavailable,
    conversations: unavailable,
    projects: unavailable,
    projectSetup: unavailable,
    projectSettings: unavailable,
    projectExtensions: unavailable,
    setProjectDecision: unavailable,
    reloadExtensions: unavailable,
    invoke: unavailable,
    doc: unavailable,
    service: () => ({ update: () => {}, dispose: () => {} }),
    onOpen: () => {},
    harness: () => opened.harness,
    metadata: Metadata,
    extensions: (): ExtensionInfo[] => [
      {
        name: 'subagents',
        enabled: true,
        source: 'builtin',
        layer: 'default',
        path: root,
        actions: [],
        facets: { server: true, web: false },
      },
    ],
  }
  prepared.registry.install(automations(host))
  const faux = prepared.faux
  assert(faux, 'prepareHarness({faux:true}) must supply the public faux handle')
  let creation: { name: string; prompt: string; schedule: string } | undefined
  const route: FauxResponseFactory = (transcript) => {
    faux.appendResponses([route])
    const last = transcript.messages.findLast((m) => m.role !== 'system')
    assert(last, 'A faux generation must have an admitted message')
    if (last.role === 'user') {
      return fauxAssistantMessage(
        [
          fauxToolCall(
            creation ? 'automation' : 'hold',
            creation ? { action: 'create', ...creation } : {},
          ),
        ],
        { stopReason: 'toolUse' },
      )
    }
    return fauxAssistantMessage([fauxText('finished')])
  }
  faux.setResponses([route])
  opened = await prepared.open()
  const actionContext: ActionContext = {
    host,
    signal: new AbortController().signal,
    exec: async () => {
      throw new Error('Lifecycle actions must not spawn commands')
    },
  }
  const action = (name: string, args: JsonValue = {}) => actions[name](args, actionContext)
  const record = async () => {
    const a = (await opened.harness.snapshot(Automations, context))?.automations.A1
    assert(a, 'Lifecycle automation A1 must exist after create action/tool receipt')
    return a
  }
  async function sleeping(id: TaskId | undefined) {
    assert(id, 'Enabled automation must have a scheduler task')
    const graph = await opened.harness.taskGraph(context)
    try {
      const task = graph.value.tasks[String(id)]
      return (
        task !== undefined && task.state.status !== 'completing' && task.state.phase === 'sleep'
      )
    } finally {
      graph.dispose()
    }
  }
  async function pump(predicate: () => boolean | Promise<boolean>) {
    // Yield I/O without wall sleeps or changing virtual time: real scheduler commits, faux
    // continuations and held tool invocations must run, not a counterfeit scheduler.
    for (let turn = 0; turn < 100; turn++) {
      if (await predicate()) {
        return
      }
      await vi.advanceTimersByTimeAsync(0)
      await yieldToIO()
    }
    throw new Error(
      `No progress at ${Date.now()}: ${JSON.stringify(await opened.harness.inspect(context))}`,
    )
  }
  async function idle(conversation = opened.root) {
    let settled = false
    const waiting = conversation.waitForIdle(context).then(() => {
      settled = true
    })
    // If the bounded pump fails, fixture teardown rejects this waiter. Keep that secondary
    // rejection handled; the primary error retains the live-task/submission diagnostic.
    void waiting.catch(() => {})
    await pump(() => settled)
    await waiting
    const graph = await opened.harness.taskGraph(context)
    try {
      expect(ordinaryScope(graph.value, conversation.id)).toEqual([])
    } finally {
      graph.dispose()
    }
  }
  return {
    opened,
    prepared,
    sleeping,
    held,
    action,
    record,
    pump,
    idle,
    async createThroughTool(args: { name: string; prompt: string; schedule: string }) {
      creation = args
      try {
        const submission = await opened.root.submit(
          { type: 'input', content: 'Create the automation' },
          context,
        )
        await pump(async () => (await submission.status(context)).status === 'done')
        expect((await submission.wait(context)).status).toBe('done')
        await idle()
      } finally {
        creation = undefined
      }
    },
    async close() {
      try {
        // Release held model tools before closing; close is not a model-stream abort.
        for (const resolve of held.values()) {
          resolve()
        }
        await vi.advanceTimersByTimeAsync(0)
        await opened.close()
      } finally {
        vi.useRealTimers()
        await removeTemp(root)
      }
    },
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

async function check(m: Model, f: Fixture) {
  await f.pump(async () => {
    const a = await f.record()
    // Settle scheduled plan/fire and get every new run to its held real tool.
    return (
      a.runs.length >= m.runs.length &&
      a.runs
        .filter((r) => r.status === 'running')
        .every((r) => r.conversationId !== undefined && f.held.has(r.conversationId)) &&
      (!a.enabled || a.nextAt !== undefined)
    )
  })
  expect(observed(await f.record())).toEqual(projection(m))
  const a = await f.record()
  const ids = a.runs.filter((r) => r.status !== 'skipped').map((r) => r.id)
  expect(new Set(ids).size).toBe(ids.length)
  const children = a.runs.flatMap((r) => (r.conversationId === undefined ? [] : [r.conversationId]))
  expect(new Set(children).size).toBe(children.length)
  if (a.enabled) {
    await f.pump(() => f.sleeping(a.scheduler))
    assert(a.scheduler)
    const task = await f.opened.harness.getTask(a.scheduler, context)
    assert(task)
    expect(task.background).toBe(true)
    expect(task.owner).toBeUndefined()
    expect(task.conversationId).toBe(f.opened.root.id)
  }
  await f.idle()
  for (const id of f.held.keys()) {
    const child = await f.opened.harness.conversation(id, context)
    assert(child)
    let idle = false
    const waiting = child.waitForIdle(context).then(() => {
      idle = true
    })
    // It must remain pending across actual event-loop turns while the real tool is held.
    await vi.advanceTimersByTimeAsync(0)
    await yieldToIO()
    expect(idle).toBe(false)
    const inspection = await f.opened.harness.inspect(context)
    expect(
      inspection.submissions.some((s) => s.conversationId === id && s.status === 'placed'),
    ).toBe(true)
    // This waiter is joined when release settles the child, or host.close cancels its scope.
    void waiting.catch(() => {
      // Closing a failed case cancels its outstanding idle observation.
    })
  }
}

async function release(m: Model, f: Fixture) {
  const a = await f.record()
  for (const resolve of f.held.values()) {
    resolve()
  }
  for (const run of m.runs) {
    if (run.status === 'running') {
      run.status = 'done'
    }
  }
  await f.pump(async () => (await f.record()).runs.every((r) => r.status !== 'running'))
  for (const run of a.runs) {
    if (run.conversationId === undefined) {
      continue
    }
    const child = await f.opened.harness.conversation(run.conversationId, context)
    assert(child)
    await f.idle(child)
    const submissions = await f.prepared.scanSubmissions(
      { conversationId: run.conversationId },
      10,
      undefined,
      context,
    )
    expect(submissions.items.every((s) => s.status === 'done')).toBe(true)
  }
}

const specArb = fc.oneof(
  fc.record({ kind: fc.constant('at' as const), n: fc.integer({ min: 1, max: 5 }) }),
  fc.record({ kind: fc.constant('every' as const), n: fc.integer({ min: 1, max: 5 }) }),
  fc.record({ kind: fc.constant('cron' as const), n: fc.constantFrom(1, 2, 5, 10, 15, 30) }),
)
const operationArb: fc.Arbitrary<Operation> = fc.oneof(
  fc.record({ kind: fc.constantFrom('pause', 'resume', 'rename', 'manual', 'release') }),
  fc.record({ kind: fc.constant('update'), spec: specArb }),
  fc.record({
    kind: fc.constant('tick'),
    edge: fc.constantFrom(-1 as const, 0 as const, 1 as const),
  }),
  fc.record({
    kind: fc.constant('race'),
    mutation: fc.constantFrom('pause', 'update'),
    spec: specArb,
    placement: fc.constantFrom('before', 'woken', 'after'),
  }),
)

async function spentResume(f: Fixture) {
  await expect(f.action('resume', { id: 'A1' })).rejects.toThrow('update the time first')
}
function selectHistory(candidates: Model[], actual: ReturnType<typeof observed>) {
  expect(candidates.map(projection)).toContainEqual(actual)
  const matching = candidates.find(
    (candidate) => JSON.stringify(projection(candidate)) === JSON.stringify(actual),
  )
  assert(matching, 'Observed lifecycle must match a permitted sequential history')
  return matching
}

async function sequence(
  spec: Spec,
  offset: number,
  operations: Operation[],
  reach: Reach,
  throughTool = false,
) {
  const start = Date.UTC(2026, 0, 1, 0, 0) - offset
  const f = await fixture(start)
  const s = schedule(spec, start)
  let m: Model = { enabled: true, schedule: s, due: next(s, start), runs: [] }
  let previous = 'create'
  mark(reach, `schedule:${spec.kind}`)
  mark(reach, throughTool ? 'create:tool' : 'create:action')
  try {
    const creationArgs = { name: 'Generated', prompt: 'HOLD', schedule: input(s) }
    if (throughTool) {
      await f.createThroughTool(creationArgs)
    } else {
      await f.action('create', creationArgs)
    }
    await check(m, f)
    for (const op of operations) {
      mark(reach, `op:${op.kind}`)
      mark(reach, `pair:${previous}/${op.kind}`)
      previous = op.kind
      if (op.kind === 'pause' || op.kind === 'update') {
        mutate(m, op.kind, op.kind === 'update' ? op.spec : spec, Date.now())
        const args: { id: string; schedule?: string } = { id: 'A1' }
        if (op.kind === 'update') {
          args.schedule = input(m.schedule)
        }
        await f.action(op.kind, args)
      } else if (op.kind === 'resume') {
        if (m.schedule.kind === 'at' && m.schedule.time <= Date.now()) {
          mark(reach, 'spent-resume')
          await spentResume(f)
        } else {
          m.enabled = true
          m.due = next(m.schedule, Date.now())
          await f.action('resume', { id: 'A1' })
        }
      } else if (op.kind === 'rename') {
        await f.action('update', { id: 'A1', name: 'Renamed' })
      } else if (op.kind === 'manual') {
        fire(m, Date.now())
        await f.action('run', { id: 'A1' })
      } else if (op.kind === 'release') {
        if (m.runs.some((r) => r.status === 'running')) {
          await release(m, f)
        } else {
          mark(reach, 'precondition:release')
        }
      } else if (op.kind === 'tick') {
        if (m.enabled && m.due !== undefined) {
          const due = m.due
          const target = Math.max(Date.now(), due + Math.min(op.edge, 0))
          await vi.advanceTimersByTimeAsync(target - Date.now())
          if (target >= due) {
            fire(m, target, true)
            await check(m, f)
            if (op.edge === 1) {
              await vi.advanceTimersByTimeAsync(1)
            }
          }
          mark(reach, `tick:${op.edge}`)
        } else {
          mark(reach, 'precondition:tick')
        }
      } else if (op.kind === 'race') {
        if (m.enabled && m.due !== undefined && m.due > Date.now()) {
          mark(reach, `race:${op.placement}`)
          const due = m.due
          await vi.advanceTimersByTimeAsync(Math.max(0, due - Date.now() - 1))
          if (op.placement === 'after') {
            await vi.advanceTimersByTimeAsync(1)
            fire(m, due, true)
            await check(m, f)
          } else if (op.placement === 'woken') {
            // Run timer callbacks but leave scheduler continuations free to interleave with action commits.
            vi.advanceTimersByTime(1)
          }
          const now = Date.now()
          const noFire = structuredClone(m)
          mutate(noFire, op.mutation, op.spec, now)
          // An unchanged schedule update preserves a due tick: the replacement scheduler may fire it.
          if (
            op.placement === 'woken' &&
            noFire.enabled &&
            noFire.due !== undefined &&
            noFire.due <= now
          ) {
            fire(noFire, now, true)
          }
          const candidates = [noFire]
          if (op.placement === 'woken') {
            const firedFirst = structuredClone(m)
            fire(firedFirst, now, true)
            mutate(firedFirst, op.mutation, op.spec, now)
            candidates.push(firedFirst)
          }
          const args: { id: string; schedule?: string } = { id: 'A1' }
          if (op.mutation === 'update') {
            args.schedule = input(schedule(op.spec, now))
          }
          await f.action(op.mutation, args)
          // Drain the replacement scheduler, including a retained due tick, without advancing
          // time. Merely flushing one microtask would not wait for its real commit chain.
          await f.pump(async () => {
            const a = await f.record()
            if (!a.enabled) {
              return true
            }
            return a.nextAt !== undefined && a.nextAt > now && (await f.sleeping(a.scheduler))
          })
          const actual = observed(await f.record())
          m = selectHistory(candidates, actual)
          if (op.placement === 'before') {
            await vi.advanceTimersByTimeAsync(1)
            if (m.enabled && m.due !== undefined && m.due <= Date.now()) {
              fire(m, Date.now(), true)
            }
          }
        } else {
          mark(reach, 'precondition:race')
        }
      }
      if (m.runs.some((r) => r.status === 'skipped')) {
        mark(reach, 'overlap')
      }
      if (!m.enabled) {
        mark(reach, 'disabled')
      }
      mark(
        reach,
        `state:${m.enabled ? 'enabled' : 'disabled'}/${m.runs.some((r) => r.status === 'running') ? 'held' : 'settled'}`,
      )
      await check(m, f)
    }
  } finally {
    await f.close()
  }
}

it('searches real automation lifecycle histories and scheduler interleavings against an independent model', async () => {
  const reach: Reach = new Map()
  const parameters: fc.Parameters<[Spec, number, Operation[], boolean]> = {
    seed: Number(process.env.FC_SEED ?? 615693),
    numRuns: Number(process.env.FC_RUNS ?? 48),
  }
  if (process.env.FC_PATH) {
    parameters.path = process.env.FC_PATH
  }
  await fc.assert(
    fc.asyncProperty(
      specArb,
      fc.integer({ min: 1, max: 999 }),
      fc.array(operationArb, { minLength: 1, maxLength: 12 }),
      fc.boolean(),
      (spec, offset, operations, throughTool) =>
        sequence(spec, offset, operations, reach, throughTool),
    ),
    parameters,
  )
  console.info(
    'automation lifecycle reach:',
    Object.fromEntries([...reach].toSorted(([a], [b]) => a.localeCompare(b))),
  )
  const missing =
    process.env.FC_SEED || process.env.FC_PATH || process.env.FC_RUNS
      ? []
      : [
          'schedule:at',
          'schedule:every',
          'schedule:cron',
          'create:tool',
          'create:action',
          'op:pause',
          'op:resume',
          'op:update',
          'op:rename',
          'op:manual',
          'op:release',
          'op:tick',
          'op:race',
          'race:before',
          'race:woken',
          'race:after',
          'tick:-1',
          'tick:0',
          'tick:1',
          'overlap',
          'spent-resume',
          'state:enabled/held',
          'state:disabled/held',
          'state:enabled/settled',
          'state:disabled/settled',
        ].filter((category) => !reach.has(category))
  expect(missing).toEqual([])
})

it('weekday cron tool receipt settles its submission and root idle while the real scheduler sleeps', async () => {
  const f = await fixture(Date.UTC(2026, 0, 5, 8)) // Monday, one hour before the weekday fire.
  const due = Date.UTC(2026, 0, 5, 9)
  try {
    await f.createThroughTool({
      name: 'Weekday report',
      prompt: 'HOLD',
      schedule: 'cron "0 9 * * 1-5" UTC',
    })
    await f.pump(async () => f.sleeping((await f.record()).scheduler))
    const a = await f.record()
    expect(a.schedule).toEqual({ kind: 'cron', expr: '0 9 * * 1-5', tz: 'UTC' })
    expect(observed(a)).toEqual({
      enabled: true,
      schedule: { kind: 'cron', expr: '0 9 * * 1-5', tz: 'UTC' },
      nextAt: due,
      runs: [],
    })
    assert(a.scheduler)
    const scheduler = await f.opened.harness.getTask(a.scheduler, context)
    assert(scheduler)
    expect(scheduler.background).toBe(true)
    expect(scheduler.state.checkpoint).toEqual({ phase: 'sleep', until: due })
    await f.idle()
    expect((await f.opened.harness.inspect(context)).submissions).toEqual([])
  } finally {
    await f.close()
  }
})

it('root idle crosses neither a sleeping scheduler nor its held background run, but child idle waits', async () => {
  const reach: Reach = new Map()
  await sequence(
    { kind: 'every', n: 1 },
    1,
    [
      { kind: 'tick', edge: 0 },
      { kind: 'manual' },
      { kind: 'pause' },
      { kind: 'release' },
      { kind: 'resume' },
      { kind: 'tick', edge: 0 },
      { kind: 'release' },
    ],
    reach,
    true,
  )
  expect(reach.has('overlap')).toBe(true)
})
