import type { ModelsResponse } from '../../shared/protocol.ts'

/** A complete synthetic catalog with auth status and costs, serialized in replica boundary tests. */
export function cloudModelsFixture(): ModelsResponse {
  return {
    providers: [
      {
        id: 'test',
        name: 'Test',
        authTypes: [{ type: 'oauth', name: 'Test login' }],
        status: { configured: true, source: 'stored', label: 'Test account' },
        isUsingSubscription: true,
      },
    ],
    models: [
      {
        provider: 'test',
        id: 'updated',
        name: 'Updated',
        contextWindow: 100,
        maxTokens: 10,
        reasoning: false,
        thinkingLevels: ['off'],
        available: true,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  }
}
