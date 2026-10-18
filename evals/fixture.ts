import { execFile } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type {
  AssistantMessage,
  Message,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from '@earendil-works/pi-ai'
import { ModelRuntime, ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { AssistantEntry, ToolResultEntry, UserEntry } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { inject } from 'vitest'
import type { TurnUsage } from './reporter.ts'
import { evalTestContext, waitForTurn } from './turn.ts'
import type { EvalTurnTrace } from './traces.ts'
import { createServer } from '../server/main.ts'
import { context } from '../server/harness.ts'
import { attach, until } from '../test/helpers.ts'

const exec = promisify(execFile)
const zeroUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})
export const user = (text: string): UserMessage => ({
  role: 'user',
  content: text,
  timestamp: Date.now(),
})
export const assistant = (
  text: string,
  toolCalls: ToolCall[] = [],
): Omit<AssistantMessage, 'api' | 'provider' | 'model'> => ({
  role: 'assistant',
  content: [...(text ? [{ type: 'text' as const, text }] : []), ...toolCalls],
  usage: zeroUsage(),
  stopReason: toolCalls.length ? 'toolUse' : 'stop',
  timestamp: Date.now(),
})
export const toolResult = (
  callId: string,
  name: string,
  text: string,
  isError = false,
): ToolResultMessage => ({
  role: 'toolResult',
  toolCallId: callId,
  toolName: name,
  content: [{ type: 'text', text }],
  isError,
  timestamp: Date.now(),
})

const base = [
  'agent',
  'coding-tools',
  'prompt',
  'models',
  'notices',
  'theme',
  'codemode',
  'onboarding',
  'splash',
  'lineage',
]

export async function start(
  options: {
    project?: { files?: Record<string, string>; git?: boolean }
    extensions?: { enable?: string[]; disable?: string[] }
    model?: string
    thinking?: string
  } = {},
) {
  const model = options.model ?? process.env.ULTIMATE_EVAL_MODEL ?? 'openai/gpt-6-luna'
  const thinkingLevel = options.thinking ?? process.env.ULTIMATE_EVAL_THINKING ?? 'high'
  const runtime = await ModelRuntime.create()
  const available = await runtime.getAvailable()
  const selected = available.find((m) => `${m.provider}/${m.id}` === model)
  if (!selected)
    throw new Error(
      `Eval model ${model} is unavailable. Configure Pi auth/model or set ULTIMATE_EVAL_MODEL.`,
    )
  const directory = await mkdtemp(join(tmpdir(), 'ultimate-eval-'))
  const projectRoot = join(directory, 'project')
  const userHome = join(directory, 'user')
  let server: Awaited<ReturnType<typeof createServer>> | undefined
  const cleanup = async () => {
    await server?.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
  try {
    await mkdir(projectRoot, { recursive: true })
    for (const [path, content] of Object.entries(options.project?.files ?? {})) {
      const target = resolve(projectRoot, path)
      if (!target.startsWith(projectRoot + '/'))
        throw new Error(`Project file must be relative: ${path}`)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
    }
    if (options.project?.git) {
      await exec('git', ['init', '-q'], { cwd: projectRoot })
      await exec('git', ['add', '.'], { cwd: projectRoot })
      await exec(
        'git',
        [
          '-c',
          'user.name=Eval',
          '-c',
          'user.email=eval@example.invalid',
          'commit',
          '-qm',
          'Seed project',
        ],
        { cwd: projectRoot },
      )
    }
    const config = join(userHome, '.ultimate')
    await mkdir(config, { recursive: true })
    // Every built-in is on by default; an eval loads the coding agent plus only what it measures.
    const loaded = [...base, ...(options.extensions?.enable ?? [])]
    await writeFile(join(config, 'onboarding.json'), '{"firstRunDone":true}')
    await writeFile(
      join(config, 'settings.json'),
      JSON.stringify({
        extensions: {
          disable: [
            ...(await readdir(resolve('extensions'), { withFileTypes: true }))
              .filter((entry) => entry.isDirectory() && !loaded.includes(entry.name))
              .map((entry) => entry.name),
            ...(options.extensions?.disable ?? []),
          ],
        },
      }),
    )
    new ProjectTrustStore(config).set(projectRoot, true)
    server = await createServer({
      ultimateRoot: resolve('.'),
      projectRoot,
      userHome,
      home: join(directory, 'state'),
      faux: false,
      port: 0,
    })
    const running = server
    async function post(path: string, body: unknown) {
      const response = await fetch(running.url + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: running.url },
        body: JSON.stringify(body),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${JSON.stringify(data)}`)
      return data
    }
    return {
      projectRoot,
      harness: running.harness,
      file: (path: string) => readFile(join(projectRoot, path), 'utf8'),
      exec: (command: string, args: string[]) => exec(command, args, { cwd: projectRoot }),
      action: (extension: string, action: string, args: unknown = {}) =>
        post(`/api/extensions/${extension}/actions/${action}`, { args }),
      stop: cleanup,
      async conversations() {
        const stream = await attach(running)
        try {
          await until(() => stream.events.some((event) => event.name === 'conversations'))
          return stream.events.findLast((event) => event.name === 'conversations')!
            .data as import('../shared/protocol.ts').ConversationSummary[]
        } finally {
          await stream.close()
        }
      },
      async conversation({
        id: existingId,
        history = [],
      }: { id?: ConversationId; history?: (Message | ReturnType<typeof assistant>)[] } = {}) {
        const id =
          existingId ?? ((await post('/api/conversations', {})) as { id: ConversationId }).id
        await post(`/api/conversations/${id}/configure`, {
          model: { provider: selected.provider, modelId: selected.id },
          thinkingLevel,
        })
        const conversation = await running.harness.conversation(id, context)
        if (!conversation) throw new Error(`Missing conversation ${id}`)
        await running.harness.commit(async (tx) => {
          for (const message of history) {
            switch (message.role) {
              case 'user':
                await tx.appendEntry(UserEntry, id, { model: [message] })
                break
              case 'assistant':
                await tx.appendEntry(AssistantEntry, id, {
                  model: [
                    {
                      ...message,
                      provider: selected.provider,
                      model: selected.id,
                      api: selected.api,
                    },
                  ],
                })
                break
              case 'toolResult':
                await tx.appendEntry(ToolResultEntry, id, {
                  model: [message],
                  data: { diagnostics: [] },
                })
                break
              default:
                throw new Error('History accepts user, assistant and toolResult messages only')
            }
          }
        }, context)
        async function messages() {
          const view = await conversation!.viewState(context)
          try {
            return view.value.entries.flatMap((entry) => entry.model ?? [])
          } finally {
            view.dispose()
          }
        }
        return {
          id,
          async run(input: string) {
            const before = (await messages()).length
            const started = performance.now()
            const testContext = evalTestContext.getStore()
            if (testContext === undefined) {
              throw new Error('Eval test context missing; load evals/setup.ts')
            }
            let turn: Message[] = []
            const usage = zeroUsage()
            let wallMs = 0
            let completed = false
            let failure: string | undefined
            const traceFile = inject('evalTraceFile')
            try {
              await waitForTurn(
                running.harness,
                conversation,
                async () => {
                  const { submissionId } = await post(`/api/conversations/${id}/submit`, {
                    text: input,
                  })
                  const submission = await running.harness.submission(submissionId, context)
                  if (!submission) {
                    throw new Error('Missing submitted input')
                  }
                  return submission
                },
                testContext.deadlineMs,
              )
              completed = true
            } catch (cause) {
              failure = cause instanceof Error ? cause.message : String(cause)
              throw new Error(`Eval turn failed; trace: ${traceFile}\n${failure}`, { cause })
            } finally {
              // Failed turns can already have paid responses. Record those too, before cleanup removes the home.
              turn = (await messages()).slice(before)
              for (const reply of turn) {
                if (reply.role !== 'assistant') {
                  continue
                }
                for (const key of [
                  'input',
                  'output',
                  'cacheRead',
                  'cacheWrite',
                  'totalTokens',
                ] as const) {
                  usage[key] += reply.usage[key]
                }
                for (const key of [
                  'input',
                  'output',
                  'cacheRead',
                  'cacheWrite',
                  'total',
                ] as const) {
                  usage.cost[key] += reply.usage.cost[key]
                }
              }
              wallMs = performance.now() - started
              const measured: TurnUsage = {
                model,
                tokens: usage.totalTokens,
                cost: usage.cost.total,
                wallMs,
                unfinished: !completed,
              }
              await appendFile(inject('evalUsageFile'), JSON.stringify(measured) + '\n')
              // Persist actual arguments/results even when a later scenario assertion fails.
              await appendFile(
                traceFile,
                JSON.stringify({
                  testId: testContext.testId,
                  conversationId: id,
                  input,
                  ...measured,
                  messages: turn,
                  failure,
                } satisfies EvalTurnTrace & TurnUsage) + '\n',
              )
            }
            const replies = turn.filter((m): m is AssistantMessage => m.role === 'assistant')
            const results = turn.filter((m): m is ToolResultMessage => m.role === 'toolResult')
            if (!replies.length) {
              throw new Error(`Model turn produced no assistant reply; trace: ${traceFile}`)
            }
            return {
              text: replies
                .flatMap((m) => m.content.filter((c) => c.type === 'text').map((c) => c.text))
                .join('\n'),
              toolCalls: replies
                .flatMap((m) => m.content.filter((c): c is ToolCall => c.type === 'toolCall'))
                .map((call) => {
                  const result = results.find((r) => r.toolCallId === call.id)
                  if (!result) {
                    throw new Error(`Tool ${call.name} has no result; trace: ${traceFile}`)
                  }
                  return { ...call, result: result.content, isError: result.isError }
                }),
              usage,
              wallMs,
            }
          },
        }
      },
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}
