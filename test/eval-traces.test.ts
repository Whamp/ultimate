import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from 'vitest'
import { printFailedEvalTraces } from '../evals/traces.ts'
import type { EvalTurnTrace } from '../evals/traces.ts'
import { temp } from './helpers.ts'

it('prints received arguments and matched results after an ordinary scenario assertion failure, excluding other tests', async () => {
  const traceFile = join(await temp('ultimate-eval-traces-'), 'traces.jsonl')
  const first: EvalTurnTrace = {
    testId: 'failed-ledger-test',
    conversationId: 1,
    messages: [
      fauxAssistantMessage(
        [fauxToolCall('plan', { action: 'add', title: 'Review', role: 'reviewer' })],
        { stopReason: 'toolUse' },
      ),
    ],
  }
  const call = first.messages[0]
  if (call.role !== 'assistant' || call.content[0].type !== 'toolCall') {
    throw new Error('Expected test tool call')
  }
  first.messages.push({
    role: 'toolResult',
    toolCallId: call.content[0].id,
    toolName: 'plan',
    content: [{ type: 'text', text: 'Created E1.2 without deps' }],
    isError: false,
    timestamp: 0,
  })
  const second: EvalTurnTrace = {
    testId: 'failed-ledger-test',
    conversationId: 1,
    messages: [
      fauxAssistantMessage([fauxToolCall('plan', { action: 'show', key: 'E1' })], {
        stopReason: 'toolUse',
      }),
    ],
  }
  const unrelated: EvalTurnTrace = {
    testId: 'passing-automation-test',
    conversationId: 2,
    messages: [
      fauxAssistantMessage(
        [fauxToolCall('automation', { action: 'create', name: 'DO NOT PRINT OTHER TEST' })],
        { stopReason: 'toolUse' },
      ),
    ],
  }
  const original =
    [unrelated, first, second].map((trace) => JSON.stringify(trace)).join('\n') + '\n'
  await writeFile(traceFile, original)
  let printed = ''
  // Same file-read/filter/print path the reporter calls only for failed TestCases; no model error required.
  await printFailedEvalTraces(traceFile, 'failed-ledger-test', (text) => {
    printed += text
  })
  expect(printed).toContain('"title": "Review"')
  expect(printed).toContain('"role": "reviewer"')
  expect(printed).toContain('Created E1.2 without deps')
  expect(printed).toContain('"key": "E1"')
  expect(printed).toContain('"result": null')
  expect(printed).not.toContain('DO NOT PRINT OTHER TEST')
  expect(printed).not.toContain('passing-automation-test')
  expect(printed).toContain(traceFile)
  expect(await readFile(traceFile, 'utf8')).toBe(original)
})

it('reports missing failed-test traces explicitly, rather than printing unrelated success', async () => {
  const traceFile = join(await temp('ultimate-eval-traces-'), 'traces.jsonl')
  await writeFile(traceFile, '')
  let printed = ''
  await printFailedEvalTraces(traceFile, 'setup-failure', (text) => {
    printed += text
  })
  expect(printed).toContain('No recorded turns for failed test setup-failure')
})

it('does not silently swallow an unreadable evidence file', async () => {
  const missingFile = join(await temp('ultimate-eval-traces-'), 'missing.jsonl')
  await expect(printFailedEvalTraces(missingFile, 'failed-test', () => {})).rejects.toThrow(
    'ENOENT',
  )
})
