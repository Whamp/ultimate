import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Usage } from '@earendil-works/pi-ai'
import type { ConversationId } from '@earendil-works/pi-durable'
import { expect, test } from 'vitest'
import { Plan } from '../extensions/plan/server.ts'
import { context } from '../server/harness.ts'
import { assistant, start, user } from './fixture.ts'

const exec = promisify(execFile)
function measure(scenario: string, turn: { wallMs: number; usage: Usage }) {
  process.stdout.write(
    JSON.stringify({ scenario, wallMs: Math.round(turn.wallMs), ...turn.usage }) + '\n',
  )
}

test('E1 plan ledger remains visible across turns', async () => {
  const ultimate = await start({ extensions: { enable: ['plan'] } })
  try {
    const c = await ultimate.conversation()
    // Establish a real turn without leaking the later ledger's task values into history.
    const turn = await c.run('Reply only Ready. Do not call tools.')
    expect(turn.toolCalls).toHaveLength(0)
    measure('E1-plan', turn)

    // Tool handling/persistence is covered by test/plan.test.ts; here seed actual durable state.
    await ultimate.harness.commit(async (tx) => {
      const plan = await tx.doc(Plan, c.id)
      plan.next = 8
      plan.epics.E7 = {
        key: 'E7',
        title: 'Verify lantern release',
        body: 'Check the release map and cache.',
        status: 'in_progress',
        tasks: {
          'E7.3': {
            key: 'E7.3',
            title: 'Compile zircon map',
            role: 'worker',
            description: 'Build the release map.',
            deps: [],
            status: 'in_review',
            notes: [],
          },
          'E7.8': {
            key: 'E7.8',
            title: 'Audit amber cache',
            role: 'reviewer',
            description: 'Audit the cache after the map is ready.',
            deps: ['E7.3'],
            status: 'blocked',
            notes: [],
          },
        },
      }
    }, context)
    expect(await ultimate.harness.snapshot(Plan, c.id, context)).toMatchObject({
      epics: {
        E7: {
          tasks: {
            'E7.3': { role: 'worker', deps: [], status: 'in_review' },
            'E7.8': { role: 'reviewer', deps: ['E7.3'], status: 'blocked' },
          },
        },
      },
    })

    // Roles are persisted above but deliberately absent from the compact Plan prompt.
    const reply = await c.run(
      'What task records (with dotted keys) are open in the current plan ledger? Exclude epic rows (keys without a dot). No tools. Return only a JSON array of objects with key, title, status, and deps (prerequisite task keys). Use exact ledger values.',
    )
    expect(reply.toolCalls).toHaveLength(0)
    const tasks = JSON.parse(reply.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
    expect(tasks).toHaveLength(2)
    expect(tasks).toEqual(
      expect.arrayContaining([
        { key: 'E7.3', title: 'Compile zircon map', status: 'in_review', deps: [] },
        { key: 'E7.8', title: 'Audit amber cache', status: 'blocked', deps: ['E7.3'] },
      ]),
    )
    measure('E1-plan-follow-up', reply)
  } finally {
    await ultimate.stop()
  }
})

test('E2 one-shot reminder refuses a spent resume', async () => {
  const ultimate = await start({ extensions: { enable: ['automations', 'subagents'] } })
  try {
    const c = await ultimate.conversation({
      history: [
        user('Use Europe/Vienna for my reminders.'),
        assistant('I will schedule reminders in Ultimate using Europe/Vienna.'),
      ],
    })
    const before = Date.now()
    const turn = await c.run('Remind me once in 30 minutes to call Anna; do not run it now.')
    const { result: reminders } = await ultimate.action('automations', 'list')
    expect(reminders).toHaveLength(1)
    const reminder = reminders[0]
    expect(reminder.schedule.kind).toBe('at')
    expect(Date.parse(reminder.schedule.time)).toBeGreaterThanOrEqual(before + 29 * 60_000)
    expect(Date.parse(reminder.schedule.time)).toBeLessThan(Date.now() + 31 * 60_000)
    expect(reminder.prompt).toMatch(/Anna/)
    expect(reminder.runs).toHaveLength(0)
    measure('E2-reminder', turn)
    await ultimate.action('automations', 'pause', { id: reminder.id })
    // A paused reminder whose time has passed is spent, without firing a real-model run.
    await ultimate.action('automations', 'update', {
      id: reminder.id,
      schedule: { kind: 'at', time: new Date(Date.now() - 60_000).toISOString() },
    })
    const reply = await c.run(
      `Resume reminder ${reminder.id}. Do not change its time or create another reminder.`,
    )
    expect(reply.text).toMatch(/time|schedule|past|spent|expired/i)
    expect(reply.text).toMatch(/update|change|new|reschedul|cannot|can't|unable/i)
    const { result: after } = await ultimate.action('automations', 'list')
    expect(after).toHaveLength(1)
    expect(after[0].enabled).toBe(false)
    expect(after[0].runs).toHaveLength(0)
    measure('E2-spent-resume', reply)
  } finally {
    await ultimate.stop()
  }
})

test('E3 edits and commits stay in the isolated checkout', async () => {
  const ultimate = await start({
    project: { git: true, files: { 'README.md': 'Workspace eval\n' } },
    extensions: { enable: ['workspaces'] },
  })
  try {
    const { result: created } = await ultimate.action('workspaces', 'create', {
      title: 'Isolated notes',
    })
    const c = await ultimate.conversation({ id: created.id as ConversationId })
    const turn = await c.run(
      "Add NOTES.md containing 'isolated', commit it with git user.name=Eval and user.email=eval@example.invalid, then report workspace status including the workspace branch name and its commits ahead. Do not land or push.",
    )
    const { result: info } = await ultimate.action('workspaces', 'info', { id: c.id })
    expect(await readFile(join(info.path, 'NOTES.md'), 'utf8')).toMatch(/isolated/)
    expect((await exec('git', ['show', 'HEAD:NOTES.md'], { cwd: info.path })).stdout).toMatch(
      /isolated/,
    )
    expect((await ultimate.exec('git', ['status', '--porcelain'])).stdout).toBe('')
    await expect(access(join(ultimate.projectRoot, 'NOTES.md'))).rejects.toThrow('ENOENT')
    expect(turn.toolCalls.some((call) => call.name === 'workspace' && !call.isError)).toBe(true)
    expect(turn.text).toContain(info.branch)
    expect(turn.text).toMatch(/ahead|commit/i)
    measure('E3-workspace', turn)
  } finally {
    await ultimate.stop()
  }
})

test('E4 delegates symbol lookup without reading in the parent', async () => {
  const ultimate = await start({
    project: {
      files: {
        'src/parser.ts': 'export function parseFoo(input: string) { return input.trim() }\n',
      },
    },
    extensions: { enable: ['subagents'] },
  })
  try {
    const c = await ultimate.conversation()
    const turn = await c.run(
      'Use a worker subagent to find which file defines parseFoo and tell me the path. Do not read or search the files yourself. Use a shared checkout, not a worktree.',
    )
    expect(
      turn.toolCalls.some(
        (call) =>
          call.name === 'subagent' &&
          call.arguments.action === 'start' &&
          call.arguments.agent === 'worker' &&
          !call.isError,
      ),
    ).toBe(true)
    expect(
      turn.toolCalls.some((call) => ['read', 'grep', 'find', 'bash'].includes(call.name)),
    ).toBe(false)
    expect(turn.text).toContain('src/parser.ts')
    expect(
      (await ultimate.conversations()).some(
        (item) => item.parentConversationId === c.id && item.label === 'worker',
      ),
    ).toBe(true)
    measure('E4-delegate', turn)
  } finally {
    await ultimate.stop()
  }
})

test('E5 knows the other conversation without tools', async () => {
  const ultimate = await start({ extensions: { enable: ['conversations'] } })
  try {
    const other = await ultimate.conversation({
      history: [user('Fix the parser'), assistant('I am investigating the parser.')],
    })
    const c = await ultimate.conversation({
      history: [
        user(
          'When I ask about other conversations, use only the conversation index already supplied in your system context. Do not inspect live state with tools.',
        ),
        assistant('I will answer from the supplied conversation index without calling tools.'),
      ],
    })
    const turn = await c.run(
      'Which other conversations exist in this project and what are they doing? No tools.',
    )
    expect(turn.toolCalls).toHaveLength(0)
    expect(turn.text).toContain(String(other.id))
    expect(turn.text).toMatch(/parser/i)
    measure('E5-awareness', turn)
  } finally {
    await ultimate.stop()
  }
})

test('E6 explains how to enable an off building block', async () => {
  const ultimate = await start()
  try {
    const c = await ultimate.conversation({
      history: [
        user(
          'For questions about building blocks, answer from your current system guidance without inspecting files or calling tools. I only need instructions, not a settings change.',
        ),
        assistant(
          'I will explain the building-block settings from the supplied guidance without tools or changes.',
        ),
      ],
    })
    const turn = await c.run(
      'Is the plan extension on? If not, tell me exactly which file to edit to enable it for this project. Include the settings key. No tools.',
    )
    expect(turn.toolCalls).toHaveLength(0)
    expect(turn.text).toMatch(/^no\b|off|not enabled|disabled|not.*on|not.*loaded/i)
    expect(turn.text).toContain('.ultimate/settings.json')
    expect(turn.text).toMatch(/extensions[\s\S]*enable/)
    measure('E6-building-block', turn)
  } finally {
    await ultimate.stop()
  }
})
