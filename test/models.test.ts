import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import type { AuthInteraction } from '@earendil-works/pi-ai'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { afterEach, expect, it, vi } from 'vitest'
import { listModels } from '../server/models.ts'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function modelRuntimeFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ultimate-models-'))
  directories.push(directory)
  const modelsPath = join(directory, 'models.json')
  const runtime = await ModelRuntime.create({
    authPath: join(directory, 'auth.json'),
    modelsPath,
    modelsStorePath: join(directory, 'models-store.json'),
    refreshOnCreate: false,
  })
  return { runtime, modelsPath }
}

it('reloads custom models and API-key login metadata added after runtime creation', async () => {
  const { runtime, modelsPath } = await modelRuntimeFixture()
  expect(runtime.getProvider('coralbricks')).toBeUndefined()
  await writeFile(
    modelsPath,
    JSON.stringify({
      providers: {
        coralbricks: {
          name: 'CoralBricks',
          baseUrl: 'https://inference.coralbricks.ai/v1',
          api: 'openai-completions',
          models: [
            {
              id: 'glm-5.3-fast',
              name: 'GLM 5.3',
              reasoning: true,
              input: ['text'],
              contextWindow: 1048576,
              maxTokens: 32768,
            },
            {
              id: 'deepseek-v4.1-flash-fast',
              name: 'DeepSeek V4.1 Flash',
              reasoning: true,
              input: ['text', 'image'],
              contextWindow: 1048576,
              maxTokens: 32768,
            },
          ],
        },
      },
    }),
  )

  const beforeLogin = await listModels(runtime)
  expect(beforeLogin.models.filter((model) => model.provider === 'coralbricks')).toMatchObject([
    { id: 'glm-5.3-fast', name: 'GLM 5.3', contextWindow: 1048576, available: false },
    {
      id: 'deepseek-v4.1-flash-fast',
      name: 'DeepSeek V4.1 Flash',
      contextWindow: 1048576,
      available: false,
    },
  ])
  expect(beforeLogin.providers.find((provider) => provider.id === 'coralbricks')).toEqual({
    id: 'coralbricks',
    name: 'API key',
    authTypes: [{ type: 'api_key', name: 'API key' }],
    status: { configured: false },
    isUsingSubscription: false,
  })

  const prompt = vi.fn<AuthInteraction['prompt']>(async () => 'synthetic-coralbricks-test-key')
  await runtime.login('coralbricks', 'api_key', { prompt, notify() {} })
  expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ type: 'secret' }))
  const afterLogin = await listModels(runtime)
  expect(afterLogin.providers.find((provider) => provider.id === 'coralbricks')?.status).toEqual({
    configured: true,
    source: 'stored',
  })
  expect(afterLogin.models.filter((model) => model.provider === 'coralbricks')).toMatchObject([
    { id: 'glm-5.3-fast', available: true },
    { id: 'deepseek-v4.1-flash-fast', available: true },
  ])
  expect(JSON.stringify(afterLogin)).not.toContain('synthetic-coralbricks-test-key')
})

it('refreshes offline and preserves the separate faux provider and model', async () => {
  const { runtime } = await modelRuntimeFixture()
  const refresh = vi.spyOn(runtime, 'refresh')
  const getAvailable = vi.spyOn(runtime, 'getAvailable')
  const faux = fauxProvider()
  const response = await listModels(runtime, faux)

  expect(refresh).toHaveBeenCalledExactlyOnceWith({ allowNetwork: false })
  expect(getAvailable).toHaveBeenCalledExactlyOnceWith()
  expect(response.providers.find((provider) => provider.id === 'faux')).toMatchObject({
    status: { configured: true },
  })
  expect(response.models.find((model) => model.provider === 'faux')).toMatchObject({
    id: 'faux-1',
    available: true,
  })
})

it('still rejects a model listing when credential availability checks fail', async () => {
  const credentials = new InMemoryCredentialStore()
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  })
  const error = new Error('Test credential store is unavailable')
  vi.spyOn(credentials, 'list').mockRejectedValue(error)

  await expect(listModels(runtime)).rejects.toBe(error)
})
