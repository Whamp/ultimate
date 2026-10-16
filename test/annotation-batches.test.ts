import { resolve } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { afterEach, beforeAll, expect, it } from 'vitest'
import { Plan } from '../extensions/plan/server.ts'
import { AnnotationHistory } from '../.ultimate/extensions/conversation-annotations/server.ts'
import { annotationFingerprint } from '../.ultimate/extensions/conversation-annotations/annotation-domain.ts'
import type {
  AnnotationBatchInput,
  AnnotationSource,
} from '../.ultimate/extensions/conversation-annotations/annotation-domain.ts'
import { context } from '../server/harness.ts'
import { fauxServer, post, sourceCopy, temp, until } from './helpers.ts'

let ultimateRoot: string
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp())
})
const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close()
  }
})
async function fixture(reopen?: string) {
  const home = reopen ?? (await temp())
  const server = await fauxServer({ ultimateRoot, projectRoot: ultimateRoot, home, userHome: home })
  servers.push(server)
  server.host.faux!.setResponses([fauxAssistantMessage('Normal agent reply.')])
  return { server, home }
}
function source(entryId: number, content = 'Original source field'): AnnotationSource {
  return {
    location: { kind: 'entry', conversationId: 1, entryId },
    title: 'Agent response',
    quote: 'source',
    content,
    fingerprint: annotationFingerprint(content),
  }
}
function forgedSnapshot(selected: AnnotationSource, content: string): AnnotationSource {
  return { ...selected, content, fingerprint: annotationFingerprint(content) }
}
function batch(
  id: string,
  selected: AnnotationSource,
  revision = 0,
  text = 'First feedback',
): AnnotationBatchInput {
  return {
    id,
    drafts: [{ id: `comment-${id}`, threadId: 'thread-one', revision, source: selected, text }],
    text: 'General feedback',
    images: [],
  }
}
async function accept(server: Awaited<ReturnType<typeof fauxServer>>, input: AnnotationBatchInput) {
  return post(server, '/api/extensions/conversation-annotations/actions/accept', {
    conversationId: 1,
    args: input,
  })
}
async function agentEntry(server: Awaited<ReturnType<typeof fauxServer>>) {
  return server.harness.commit(
    async (tx) =>
      (
        await tx.appendEntry(server.root.id, {
          kind: 'pi.assistant',
          data: {},
          model: [fauxAssistantMessage('Original source field')],
        })
      ).id,
    context,
  )
}
async function history(server: Awaited<ReturnType<typeof fauxServer>>) {
  return server.harness.snapshot(AnnotationHistory, server.root.id, context)
}

it('atomically accepts history and an outbox, deduplicates uncertain retries, and persists after reopen', async () => {
  const { server, home } = await fixture()
  const input = batch('batch-one', source(await agentEntry(server)))
  const accepted = await accept(server, input)
  expect(accepted.status).toBe(200)
  expect(accepted.data.result).toMatchObject({ id: 'batch-one', status: 'accepted' })
  const duplicate = await accept(server, input)
  expect(duplicate.status).toBe(200)
  await until(async () => (await history(server))?.batches['batch-one'].status === 'delivered')
  const state = (await history(server))!
  expect(state.threads['thread-one'].comments).toHaveLength(1)
  expect(state.threads['thread-one'].revision).toBe(1)
  const entries = await server.root.entries({}, 100, undefined, context)
  expect(
    entries.items.filter((entry) => entry.kind === 'conversation-annotations.batch'),
  ).toHaveLength(1)
  expect(entries.items.some((entry) => entry.kind === 'pi.assistant')).toBe(true)
  await server.close()
  servers.splice(servers.indexOf(server), 1)
  const reopened = (await fixture(home)).server
  expect((await history(reopened))?.threads).toEqual(state.threads)
  expect((await accept(reopened, input)).status).toBe(200)
  expect((await history(reopened))?.threads['thread-one'].comments).toHaveLength(1)
})

it('revisits with original snapshots and ordered comments; rejects stale revisions without partial history', async () => {
  const { server } = await fixture()
  const selected = source(await agentEntry(server))
  expect((await accept(server, batch('first', selected))).status).toBe(200)
  expect((await accept(server, batch('second', selected, 1, 'Changed my mind'))).status).toBe(200)
  const current = (await history(server))!
  expect(current.threads['thread-one'].source).toEqual(selected)
  expect(current.threads['thread-one'].comments.map((comment) => comment.text)).toEqual([
    'First feedback',
    'Changed my mind',
  ])
  const prompt = current.batches.second.text
  expect(prompt).toContain('"quote": "source"')
  expect(prompt).not.toContain('Original source field')
  expect(prompt.indexOf('First feedback')).toBeLessThan(prompt.indexOf('Changed my mind'))
  const conflict = batch('conflict', selected, 1)
  conflict.drafts.unshift({
    ...conflict.drafts[0],
    id: 'new-comment',
    threadId: 'new-thread',
    revision: 0,
  })
  expect((await accept(server, conflict)).status).toBe(500)
  expect((await history(server))?.threads['new-thread']).toBeUndefined()
  expect((await history(server))?.batches.conflict).toBeUndefined()
  const reused = batch('first', selected, 0, 'Different payload')
  expect((await accept(server, reused)).data.error).toContain('batch id was already accepted')
})

it('retries delivery with the same durable input request id, including after a receipt-window failure', async () => {
  const { server } = await fixture()
  const input = batch('retry', source(await agentEntry(server)))
  await accept(server, input)
  await until(async () => (await history(server))?.batches.retry.status === 'delivered')
  const originalSubmission = (await history(server))!.batches.retry.submissionId
  // Model a crash after Pi admitted the input but before the outbox stored its delivery receipt.
  await server.harness.commit(async (tx) => {
    const receipt = (await tx.doc(AnnotationHistory, server.root.id)).batches.retry
    receipt.status = 'error'
    receipt.error = 'Receipt write interrupted'
    delete receipt.submissionId
  }, context)
  const retry = await post(server, '/api/extensions/conversation-annotations/actions/retry', {
    conversationId: 1,
    args: { id: 'retry' },
  })
  expect(retry.status).toBe(200)
  await until(async () => (await history(server))?.batches.retry.status === 'delivered')
  expect((await history(server))?.batches.retry.submissionId).toBe(originalSubmission)
  expect(
    (await server.root.entries({}, 100, undefined, context)).items.filter(
      (entry) => entry.kind === 'conversation-annotations.batch',
    ),
  ).toHaveLength(1)
})

it('keeps plan/task ownership separate from the delivery target and retains original revisions after source edits', async () => {
  const { server } = await fixture()
  const owner = await server.harness.commit(async (tx) => {
    const created = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    ;(await tx.doc(Plan, created.id)).epics.E1 = {
      key: 'E1',
      title: 'Plan',
      body: 'original quote and UNSELECTED-SENTINEL',
      status: 'planning',
      tasks: {
        'E1.5': {
          key: 'E1.5',
          title: 'Task',
          description: 'task selected quote and private field remainder',
          role: 'worker',
          deps: [],
          status: 'todo',
          notes: [],
        },
      },
    }
    return created.id
  }, context)
  const selected: AnnotationSource = {
    location: {
      kind: 'plan',
      conversationId: owner,
      document: 'ultimate.plan',
      record: 'E1',
      field: 'body',
    },
    title: 'Plan',
    quote: 'original quote',
    content: 'original quote and UNSELECTED-SENTINEL',
    fingerprint: annotationFingerprint('original quote and UNSELECTED-SENTINEL'),
  }
  const first = batch('plan-first', selected)
  first.drafts.push({
    ...first.drafts[0],
    id: 'task-comment',
    threadId: 'task-thread',
    source: {
      ...selected,
      location: {
        kind: 'plan',
        conversationId: owner,
        document: 'ultimate.plan',
        record: 'E1.5',
        field: 'description',
      },
      quote: 'task selected quote',
      content: 'task selected quote and private field remainder',
      fingerprint: annotationFingerprint('task selected quote and private field remainder'),
    },
  })
  expect((await accept(server, first)).status).toBe(200)
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Plan, owner)).epics.E1.body = 'Source has changed'
  }, context)
  expect((await accept(server, batch('plan-revisit', selected, 1, 'New feedback'))).status).toBe(
    200,
  )
  const state = (await history(server))!
  expect(state.threads['thread-one'].source.content).toBe('original quote and UNSELECTED-SENTINEL')
  expect(state.threads['thread-one'].source.location.conversationId).toBe(owner)
  expect(state.batches['plan-revisit'].text).toContain('original quote')
  expect(state.batches['plan-revisit'].text).not.toContain('UNSELECTED-SENTINEL')
  expect(state.batches['plan-revisit'].text).not.toContain('Source has changed')
  expect(state.batches['plan-revisit'].text.indexOf('First feedback')).toBeLessThan(
    state.batches['plan-revisit'].text.indexOf('New feedback'),
  )
})

it('rejects forged immutable snapshots and empty tool ids atomically, but accepts rendered Markdown excerpts', async () => {
  const { server } = await fixture()
  const assistantParts = [
    '## Heading\n\n| Column | Rule |\n| --- | --- |\n| First | Keep |',
    'UNSELECTED-SENTINEL',
  ]
  const toolParts = ['First tool block', 'Second tool block']
  const ids = await server.harness.commit(async (tx) => {
    const assistant = await tx.appendEntry(server.root.id, {
      kind: 'pi.assistant',
      data: {},
      model: [fauxAssistantMessage(assistantParts.map((text) => ({ type: 'text', text })))],
    })
    const tool = await tx.appendEntry(server.root.id, {
      kind: 'pi.tool-result',
      data: {},
      model: [
        {
          role: 'toolResult',
          toolCallId: 'text-call',
          toolName: 'read',
          content: toolParts.map((text) => ({ type: 'text', text })),
          isError: false,
          timestamp: 1,
        },
      ],
    })
    return { assistant: assistant.id, tool: tool.id }
  }, context)
  const assistant = {
    ...source(ids.assistant, assistantParts.join('\n')),
    quote: 'Column\tRule\nFirst\tKeep',
  }
  const tool: AnnotationSource = {
    ...source(ids.tool, toolParts.join('\n')),
    location: { kind: 'tool', conversationId: 1, entryId: ids.tool, toolCallId: 'text-call' },
  }
  const invalid = [
    {
      source: forgedSnapshot(assistant, 'Fabricated assistant snapshot'),
      error: 'snapshot does not match stored text',
    },
    {
      source: forgedSnapshot(tool, 'Fabricated tool snapshot'),
      error: 'snapshot does not match stored text',
    },
    {
      source: forgedSnapshot(tool, toolParts.join('')),
      error: 'snapshot does not match stored text',
    },
    { source: { ...assistant, fingerprint: 'wrong' }, error: 'source fingerprint mismatch' },
    ...['', '   '].map((toolCallId) => ({
      source: {
        ...tool,
        location: { kind: 'tool' as const, conversationId: 1, entryId: ids.tool, toolCallId },
      },
      error: 'tool call id is required',
    })),
  ]
  const before = await history(server)
  for (const [index, rejected] of invalid.entries()) {
    const input = batch(`bad-snapshot-${index}`, assistant)
    input.drafts.push({
      ...input.drafts[0],
      id: 'invalid-comment',
      threadId: 'invalid-thread',
      source: rejected.source,
    })
    const response = await accept(server, input)
    expect(response.status).toBe(500)
    expect(response.data.error).toContain(rejected.error)
    expect(await history(server)).toEqual(before)
  }
  expect(
    (await server.root.entries({}, 100, undefined, context)).items.some(
      (entry) => entry.kind === 'conversation-annotations.batch',
    ),
  ).toBe(false)
  const valid = batch('verified-snapshots', assistant)
  valid.drafts.push({
    ...valid.drafts[0],
    id: 'tool-comment',
    threadId: 'tool-thread',
    source: tool,
  })
  expect((await accept(server, valid)).status).toBe(200)
  const state = (await history(server))!
  expect(state.threads['thread-one'].source.content).toBe(assistantParts.join('\n'))
  expect(state.threads['tool-thread'].source.content).toBe(toolParts.join('\n'))
  expect(assistant.content).not.toContain(assistant.quote)
  expect(state.batches['verified-snapshots'].text).toContain(JSON.stringify(assistant.quote))
  expect(state.batches['verified-snapshots'].text).not.toContain('UNSELECTED-SENTINEL')
})

it('validates plan field syntax by record kind without requiring live historical fields or notes', async () => {
  const { server } = await fixture()
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Plan, server.root.id)).epics.E1 = {
      key: 'E1',
      title: 'Live epic',
      body: 'Live body',
      status: 'planning',
      tasks: {
        'E1.5': {
          key: 'E1.5',
          title: 'Live task',
          description: 'Edited description',
          role: 'worker',
          deps: [],
          status: 'todo',
          notes: [],
        },
      },
    }
  }, context)
  const planSource = (record: string, field: string): AnnotationSource => ({
    ...source(1, 'Historical field snapshot'),
    location: { kind: 'plan', conversationId: 1, document: 'ultimate.plan', record, field },
  })
  const invalid = [
    ['E1', 'description'],
    ['E1', 'notes:2026-10-16T17:00:00.000Z:0'],
    ['E1.5', 'body'],
    ['E1.5', 'notes:garbage:0'],
    ['E1.5', 'notes:2026-02-31T17:00:00.000Z:0'],
    ['E1.5', 'notes:2026-10-16T17:00:00.000Z:-1'],
    ['E1.5', 'notes:2026-10-16T17:00:00.000Z:9007199254740992'],
    ['E1.5', 'status'],
    ['E1.5.2', 'title'],
  ]
  const before = await history(server)
  for (const [index, [record, field]] of invalid.entries()) {
    const input = batch(`bad-field-${index}`, planSource('E1', 'body'))
    input.drafts.push({
      ...input.drafts[0],
      id: 'invalid-comment',
      threadId: 'invalid-thread',
      source: planSource(record, field),
    })
    const response = await accept(server, input)
    expect(response.status).toBe(500)
    expect(response.data.error).toContain('unsupported plan record or field')
    expect(await history(server)).toEqual(before)
  }
  const fields = [
    ['E1', 'title'],
    ['E1', 'body'],
    ['E1', 'verdict'],
    ['E1.5', 'title'],
    ['E1.5', 'description'],
    ['E1.5', 'verdict'],
    ['E1.5', 'notes:2026-10-16T17:00:00.000Z:0'],
  ]
  const valid = batch('historical-fields', planSource('E1', 'body'))
  valid.drafts = fields.map(([record, field], index) => ({
    ...valid.drafts[0],
    id: `historical-comment-${index}`,
    threadId: `historical-thread-${index}`,
    source: planSource(record, field),
  }))
  expect((await accept(server, valid)).status).toBe(200)
  const state = (await history(server))!
  expect(Object.values(state.threads)).toHaveLength(fields.length)
  expect(
    Object.values(state.threads).every(
      (thread) => thread.source.content === 'Historical field snapshot',
    ),
  ).toBe(true)
  expect(
    (
      await accept(server, {
        ...valid,
        id: 'historical-revisit',
        drafts: valid.drafts.map((draft, index) => ({
          ...draft,
          id: `revisit-comment-${index}`,
          revision: 1,
        })),
      })
    ).status,
  ).toBe(200)
  expect(
    Object.values((await history(server))!.threads).every((thread) => thread.revision === 2),
  ).toBe(true)
})

it('rejects forged source owners and includes actual stored image bytes rather than browser stand-ins', async () => {
  const { server } = await fixture()
  const imageData =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ZkAAAAASUVORK5CYII='
  const resultId = await server.harness.commit(
    async (tx) =>
      (
        await tx.appendEntry(server.root.id, {
          kind: 'pi.tool-result',
          data: {},
          model: [
            {
              role: 'toolResult',
              toolCallId: 'stable-call',
              toolName: 'screenshot',
              content: [{ type: 'image', data: imageData, mimeType: 'image/png' }],
              isError: false,
              timestamp: 1,
            },
          ],
        })
      ).id,
    context,
  )
  const imageSource: AnnotationSource = {
    ...source(resultId, ''),
    quote: '[Whole stored image 1]',
    location: {
      kind: 'tool',
      conversationId: 1,
      entryId: resultId,
      toolCallId: 'stable-call',
      imageIndex: 0,
    },
  }
  expect((await accept(server, batch('image', imageSource))).status).toBe(200)
  expect((await history(server))?.batches.image.images).toEqual([
    { data: imageData, mimeType: 'image/png' },
  ])
  const oversized = batch('too-many-images', imageSource, 1)
  oversized.images = Array.from({ length: 10 }, () => ({ data: imageData, mimeType: 'image/png' }))
  expect((await accept(server, oversized)).data.error).toContain(
    'combined composer and stored source images',
  )
  expect((await history(server))?.threads['thread-one'].comments).toHaveLength(1)
  expect((await history(server))?.batches['too-many-images']).toBeUndefined()
  const forged = {
    ...imageSource,
    location: {
      kind: 'tool' as const,
      conversationId: 1,
      entryId: resultId,
      toolCallId: 'wrong-call',
      imageIndex: 0,
    },
  }
  expect(
    (
      await accept(server, {
        ...batch('forged', forged),
        drafts: [{ ...batch('forged', forged).drafts[0], threadId: 'other-thread' }],
      })
    ).status,
  ).toBe(500)
  const owner = {
    ...imageSource,
    location: {
      kind: 'tool' as const,
      conversationId: 999,
      entryId: resultId,
      toolCallId: 'stable-call',
    },
  }
  expect((await accept(server, batch('wrong-owner', owner))).status).toBe(500)
  expect((await accept(server, { ...batch('invalid', source(resultId)), drafts: [] })).status).toBe(
    500,
  )
  expect(resolve(ultimateRoot)).not.toBe(resolve('.'))
})
