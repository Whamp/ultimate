import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { JsonObject } from '@earendil-works/pi-durable'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import cloudflare from '../../extensions/cloudflare/server.ts'
import { writeSecret } from '../../extensions/secrets/store.ts'
import { removeTemp, temp } from '../helpers.ts'

const CLEANUPS: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of CLEANUPS.splice(0)) await close()
})

/** Synthetic only; shared so redaction expectations use the exact credential given to the tool. */
export const CLOUDFLARE_TEST_TOKEN = 'synthetic-cloudflare-credential'
/** The default query uses fixed times and no real Worker. */
export const CLOUDFLARE_TEST_ARGS = { worker: 'example-worker', from: 1000, to: 2000 }

/** Exercise the registered tool through Pi's real argument and invocation boundary, without a model or API network. */
export async function cloudflareFixture(key = true, enabled = true) {
  const root = await temp()
  if (key) await writeSecret(root, 'CLOUDFLARE_API_TOKEN', CLOUDFLARE_TEST_TOKEN)
  const extension = cloudflare({
    userHome: root,
    extensions: () =>
      enabled
        ? [
            {
              name: 'secrets',
              enabled: true,
              source: 'builtin',
              layer: 'folder',
              path: root,
              actions: [],
              facets: { server: true, web: false },
              server: {
                loadedAt: '2026-10-17T00:00:00Z',
                tools: [],
                sections: [],
                hooks: 0,
                docs: [],
              },
            },
          ]
        : [],
  })
  const tool = extension.tools![0]
  const faux = fauxProvider({ tokensPerSecond: 0 })
  const models = createModels()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  registry.install(extension)
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context)
  CLEANUPS.push(async () => {
    await harness.close(context)
    await removeTemp(root)
  })
  const conversation = await harness.root(context, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' }, modelTools: { add: [tool] } },
  })
  return {
    root,
    tool,
    agent: () => conversation.agent(context),
    modelRuntime: () =>
      ModelRuntime.create({
        authPath: join(root, 'auth.json'),
        modelsPath: null,
        refreshOnCreate: false,
      }),
    async run(input: JsonObject = CLOUDFLARE_TEST_ARGS) {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall(tool.name, input)], { stopReason: 'toolUse' }),
        fauxAssistantMessage('Complete'),
      ])
      await conversation.submit({ type: 'input', content: 'Read synthetic telemetry' }, context)
      await harness.waitForIdle(context)
      const view = await conversation.viewState(context)
      const result = view.value.entries.findLast((entry) => entry.kind === 'pi.tool-result')
      const content = result?.model?.find((message) => message.role === 'toolResult')
      if (!content || content.role !== 'toolResult')
        throw new Error('Cloudflare fixture missing tool result')
      const text = content.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('')
      if (content.isError) throw new Error(text)
      return text
    },
  }
}
