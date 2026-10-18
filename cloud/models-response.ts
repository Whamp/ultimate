import type { ModelsResponse } from '../shared/protocol.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProvider(value: unknown): value is ModelsResponse['providers'][number] {
  if (!isRecord(value) || !isRecord(value.status) || !Array.isArray(value.authTypes)) return false
  const source = value.status.source
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.isUsingSubscription === 'boolean' &&
    typeof value.status.configured === 'boolean' &&
    (source === undefined ||
      source === 'stored' ||
      source === 'runtime' ||
      source === 'environment' ||
      source === 'fallback' ||
      source === 'models_json_key' ||
      source === 'models_json_command') &&
    (value.status.label === undefined || typeof value.status.label === 'string') &&
    value.authTypes.every(
      (auth: unknown) =>
        isRecord(auth) &&
        (auth.type === 'api_key' || auth.type === 'oauth') &&
        typeof auth.name === 'string',
    )
  )
}

function isModel(value: unknown): value is ModelsResponse['models'][number] {
  if (!isRecord(value) || !isRecord(value.cost) || !Array.isArray(value.thinkingLevels))
    return false
  return (
    typeof value.provider === 'string' &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.contextWindow === 'number' &&
    Number.isFinite(value.contextWindow) &&
    typeof value.maxTokens === 'number' &&
    Number.isFinite(value.maxTokens) &&
    typeof value.reasoning === 'boolean' &&
    typeof value.available === 'boolean' &&
    value.thinkingLevels.every(
      (level: unknown) =>
        level === 'off' ||
        level === 'minimal' ||
        level === 'low' ||
        level === 'medium' ||
        level === 'high' ||
        level === 'xhigh' ||
        level === 'max',
    ) &&
    typeof value.cost.input === 'number' &&
    Number.isFinite(value.cost.input) &&
    typeof value.cost.output === 'number' &&
    Number.isFinite(value.cost.output) &&
    typeof value.cost.cacheRead === 'number' &&
    Number.isFinite(value.cost.cacheRead) &&
    typeof value.cost.cacheWrite === 'number' &&
    Number.isFinite(value.cost.cacheWrite)
  )
}

/** Validate external or persisted models before they enter the replica's shared response contract. */
export function parseModelsResponse(value: unknown): ModelsResponse {
  if (
    !isRecord(value) ||
    !Array.isArray(value.providers) ||
    !value.providers.every(isProvider) ||
    !Array.isArray(value.models) ||
    !value.models.every(isModel)
  ) {
    throw new Error('Invalid cloud models response')
  }
  return { providers: value.providers, models: value.models }
}
