import { AsyncLocalStorage } from 'node:async_hooks'
import { LiveDoc } from '@earendil-works/pi-durable'
import type { Conversation, Harness, Submission } from '@earendil-works/pi-durable'
import { context } from '../server/harness.ts'
import { EVAL_BUDGETS } from './budgets.ts'

/** Per-test identity and monotonic deadline, shared across all fixtures and turns in that test. */
export interface EvalTestContext {
  testId: string
  deadlineMs: number
}

/** Async-local attribution keeps concurrent tests' deadlines and diagnostic traces separate. */
export const evalTestContext = new AsyncLocalStorage<EvalTestContext>()

/** Read committed eval entries without keeping a live view mounted. */
export async function readEvalEntries(conversation: Conversation) {
  const view = await conversation.viewState(context)
  try {
    return [...view.value.entries]
  } finally {
    view.dispose()
  }
}

/** Snapshot whole-harness live work separately from the target conversation and its current progress. */
export async function readEvalDiagnostics(
  harness: Harness,
  conversation: Conversation,
  before: number,
  submission?: Submission,
) {
  const graph = await harness.taskGraph(context)
  try {
    const entries = await readEvalEntries(conversation)
    const tasks = Object.values(graph.value.tasks).map((task) => ({
      ...task,
      owner: task.owner ?? { conversationId: task.conversationId },
    }))
    const otherIds = [
      ...new Set(
        tasks
          .filter((task) => !task.background && task.conversationId !== conversation.id)
          .map((task) => task.conversationId),
      ),
    ]
    const otherConversations = await Promise.all(
      otherIds.map(async (id) => {
        const other = await harness.conversation(id, context)
        return {
          conversationId: id,
          live: await harness.snapshot(LiveDoc, id, context),
          recentEntries: other ? (await readEvalEntries(other)).slice(-12) : [],
        }
      }),
    )
    return {
      targetConversationId: conversation.id,
      idleScope: 'whole-harness ownerless conversations, excluding background work',
      submission: submission ? await submission.status(context) : null,
      nonBackgroundTasks: tasks.filter((task) => !task.background),
      backgroundTasks: tasks.filter((task) => task.background),
      otherConversations,
      progress: {
        entriesAtStart: before,
        entriesNow: entries.length,
        live: await harness.snapshot(LiveDoc, conversation.id, context),
      },
      recentEntries: entries.slice(-12),
      toolCalls: entries
        .slice(before)
        .flatMap((entry) =>
          (entry.model ?? []).flatMap((message) =>
            message.role === 'assistant'
              ? message.content.filter((part) => part.type === 'toolCall')
              : [],
          ),
        ),
    }
  } finally {
    graph.dispose()
  }
}

/** Bound submission plus global idle by 240s and the shared test deadline; failures retain diagnostic facts, not a hang verdict. */
export async function waitForTurn(
  harness: Harness,
  conversation: Conversation,
  submit: () => Promise<Submission>,
  testDeadlineMs: number,
) {
  const started = performance.now()
  const turnBudgetMs = Math.max(0, Math.min(EVAL_BUDGETS.turnMs, testDeadlineMs - started))
  let before = 0
  let stage = 'submitting'
  let submission: Submission | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      (async () => {
        if (!turnBudgetMs) {
          throw new Error('Eval test deadline exhausted before submission')
        }
        before = (await readEvalEntries(conversation)).length
        submission = await submit()
        stage = 'awaiting-submission'
        await submission.wait(context)
        const entries = await readEvalEntries(conversation)
        const failed = entries
          .slice(before)
          .flatMap((entry) => entry.model ?? [])
          .find(
            (message) =>
              message.role === 'assistant' &&
              (message.stopReason === 'error' || message.stopReason === 'aborted'),
          )
        if (failed?.role === 'assistant') {
          throw new Error(`Model turn failed: ${failed.errorMessage ?? failed.stopReason}`)
        }
        stage = 'awaiting-idle'
        await harness.waitForIdle(context)
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Eval turn deadline exceeded')), turnBudgetMs)
      }),
    ])
  } catch (cause) {
    const diagnostics = await readEvalDiagnostics(harness, conversation, before, submission)
    throw new Error(
      `${cause instanceof Error ? cause.message : String(cause)}\n${JSON.stringify(
        {
          stage,
          elapsedMs: performance.now() - started,
          testElapsedMs: EVAL_BUDGETS.activeTestMs - (testDeadlineMs - performance.now()),
          turnBudgetMs,
          testDeadlineMs,
          testRemainingMs: testDeadlineMs - performance.now(),
          outerTestBudgetMs: EVAL_BUDGETS.outerTestMs,
          diagnosticCleanupReserveMs: EVAL_BUDGETS.diagnosticCleanupMs,
          ...diagnostics,
        },
        null,
        2,
      )}`,
      { cause },
    )
  } finally {
    clearTimeout(timer)
  }
}
