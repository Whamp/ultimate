import { expect, it } from 'vitest'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import fauxExtension from '../extensions/faux/server.ts'
import { generateSummary } from '../extensions/conversations/summary.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { temp } from './helpers.ts'

it('derives neutral faux summaries from the latest prompt and only flags the questions reply', async () => {
  const faux = fauxProvider()
  await fauxExtension({ faux, home: await temp('ultimate-faux-summary-demo-') } as ExtensionHost)
  const models = createModels()
  models.setProvider(faux.provider)
  const summarize = (source: string) =>
    generateSummary(
      models,
      source,
      new AbortController().signal,
      true,
      { model: { provider: 'faux', id: 'faux-1', thinking: 'off' } },
      'reply',
      false,
      true,
    )
  const prompt =
    'Review the ordinary layout and explain how the application works without changing it'
  const normal = await summarize(
    `user: Earlier prompt\n\nassistant: Earlier reply\n\nuser:  ${prompt}\n\nassistant: Complete.`,
  )
  expect(normal).toEqual({
    assessment: 'done',
    activity: 'Replied in the demo.',
    title: prompt.slice(0, 60),
    summary: 'Scripted demo conversation.',
    feature: 'Demo',
    abstract: `Ask: ${prompt.slice(0, 60)}\nState: scripted demo reply`,
  })
  const question = await summarize(
    'user: questions demo\n\nassistant: Should we keep the preview running?',
  )
  expect(question.assessment).toBe('needs_input')
  expect(question.title).toBe('questions demo')
  const answered = await summarize(
    'user: questions demo\n\nassistant: Should we keep the preview running?\n\nuser: Q: Should we keep the preview running?\nA: Yes\n\nassistant: Understood.',
  )
  expect(answered.assessment).toBe('done')
  expect(answered.feature).toBe('Demo')
})
