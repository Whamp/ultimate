import { cp, mkdir, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterAll, vi } from 'vitest'
import { context, prepareHarness } from '../../server/harness.ts'
import { Metadata } from '../../server/metadata.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { ActionContext } from '../../server/actions.ts'
import workspaceExtension, { actions } from '../../extensions/workspaces/server.ts'
import { workspaces } from '../../extensions/workspaces/workspaces.ts'
import { git } from '../../extensions/workspaces/git.ts'
import { leaveNote, rootOf } from '../../extensions/lineage/server.ts'
import self from '../../extensions/self/server.ts'
import board from '../../extensions/board/server.ts'
import subagents, { Subagents } from '../../extensions/subagents/server.ts'
import { temp, until } from '../helpers.ts'

// Every test has its own repository and harness, so they all run concurrently; fixtures close when the file ends.
const cleanup: (() => Promise<void>)[] = []
afterAll(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()))
})
/** A repository with base.txt and a worktree `worker` definition, made once and copied for each test. */
let template: Promise<string> | undefined
export async function workspaceRepository() {
  template ??= (async () => {
    const path = join(await temp('ultimate-workspaces-template-'), 'project')
    await mkdir(join(path, 'agents'), { recursive: true })
    await git(path, 'init', '-b', 'main')
    await git(path, 'config', 'user.email', 'test@example.com')
    await git(path, 'config', 'user.name', 'Test')
    await writeFile(join(path, 'base.txt'), 'base')
    await writeFile(
      join(path, 'agents/worker.md'),
      '---\nname: worker\ndescription: Writes\nisolate: worktree\n---\nCommit the assigned change.\n',
    )
    await git(path, 'add', '.')
    await git(path, 'commit', '-m', 'base')
    return path
  })()
  const directory = await temp('ultimate-workspaces-')
  const projectRoot = join(directory, 'project')
  await cp(await template, projectRoot, { recursive: true })
  return { directory, projectRoot, home: join(directory, 'state') }
}
type Answer = (text: string) => ReturnType<typeof fauxAssistantMessage>
const noIdea: Answer = () => fauxAssistantMessage('no idea')
/** Open a real Git workspace with the server extensions and a deterministic faux model. */
export async function workspaceFixture(
  commands: string[] = [],
  existing?: Awaited<ReturnType<typeof workspaceRepository>>,
  boardEnabled = false,
) {
  const paths = existing ?? (await workspaceRepository())
  const prepared = await prepareHarness({
    ...paths,
    userHome: paths.directory,
    ultimateRoot: paths.projectRoot,
    faux: true,
  })
  let opened: Awaited<ReturnType<typeof prepared.open>>
  const resources = new Map<string, unknown>()
  const services = new Map<string, unknown>()
  const restart = vi.fn<ExtensionHost['restart']>(async () => 'RESTART_CALLED')
  const notice = vi.fn<ExtensionHost['notice']>()
  // As the server: openers run each time the harness opens, cleanups each time it closes.
  const openers: (() => Promise<void>)[] = []
  const closers: (() => Promise<void>)[] = []
  const host = {
    ...prepared,
    harness: () => opened.harness,
    metadata: Metadata,
    provide: (name: string, value: unknown) => {
      services.set(name, value)
    },
    use: (name: string) =>
      services.get(name) ??
      (name === 'lineage' && host.extensions().some((e) => e.name === 'lineage' && e.enabled)
        ? {
            rootOf: (id: number, ctx: typeof context) => rootOf(host, id, ctx),
            leaveNote: (
              to: number | 'root',
              text: string,
              source: Parameters<typeof leaveNote>[3],
            ) => leaveNote(host, to, text, source),
          }
        : undefined),
    projectSettings: async () => ({ isolates: { worktree: { setup: commands } } }),
    extensions: () => [{ name: 'workspaces', enabled: true }],
    resource<T>(key: string, create: () => T): T {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key) as T
    },
    restart,
    notice,
    onOpen: (callback: () => Promise<void>) => openers.push(callback),
    onClose: (close: () => Promise<void>) => closers.push(close),
    doc: () => undefined,
    build: () => ({ id: 'test-build' }),
    system: () => ({ process: {} }),
  } as unknown as ExtensionHost
  const service = workspaces(host)
  if (boardEnabled) prepared.registry.install(board(host))
  prepared.registry.install(workspaceExtension(host))
  prepared.registry.install(self(host))
  prepared.registry.install(subagents(host))
  prepared.registry.install(CodingTools)
  /** How the faux model answers the lander's failure prompt; the default says it found nothing. */
  let landerAnswer: Answer = noIdea
  /** How the faux model continues the lander's failure run after a tool result; by default it echoes the result. */
  let landerAfterTool: Answer | undefined
  let writes = 0
  /** Requests a user's `ASK …` question started. */
  const asked: Parameters<FauxResponseFactory>[0][] = []
  prepared.registry.install(
    defineExtension({
      name: 'test-writing',
      tools: [
        defineTool({
          name: 'write_commit',
          description: 'Write and commit a change',
          parameters: Type.Object({}),
          async execute(_args, api) {
            writes++
            const cwd = api.env!.cwd
            await writeFile(join(cwd, 'change.txt'), 'change')
            await git(cwd, 'add', '.')
            await git(cwd, 'commit', '-m', 'workspace change')
            return { output: [{ type: 'text', text: 'committed' }] }
          },
        }),
      ],
    }),
  )
  const route: FauxResponseFactory = (transcript) => {
    prepared.faux!.appendResponses([route])
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    const text =
      typeof last.content === 'string'
        ? last.content
        : last.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
    // The lander task's question to its model; the submitter's report starts alike but names no mode.
    if (last.role === 'user' && text.startsWith('[lander] Submission') && text.includes('\nMode: '))
      return landerAnswer(text)
    if (last.role === 'user' && text.startsWith('ASK ')) {
      asked.push(transcript)
      return fauxAssistantMessage('Nothing landed yet.')
    }
    if (last.role === 'user' && text.startsWith('CALL ')) {
      const { tool, args } = JSON.parse(text.slice(5))
      return fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: 'toolUse' })
    }
    if (last.role === 'toolResult') {
      const prompt = transcript.messages.findLast((message) => message.role === 'user')
      if (landerAfterTool && JSON.stringify(prompt?.content).includes('\\nMode: '))
        return landerAfterTool(text)
      return fauxAssistantMessage(text)
    }
    return fauxAssistantMessage('finished')
  }
  prepared.faux!.setResponses([route])
  opened = await prepared.open()
  for (const open of openers) await open()
  cleanup.push(async () => {
    for (const close of closers) await close()
    await opened.close()
  })
  const create = async () => {
    const result = await actions.create({}, { host } as ActionContext)
    await opened.harness.commit(
      (tx) => tx.appendEntry(result.id, { kind: 'test.submission', data: {} }),
      context,
    )
    return result.id
  }
  const call = async (id: ConversationId, tool: string, args: object = {}) => {
    const conversation = (await opened.harness.conversation(id, context))!
    await (
      await conversation.submit(
        { type: 'input', content: `CALL ${JSON.stringify({ tool, args })}` },
        context,
      )
    ).wait(context)
    await conversation.waitForIdle(context)
    const view = await conversation.viewState(context)
    try {
      return view.value.entries.filter((entry) => entry.kind === 'pi.tool-result').at(-1)
        ?.model?.[0]
    } finally {
      view.dispose()
    }
  }
  return {
    ...paths,
    prepared,
    host,
    service,
    restart,
    notice,
    create,
    call,
    get opened() {
      return opened
    },
    get writes() {
      return writes
    },
    asked,
    answerLander(answer: Answer, afterTool?: Answer) {
      landerAnswer = answer
      landerAfterTool = afterTool
    },
    reopen: async () => {
      for (const close of closers) await close()
      await opened.close()
      opened = await prepared.open()
      for (const open of openers) await open()
    },
  }
}
/** Commit a named file in a test repository and return its tip. */
export async function commitWorkspaceFile(path: string, name = 'change.txt') {
  await writeFile(join(path, name), name)
  await git(path, 'add', '.')
  await git(path, 'commit', '-m', name)
  return git(path, 'rev-parse', 'HEAD')
}
/**
 * Hold the first `git <command>` in the repository at `path` (and its worktrees) at its first ref update, with a
 * reference-transaction hook, until `release`; with `fail`, that update then fails, after the command changed the files.
 */
export async function holdWorkspaceGit(path: string, command: string, fail = false) {
  const started = join(path, `.git/${command}-started`)
  const gate = join(path, `.git/${command}-gate`)
  await writeFile(
    join(path, '.git/hooks/reference-transaction'),
    `#!/bin/sh
cat >/dev/null
[ "$1" = prepared ] && [ ! -f '${started}' ] || exit 0
case "$(tr '\\0' ' ' < /proc/$PPID/cmdline)" in "git ${command} "*) ;; *) exit 0 ;; esac
touch '${started}'
while [ ! -f '${gate}' ]; do sleep 0.02; done
${fail ? 'exit 1' : ''}
`,
    { mode: 0o755 },
  )
  return {
    started: () =>
      until(() =>
        access(started).then(
          () => true,
          () => false,
        ),
      ),
    release: () => writeFile(gate, ''),
  }
}

/** Create a child isolate sourced from its parent checkout through the subagent tool. */
export async function nestedWorkspaceFixture() {
  const f = await workspaceFixture()
  const parent = await f.create()
  await f.service.ready(parent, context)
  const parentWorkspace = (await f.service.get(parent, context))!
  await f.call(parent, 'subagent', {
    action: 'start',
    agent: 'worker',
    task: 'finish',
    isolate: 'worktree',
  })
  const child = Object.values(
    (await f.opened.harness.snapshot(Subagents, parent, context))!.agents,
  )[0].conversationId
  const childWorkspace = (await f.service.get(child, context))!
  return { f, parent, child, parentWorkspace, childWorkspace }
}
