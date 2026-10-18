import { access, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import {
  defineExtension,
  defineTask,
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, JsonObject, Tx } from '@earendil-works/pi-durable'
import { expect, it, vi } from 'vitest'
import { context } from '../../server/harness.ts'
import { UiState } from '../../server/ui-state.ts'
import { Metadata } from '../../server/metadata.ts'
import { Board } from '../../extensions/board/server.ts'
import type { BoardService } from '../../extensions/board/server.ts'
import type { ActionContext } from '../../server/actions.ts'
import workspaceExtension, { actions } from '../../extensions/workspaces/server.ts'
import { Workspaces } from '../../extensions/workspaces/workspaces.ts'
import { git } from '../../extensions/workspaces/git.ts'
import { createLander, landerCheckout, landerPath } from '../../extensions/workspaces/lander.ts'
import { until } from '../helpers.ts'
import {
  workspaceRepository as repository,
  workspaceFixture as fixture,
  nestedWorkspaceFixture as nestedFixture,
  commitWorkspaceFile as commit,
  holdWorkspaceGit as holdGit,
} from '../test-utils/workspace-fixture.ts'

import { workspaceLanderFixture as lander } from '../test-utils/workspaceLanderFixture.ts'
import { submittedWorkspaceReports as submitted } from '../test-utils/submittedWorkspaceReports.ts'
import { workspaceLanderLog as landerLog } from '../test-utils/workspaceLanderLog.ts'

vi.setConfig({ maxConcurrency: 16 })

it.concurrent('serializes concurrent lander checkout creation', async () => {
  const { home, projectRoot } = await repository()
  const path = await landerPath(home, projectRoot)
  // Recover an unregistered directory left by an interrupted creation, too.
  await mkdir(path)
  await writeFile(join(path, 'incomplete'), 'interrupted')
  const results = await Promise.allSettled([
    landerCheckout(home, projectRoot),
    landerCheckout(home, projectRoot),
  ])
  expect(results).toEqual([
    { status: 'fulfilled', value: path },
    { status: 'fulfilled', value: path },
  ])
  const entries = (await git(projectRoot, 'worktree', 'list', '--porcelain')).split('\n\n')
  expect(entries.filter((entry) => entry.split('\n').includes(`worktree ${path}`))).toHaveLength(1)
  expect(await readFile(join(path, 'base.txt'), 'utf8')).toBe('base')
  expect(await readdir(path)).not.toContain('incomplete')
  // An existing checkout must be left alone, even when another tip is requested.
  await writeFile(join(path, 'keep.txt'), 'keep')
  expect(await landerCheckout(home, projectRoot, 'missing-tip')).toBe(path)
  expect(await readFile(join(path, 'keep.txt'), 'utf8')).toBe('keep')
})
it.concurrent('retries lander checkout creation after a failure', async () => {
  const { home, projectRoot } = await repository()
  await expect(landerCheckout(home, projectRoot, 'missing-tip')).rejects.toThrow('missing-tip')
  expect(await landerCheckout(home, projectRoot)).toBe(await landerPath(home, projectRoot))
})

it.concurrent.each(['running', 'queued'] as const)(
  'release retains a clean ancestor for a %s non-isolated descendant',
  async (state) => {
    const f = await fixture()
    const parent = await f.create()
    await f.service.ready(parent, context)
    const workspace = (await f.service.get(parent, context))!
    const Owner = defineTask<null, { phase: 'done' }, null>({
      name: 'test.non-isolated-owner',
      version: 1,
      abort: (_task, runtime, ctx) =>
        runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
      initial: () => ({ phase: 'done' }),
      phases: {
        done: (_task, runtime, ctx) =>
          runtime.commit(
            () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
            ctx,
          ),
      },
    })
    f.prepared.registry.install(defineExtension({ name: 'non-isolated-owner', tasks: [Owner] }))
    const child = await f.opened.harness.commit(async (tx) => {
      const taskId = await tx.createTask(Owner, null, {
        conversationId: parent,
        ownership: { kind: 'conversation' },
        background: true,
      })
      return tx.createConversation({
        ownership: { kind: 'task', taskId },
      })
    }, context)
    expect(await f.service.get(child.id, context)).toBeUndefined()
    const conversation = (await f.opened.harness.conversation(child.id, context))!
    expect((await conversation.agent(context)).cwd).toBe(workspace.path)
    let finish!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    f.prepared.faux!.setResponses([
      async () => {
        entered()
        await gate
        return state === 'queued'
          ? fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'test provider failed' })
          : fauxAssistantMessage('done')
      },
    ])
    const submission = await conversation.submit({ type: 'input', content: 'hold' }, context)
    await started
    try {
      let queuedStatus: string | undefined
      if (state === 'queued') {
        const queued = await conversation.submit(
          { type: 'input', content: 'follow-up', whenBusy: 'followUp' },
          context,
        )
        finish()
        await submission.wait(context)
        await conversation.waitForIdle(context)
        queuedStatus = (await queued.status(context)).status
      }
      expect(queuedStatus).toBe(state === 'queued' ? 'queued' : undefined)
      expect(Boolean((await f.opened.harness.snapshot(LiveDoc, child.id, context))?.run)).toBe(
        state === 'running',
      )
      expect((await f.opened.harness.snapshot(InboxDoc, child.id, context))!.items).toHaveLength(
        state === 'queued' ? 1 : 0,
      )
      expect(await f.service.release([parent], context)).toEqual([
        { id: child.id, uncommitted: 0, unlanded: 0, busy: expect.stringContaining(state) },
        { id: parent, uncommitted: 0, unlanded: 0, descendant: child.id },
      ])
      expect((await f.service.get(parent, context))!.state).toBe('ready')
      expect(await git(workspace.path, 'status', '--porcelain')).toBe('')
      expect(await git(f.projectRoot, 'worktree', 'list', '--porcelain')).toContain(workspace.path)
      await access(workspace.path)
    } finally {
      finish()
      await submission.wait(context)
      await conversation.abort(context)
      await conversation.waitForIdle(context)
    }
    expect(await f.service.release([parent], context)).toEqual([])
    await expect(access(workspace.path)).rejects.toThrow('ENOENT')
  },
)

it.concurrent('pending and release preserve dirty and unlanded work, removing only landed checkouts', async () => {
  const f = await fixture()
  const clean = await f.create()
  const dirty = await f.create()
  const ahead = await f.create()
  for (const id of [clean, dirty, ahead]) await f.service.ready(id, context)
  const cleanWorkspace = (await f.service.get(clean, context))!
  const dirtyWorkspace = (await f.service.get(dirty, context))!
  const aheadWorkspace = (await f.service.get(ahead, context))!
  await commit(cleanWorkspace.path)
  await f.service.land(clean, context)
  await writeFile(join(dirtyWorkspace.path, 'dirty.txt'), 'dirty')
  await commit(aheadWorkspace.path, 'ahead.txt')
  const expected = [
    { id: dirty, uncommitted: 1, unlanded: 0 },
    { id: ahead, uncommitted: 0, unlanded: 1 },
  ]
  expect(
    await actions.pending({ ids: [clean, dirty, ahead] }, { host: f.host } as ActionContext),
  ).toEqual(expected)
  expect(await f.service.release([clean, dirty, ahead], context)).toEqual(expected)
  await expect(access(cleanWorkspace.path)).rejects.toThrow('ENOENT')
  expect(await git(f.projectRoot, 'worktree', 'list', '--porcelain')).not.toContain(
    cleanWorkspace.path,
  )
  expect(await git(f.projectRoot, 'branch', '--list', cleanWorkspace.branch)).toBe('')
  expect((await f.service.get(clean, context))!.state).toBe('removed')
  expect(await readFile(join(dirtyWorkspace.path, 'dirty.txt'), 'utf8')).toBe('dirty')
  expect(await git(aheadWorkspace.path, 'rev-list', '--count', `main..HEAD`)).toBe('1')
  expect(await f.service.release([clean], context)).toEqual([])
})

it.concurrent('release includes transitively owned checkouts but not unrelated conversations', async () => {
  const f = await fixture()
  const parent = await f.create()
  await f.service.ready(parent, context)
  const Owner = defineTask<null, { phase: 'done' }, null>({
    name: 'test.owner',
    version: 1,
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
    initial: () => ({ phase: 'done' }),
    phases: {
      done: (_task, runtime, ctx) =>
        runtime.commit(
          () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
          ctx,
        ),
    },
  })
  f.prepared.registry.install(defineExtension({ name: 'test-owner', tasks: [Owner] }))
  const childOf = async (owner: ConversationId) => {
    const id = await f.opened.harness.commit(async (tx) => {
      const taskId = await tx.createTask(Owner, null, {
        conversationId: owner,
        ownership: { kind: 'conversation' },
        background: true,
      })
      const child = await tx.createConversation({ ownership: { kind: 'task', taskId } })
      await f.service.create(tx, child.id, f.projectRoot)
      return child.id
    }, context)
    f.opened.harness.resume()
    await f.service.ready(id, context)
    return id
  }
  const child = await childOf(parent)
  const grandchild = await childOf(child)
  const unrelated = await f.create()
  await f.service.ready(unrelated, context)
  const dirty = (await f.service.get(grandchild, context))!
  await writeFile(join(dirty.path, 'dirty.txt'), 'dirty')
  const expected = [{ id: grandchild, uncommitted: 1, unlanded: 0 }]
  expect(await f.service.pending([parent], context)).toEqual(expected)
  expect(await f.service.release([parent], context)).toEqual([
    ...expected,
    { id: child, uncommitted: 0, unlanded: 0, descendant: grandchild },
    { id: parent, uncommitted: 0, unlanded: 0, descendant: child },
  ])
  for (const id of [parent, child]) {
    const workspace = (await f.service.get(id, context))!
    expect(workspace.state).toBe('ready')
    await access(workspace.path)
  }
  expect((await f.service.get(unrelated, context))!.state).toBe('ready')
})

it.concurrent('release keeps a busy clean checkout without waiting', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  f.prepared.faux!.setResponses([
    async () => {
      await gate
      return fauxAssistantMessage('done')
    },
  ])
  const conversation = (await f.opened.harness.conversation(id, context))!
  const submission = await conversation.submit({ type: 'input', content: 'hold' }, context)
  try {
    expect(await f.service.release([id], context)).toEqual([
      { id, uncommitted: 0, unlanded: 0, busy: expect.stringMatching(/running|queued/) },
    ])
    expect((await f.service.get(id, context))!.state).toBe('ready')
  } finally {
    finish()
    await submission.wait(context)
    await conversation.waitForIdle(context)
  }
})

it.concurrent('next input recreates a released checkout at the current target and reruns setup before the model', async () => {
  const f = await fixture(['printf setup > setup-marker; printf setup-marker > .gitignore'])
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  // Commit setup output so release can safely remove the checkout.
  await git(workspace.path, 'add', '.gitignore')
  await git(workspace.path, 'commit', '-m', 'ignore setup marker')
  await f.service.land(id, context)
  expect(await f.service.release([id], context)).toEqual([])
  const tip = await commit(f.projectRoot, 'new-target.txt')
  let requested = false
  f.prepared.faux!.setResponses([
    async () => {
      expect((await f.service.get(id, context))!.state).toBe('ready')
      expect(await git(workspace.path, 'rev-parse', 'HEAD')).toBe(tip)
      expect(await readFile(join(workspace.path, 'setup-marker'), 'utf8')).toBe('setup')
      requested = true
      return fauxAssistantMessage('recreated')
    },
  ])
  const conversation = (await f.opened.harness.conversation(id, context))!
  await (await conversation.submit({ type: 'input', content: 'resume' }, context)).wait(context)
  await conversation.waitForIdle(context)
  expect(requested).toBe(true)
  expect((await f.service.get(id, context))!).toMatchObject({
    state: 'ready',
    path: workspace.path,
    base: tip,
  })
  expect(await git(workspace.path, 'status', '--porcelain')).toBe('')
})

it.concurrent('open reconciles concluded checkouts in the background', async () => {
  const f = await fixture()
  const concluded = await f.create()
  const active = await f.create()
  for (const id of [concluded, active]) await f.service.ready(id, context)
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(UiState, ROOT_CONVERSATION_ID))['ext.conversations.concluded'] = [concluded]
  }, context)
  f.host.provide('conversations', { concluded: async () => new Set([concluded]) })
  await f.reopen()
  await until(async () =>
    access((await f.service.get(concluded, context))!.path).then(
      () => false,
      () => true,
    ),
  )
  await expect(access((await f.service.get(concluded, context))!.path)).rejects.toThrow('ENOENT')
  expect((await f.service.get(active, context))!.state).toBe('ready')
})

it.concurrent('release handles failed checkouts but never removes detached unlanded work', async () => {
  const f = await fixture()
  const failed = await f.create()
  const detached = await f.create()
  for (const id of [failed, detached]) await f.service.ready(id, context)
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(failed)].state = 'failed'
  }, context)
  const failedWorkspace = (await f.service.get(failed, context))!
  await writeFile(join(failedWorkspace.path, 'output.txt'), 'failed setup output')
  expect(await f.service.pending([failed], context)).toEqual([
    { id: failed, uncommitted: 1, unlanded: 0 },
  ])
  expect(await f.service.release([failed], context)).toEqual([
    { id: failed, uncommitted: 1, unlanded: 0 },
  ])
  await unlink(join(failedWorkspace.path, 'output.txt'))
  expect(await f.service.release([failed], context)).toEqual([])
  const workspace = (await f.service.get(detached, context))!
  await git(workspace.path, 'checkout', '--detach')
  const tip = await commit(workspace.path)
  expect(await f.service.release([detached], context)).toEqual([
    { id: detached, uncommitted: 0, unlanded: 1 },
  ])
  expect((await f.service.get(detached, context))!.state).toBe('ready')
  expect(
    JSON.stringify(await f.call(detached, 'bash', { command: 'git rev-parse HEAD' })),
  ).toContain(tip)
  expect(await git(workspace.path, 'rev-parse', 'HEAD')).toBe(tip)
})

it.concurrent('aborting release finishes the current checkout and leaves the remaining batch untouched', async () => {
  const f = await fixture()
  const ids = [await f.create(), await f.create(), await f.create()]
  for (const id of ids) await f.service.ready(id, context)
  const workspacesBefore = await Promise.all(ids.map((id) => f.service.get(id, context)))
  const deletingBranch = await holdGit(f.projectRoot, 'branch')
  const controller = new AbortController()
  let finished = false
  const releasing = f.service.release(ids, context, controller.signal).then((kept) => {
    finished = true
    return kept
  })
  try {
    // Hold the first checkout's final branch deletion, after its folder has been removed.
    await deletingBranch.started()
    controller.abort()
    expect(finished).toBe(false)
    await expect(access(workspacesBefore[0]!.path)).rejects.toThrow('ENOENT')
  } finally {
    await deletingBranch.release()
    await releasing
  }
  expect(finished).toBe(true)
  expect(await git(f.projectRoot, 'branch', '--list', workspacesBefore[0]!.branch)).toBe('')
  const registered = await git(f.projectRoot, 'worktree', 'list', '--porcelain')
  for (let i = 1; i < ids.length; i++) {
    const workspace = workspacesBefore[i]!
    expect((await f.service.get(ids[i], context))!.state).toBe('ready')
    await access(workspace.path)
    expect(registered).toContain(workspace.path)
    expect(await git(f.projectRoot, 'branch', '--list', workspace.branch)).toContain(
      workspace.branch,
    )
  }
})

it.concurrent('input admitted after release marks removed waits for deletion and recreates a usable checkout', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  const harness = f.opened.harness
  const original = harness.commit.bind(harness)
  let proceed!: () => void
  let reached!: () => void
  const gate = new Promise<void>((resolve) => {
    proceed = resolve
  })
  const marked = new Promise<void>((resolve) => {
    reached = resolve
  })
  let held = false
  const spy = vi
    .spyOn(harness, 'commit')
    .mockImplementation(
      async <T>(change: (tx: Tx) => T | Promise<T>, ctx: typeof context): Promise<T> => {
        const result = await original(change, ctx)
        if (!held && (await f.service.get(id, context))!.state === 'removed') {
          held = true
          reached()
          await gate
        }
        return result
      },
    )
  const releasing = f.service.release([id], context)
  const conversation = (await harness.conversation(id, context))!
  let request: ReturnType<typeof conversation.submit> | undefined
  try {
    await marked
    // The idle check and removed state are committed, but filesystem removal has not started.
    await access(workspace.path)
    request = conversation.submit({ type: 'input', content: 'resume during release' }, context)
    await request
  } finally {
    proceed()
    await releasing
    spy.mockRestore()
  }
  await (await request).wait(context)
  await conversation.waitForIdle(context)
  expect((await f.service.get(id, context))!.state).toBe('ready')
  await access(workspace.path)
  expect(await git(workspace.path, 'rev-parse', 'HEAD')).toBe(
    await git(f.projectRoot, 'rev-parse', 'HEAD'),
  )
})

it.concurrent.each([false, true])(
  'reopen finishes an interrupted release (folder already removed: %s)',
  async (removed) => {
    const f = await fixture()
    const id = await f.create()
    await f.service.ready(id, context)
    const workspace = (await f.service.get(id, context))!
    if (removed) await git(workspace.source, 'worktree', 'remove', workspace.path)
    // Both interruption windows: old removal-before-state, and state-before-removal.
    await f.opened.harness.commit(async (tx) => {
      ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(id)].state = removed
        ? 'ready'
        : 'removed'
    }, context)
    f.host.provide('conversations', { concluded: async () => new Set([id]) })
    await f.reopen()
    await until(async () => !(await git(f.projectRoot, 'branch', '--list', workspace.branch)))
    expect((await f.service.get(id, context))!.state).toBe('removed')
    await expect(access(workspace.path)).rejects.toThrow('ENOENT')
    await f.call(id, 'bash', { command: 'pwd' })
    expect((await f.service.get(id, context))!.state).toBe('ready')
    await access(workspace.path)
  },
)

it.concurrent('reconcile and recreate keep new work found in an interrupted removal', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await writeFile(join(workspace.path, 'precious.txt'), 'keep me')
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(id)].state = 'removed'
  }, context)
  expect(await f.service.release([id], context)).toEqual([{ id, uncommitted: 1, unlanded: 0 }])
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(id)].state = 'removed'
  }, context)
  await f.call(id, 'bash', { command: 'cat precious.txt' })
  expect((await f.service.get(id, context))!.state).toBe('ready')
  expect(await readFile(join(workspace.path, 'precious.txt'), 'utf8')).toBe('keep me')
})

it.concurrent('nested isolates release child before its source parent and can recreate both', async () => {
  const { f, parent, child, parentWorkspace, childWorkspace } = await nestedFixture()
  expect(childWorkspace.source).toBe(parentWorkspace.path)
  expect(await f.service.release([parent], context)).toEqual([])
  for (const workspace of [childWorkspace, parentWorkspace]) {
    await expect(access(workspace.path)).rejects.toThrow('ENOENT')
    expect(await git(f.projectRoot, 'branch', '--list', workspace.branch)).toBe('')
  }
  expect(await f.service.release([parent], context)).toEqual([])
  await f.call(child, 'bash', { command: 'pwd' })
  for (const id of [parent, child]) {
    const workspace = (await f.service.get(id, context))!
    expect(workspace.state).toBe('ready')
    await access(workspace.path)
  }
})
it.concurrent('a dirty nested isolate keeps its source parent checkout', async () => {
  const { f, parent, child, parentWorkspace, childWorkspace } = await nestedFixture()
  expect(childWorkspace.source).toBe(parentWorkspace.path)
  await writeFile(join(childWorkspace.path, 'precious.txt'), 'keep me')
  expect(await f.service.release([parent], context)).toEqual([
    { id: child, uncommitted: 1, unlanded: 0 },
    { id: parent, uncommitted: 0, unlanded: 0, descendant: child },
  ])
  for (const workspace of [childWorkspace, parentWorkspace]) await access(workspace.path)
})

it.concurrent('failed setup while recreating a discarded branch preserves its unlanded commits', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  const tip = await commit(workspace.path)
  await f.service.discard(id, context)
  f.host.projectSettings = async () => ({ isolates: { worktree: { setup: ['exit 1'] } } })
  await f.call(id, 'bash', { command: 'pwd' })
  expect((await f.service.get(id, context))!.state).toBe('failed')
  expect(await git(f.projectRoot, 'rev-parse', workspace.branch)).toBe(tip)
})

it.concurrent('resuming a child after its removal keeps the parent in the same release batch', async () => {
  const { f, parent, child, parentWorkspace, childWorkspace } = await nestedFixture()
  const deletingChildBranch = await holdGit(f.projectRoot, 'branch')
  const queues = f.host.resource('workspaces.land', () => new Map<string, Promise<unknown>>())
  const queued = vi.spyOn(queues, 'set')
  const releasing = f.service.release([parent], context)
  const conversation = (await f.opened.harness.conversation(child, context))!
  let request: ReturnType<typeof conversation.submit> | undefined
  try {
    await deletingChildBranch.started()
    expect((await f.service.get(child, context))!.state).toBe('removed')
    await expect(access(childWorkspace.path)).rejects.toThrow('ENOENT')
    request = conversation.submit(
      { type: 'input', content: 'resume child between removals' },
      context,
    )
    await request
    // The child readies its parent, then holds the parent's source queue while waiting for child removal.
    await until(
      () => queued.mock.calls.filter(([source]) => source === parentWorkspace.source).length >= 2,
    )
  } finally {
    await deletingChildBranch.release()
  }
  const kept = await releasing
  queued.mockRestore()
  await (await request).wait(context)
  await conversation.waitForIdle(context)
  expect(kept).toEqual([{ id: parent, uncommitted: 0, unlanded: 0, descendant: child }])
  for (const id of [parent, child]) {
    const workspace = (await f.service.get(id, context))!
    expect(workspace.state).toBe('ready')
    await access(workspace.path)
  }
})

it.concurrent('refused release and recovery restore ready and report the reason without moving detached HEAD', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await commit(workspace.path)
  await f.service.land(id, context)
  // Both commits are landed, but HEAD is intentionally not the recorded branch tip.
  await git(workspace.path, 'checkout', '--detach', workspace.base)
  expect(await f.service.release([id], context)).toEqual([
    { id, uncommitted: 0, unlanded: 0, reason: expect.stringContaining('recorded branch tip') },
  ])
  expect((await f.service.get(id, context))!.state).toBe('ready')
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(id)].state = 'removed'
  }, context)
  expect(await f.service.ready(id, context)).toMatchObject({
    id,
    reason: expect.stringContaining('recorded branch tip'),
  })
  expect((await f.service.get(id, context))!.state).toBe('ready')
  expect(JSON.stringify(await f.call(id, 'bash', { command: 'git rev-parse HEAD' }))).toContain(
    workspace.base,
  )
  expect(await git(workspace.path, 'rev-parse', 'HEAD')).toBe(workspace.base)
})

it.concurrent('a branch deletion failure after removing the worktree stays removed and the next request recreates it', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  const branch = await holdGit(f.projectRoot, 'branch', true)
  const releasing = f.service.release([id], context)
  try {
    await branch.started()
    await expect(access(workspace.path)).rejects.toThrow('ENOENT')
  } finally {
    await branch.release()
  }
  expect(await releasing).toEqual([{ id, uncommitted: 0, unlanded: 0, reason: expect.any(String) }])
  expect((await f.service.get(id, context))!).toMatchObject({
    state: 'removed',
    error: expect.any(String),
  })
  expect(await git(f.projectRoot, 'worktree', 'list', '--porcelain')).not.toContain(workspace.path)
  const result = await f.call(id, 'bash', { command: 'pwd' })
  expect(JSON.stringify(result)).toContain(workspace.path)
  expect((await f.service.get(id, context))!.state).toBe('ready')
  await access(workspace.path)
})

it.concurrent('a persistent branch deletion failure blocks tools with its reason while the model can explain', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await writeFile(
    join(f.projectRoot, '.git/hooks/reference-transaction'),
    `#!/bin/sh
cat >/dev/null
[ "$1" = prepared ] || exit 0
case "$(tr '\\0' ' ' < /proc/$PPID/cmdline)" in "git branch -D "*) exit 1 ;; esac
`,
    { mode: 0o755 },
  )
  const kept = await f.service.release([id], context)
  expect(kept).toEqual([{ id, uncommitted: 0, unlanded: 0, reason: expect.any(String) }])
  const result = await f.call(id, 'write_commit')
  expect(result?.role === 'toolResult' && result.isError).toBe(true)
  expect(
    result?.role === 'toolResult' &&
      result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n'),
  ).toContain(kept[0].reason!)
  expect(f.writes).toBe(0)
  const conversation = (await f.opened.harness.conversation(id, context))!
  const view = await conversation.viewState(context)
  try {
    const reply = view.value.entries
      .flatMap((entry) => entry.model ?? [])
      .findLast((message) => message.role === 'assistant')
    expect(
      reply?.role === 'assistant' &&
        reply.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n'),
    ).toContain(kept[0].reason!)
  } finally {
    view.dispose()
  }
  expect((await f.service.get(id, context))!).toMatchObject({
    state: 'removed',
    error: kept[0].reason,
  })
  await expect(access(workspace.path)).rejects.toThrow('ENOENT')
})

it.concurrent('recovery does not mark an unregistered folder ready or run tools there', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await f.service.release([id], context)
  await mkdir(workspace.path)
  await writeFile(join(workspace.path, 'unrelated.txt'), 'keep me')
  const result = await f.call(id, 'write_commit')
  expect(result?.role === 'toolResult' && result.isError).toBe(true)
  expect(JSON.stringify(result)).toContain('Workspace is removed:')
  expect(f.writes).toBe(0)
  expect((await f.service.get(id, context))!.state).toBe('removed')
  expect(await readFile(join(workspace.path, 'unrelated.txt'), 'utf8')).toBe('keep me')
})

it.concurrent('the tool gate blocks a checkout removed after the provider request began', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  f.prepared.faux!.setResponses([
    async () => {
      await git(workspace.source, 'worktree', 'remove', workspace.path)
      return fauxAssistantMessage(fauxToolCall('write_commit', {}), { stopReason: 'toolUse' })
    },
    fauxAssistantMessage('blocked'),
  ])
  const result = await f.call(id, 'write_commit')
  expect(result?.role === 'toolResult' && result.isError).toBe(true)
  expect(JSON.stringify(result)).toContain('Workspace checkout is missing or unregistered:')
  expect(f.writes).toBe(0)
})

it.concurrent('requires nonempty divergence for submit before queuing anything', async () => {
  const f = await lander({})
  const id = await f.create()
  await f.service.ready(id, context)
  for (const args of [{ action: 'submit' }, { action: 'submit', divergence: '   ' }]) {
    const result = await f.call(id, 'workspace', args)
    expect(JSON.stringify(result)).toContain('Submitting requires divergence')
  }
  expect(
    (await f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!.queue,
  ).toHaveLength(0)
})

it.concurrent('records a submission and its report on the board exactly once', async () => {
  const f = await lander({}, undefined, true)
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await commit(workspace.path, 'first.txt')
  const tip = await commit(workspace.path, 'second.txt')
  const result = await f.service.submit(id, 'None', context)
  await submitted(f, id)
  const messages = (await f.opened.harness.snapshot(Board, ROOT_CONVERSATION_ID, context))!.messages
  expect(messages).toHaveLength(2)
  expect(messages[0]).toMatchObject({
    from: id,
    to: result.lander,
    kind: 'landing',
    text: `Submitted ${tip.slice(0, 7)} first.txt and 1 more`,
  })
  expect(messages[1]).toMatchObject({
    from: result.lander,
    to: id,
    kind: 'landing',
    text: `Landed ${tip.slice(0, 7)} on main`,
  })
  const report = await f.opened.harness.commit(
    (tx) => tx.submissionByRequest(id, `lander:${result.id}`),
    context,
  )
  expect(messages[1].entry).toBe(report!.entry)
})

it.concurrent('hands matching landings to the deploy agent exactly once', async () => {
  const f = await lander({ deploy: { agent: 'deploy-test', paths: ['cloud/'] } }, undefined, true)
  await mkdir(join(f.directory, '.ultimate/agents'), { recursive: true })
  await writeFile(
    join(f.directory, '.ultimate/agents/deploy-test.md'),
    '---\nname: deploy-test\ndescription: Deploys\nresident: true\n---\nDeploy.\n',
  )
  const task = createLander(f.host, Workspaces, (_source, operation) => operation())
  const reportPhase = task.definition.phases.report
  let crashes = 0
  f.prepared.registry.install(
    defineExtension({
      ...workspaceExtension(f.host),
      tasks: [
        ...(workspaceExtension(f.host).tasks ?? []).filter(
          (item) => item.definition.name !== task.definition.name,
        ),
        {
          definition: {
            ...task.definition,
            phases: {
              ...task.definition.phases,
              report: async (...args: Parameters<typeof reportPhase>) => {
                const [current, runtime, ctx] = args
                // Crash after board admission but before recording the deploy step. The next run has no step or memo.
                await expect(
                  reportPhase(
                    current,
                    {
                      ...runtime,
                      commit: async () => {
                        throw new Error('crash after send')
                      },
                    },
                    ctx,
                  ),
                ).rejects.toThrow('crash after send')
                crashes++
                await reportPhase(current, runtime, ctx)
              },
            },
          },
        },
      ],
    }),
  )
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await mkdir(join(workspace.path, 'cloud'), { recursive: true })
  const tip = await commit(workspace.path, 'cloud/change.txt')
  const result = await f.service.submit(id, 'None', context)
  const [report] = await submitted(f, id)
  const messages = (await f.opened.harness.snapshot(Board, ROOT_CONVERSATION_ID, context))!.messages
  const deploy = messages.filter((message) => message.text.includes('Please deploy'))
  expect(crashes).toBe(1)
  expect(deploy).toHaveLength(1)
  expect(deploy[0]).toMatchObject({ from: result.lander, reply: false })
  expect(deploy[0].text).toContain(tip)
  expect(deploy[0].text).toContain('cloud/change.txt')
  expect(deploy[0].text).toContain(`#${id}`)
  expect(deploy[0].text).toContain('Pushed: no.')
  expect(deploy[0].text).toContain('Commits:')
  const recipient = await f.opened.harness.snapshot(
    Metadata,
    deploy[0].to as ConversationId,
    context,
  )
  expect(recipient?.title).toBe('@deploy-test')
  expect(report).toContain('deploy → @deploy-test')
  expect((await landerLog(f)).log.some((line) => line.step === 'deploy → @deploy-test')).toBe(true)
})

it.concurrent('reports a landing with a deploy warning when the handoff itself fails', async () => {
  const f = await lander({ deploy: { agent: 'deploy-test', paths: ['cloud/'] } }, undefined, true)
  await mkdir(join(f.directory, '.ultimate/agents'), { recursive: true })
  await writeFile(
    join(f.directory, '.ultimate/agents/deploy-test.md'),
    '---\nname: deploy-test\ndescription: Deploys\nresident: true\n---\nDeploy.\n',
  )
  // The board is there and the agent is resident, but delivery fails, as without a subagents service.
  const service = f.host.use<BoardService>('board')!
  service.send = async () => {
    throw new Error('subagents service unavailable')
  }
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await mkdir(join(workspace.path, 'cloud'), { recursive: true })
  await commit(workspace.path, 'cloud/change.txt')
  await f.service.submit(id, 'None', context)
  const [report] = await submitted(f, id)
  const warning = 'deploy warning: handoff to @deploy-test failed: subagents service unavailable'
  expect(report).toContain('landed as')
  expect(report).toContain(warning)
  expect((await landerLog(f)).log.map((line) => line.step)).toContain(warning)
  expect(f.notice.mock.calls.flat().join('\n')).toContain(warning)
})

it.concurrent.each([
  { settings: {}, file: 'other.txt', step: undefined },
  {
    settings: { deploy: { agent: 'missing', paths: ['cloud/'] } },
    file: 'other.txt',
    step: undefined,
  },
  {
    settings: { deploy: { agent: 'missing', paths: ['cloud/'] } },
    file: 'cloud/change.txt',
    step: 'deploy warning: @missing is not a standing agent',
  },
  {
    settings: { deploy: { agent: 'nonresident', paths: ['cloud/'] } },
    file: 'cloud/change.txt',
    step: 'deploy warning: @nonresident is not a standing agent',
  },
  {
    settings: { deploy: { agent: 'missing', paths: [] } },
    file: 'cloud/change.txt',
    step: undefined,
  },
])(
  'deploy hook skips or warns without preventing landing: $settings $file',
  async ({ settings, file, step }) => {
    const f = await lander(settings as JsonObject, undefined, true)
    await mkdir(join(f.directory, '.ultimate/agents'), { recursive: true })
    await writeFile(
      join(f.directory, '.ultimate/agents/nonresident.md'),
      '---\nname: nonresident\ndescription: Not standing\n---\nNo deploy.\n',
    )
    const id = await f.create()
    await f.service.ready(id, context)
    const workspace = (await f.service.get(id, context))!
    await mkdir(join(workspace.path, 'cloud'), { recursive: true })
    await commit(workspace.path, file)
    await f.service.submit(id, 'None', context)
    const [report] = await submitted(f, id)
    expect(report).toContain('landed as')
    const messages = (await f.opened.harness.snapshot(Board, ROOT_CONVERSATION_ID, context))!
      .messages
    expect(messages.filter((message) => message.text.includes('Please deploy'))).toHaveLength(0)
    const steps = (await landerLog(f)).log.filter((line) => line.step?.startsWith('deploy'))
    expect(steps.map((line) => line.step)).toEqual(step ? [step] : [])
    const notices = f.notice.mock.calls.flat().join('\n')
    const invalid = settings.deploy?.paths.length === 0
    expect(notices).toContain(step ?? (invalid ? 'deploy hook disabled' : ''))
  },
)

it.concurrent('records a failed landing on the board', async () => {
  const f = await lander({ checks: ['echo REJECTED; false'] }, undefined, true)
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path)
  const result = await f.service.submit(id, 'None', context)
  await submitted(f, id)
  const messages = (await f.opened.harness.snapshot(Board, ROOT_CONVERSATION_ID, context))!.messages
  expect(messages).toHaveLength(2)
  expect(messages[1]).toMatchObject({
    from: result.lander,
    to: id,
    kind: 'landing',
    text: 'Not landed: check failed twice: echo REJECTED; false',
  })
})
