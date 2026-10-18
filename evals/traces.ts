import { readFile } from 'node:fs/promises'
import type { Message } from '@earendil-works/pi-ai'

/** A persisted turn is attributed to its test, even when a later scenario assertion fails. */
export interface EvalTurnTrace {
  testId: string
  conversationId: number
  messages: Message[]
  input?: string
  failure?: string
}

/** Print the failed test's recorded tool arguments and results, without exposing other tests' turns. */
export async function printFailedEvalTraces(
  traceFile: string,
  testId: string,
  write: (text: string) => void,
) {
  const traces = (await readFile(traceFile, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      // SAFETY: this eval-local JSONL is written by the fixture as EvalTurnTrace, not supplied by a model.
      return JSON.parse(line) as EvalTurnTrace
    })
    .filter((trace) => trace.testId === testId)
  if (!traces.length) {
    write(`No recorded turns for failed test ${testId}; trace: ${traceFile}\n`)
    return
  }
  const turns = traces.map((trace) => {
    const calls = trace.messages.flatMap((message) =>
      message.role === 'assistant'
        ? message.content.filter((part) => part.type === 'toolCall')
        : [],
    )
    const results = trace.messages.filter((message) => message.role === 'toolResult')
    return {
      conversationId: trace.conversationId,
      toolCalls: calls.map((call) => ({
        ...call,
        result: results.find((result) => result.toolCallId === call.id) ?? null,
      })),
    }
  })
  write(
    `Failed eval tool arguments/results for ${testId}; trace: ${traceFile}\n${JSON.stringify(turns, null, 2)}\n`,
  )
}
