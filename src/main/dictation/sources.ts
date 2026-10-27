import { STT_PROVIDERS, type SttProvider } from './providers'
import type { SttProviderInfo } from '../../shared/dictation'
import { isLoopbackEndpoint, type LegacyApi } from './validation'

// the transcription providers main can route to (cloud APIs and servers on this computer) and the
// metadata the page may see about them. this file holds no secrets

export function allProviders(): readonly SttProvider[] {
  return STT_PROVIDERS
}

export function findProvider(id: unknown): SttProvider | undefined {
  return STT_PROVIDERS.find((p) => p.id === id)
}

export function providerInfo(p: SttProvider): SttProviderInfo {
  return {
    id: p.id,
    label: p.label,
    kind: p.kind,
    fields: p.fields.map((f) => ({ key: f.key, label: f.label, secret: f.secret, required: f.required, placeholder: f.placeholder ?? f.defaultValue, kind: f.kind, options: f.options })),
    defaultModel: p.defaultModel,
    staticModels: p.staticModels,
    canListModels: typeof p.listModels === 'function',
    canTest: typeof p.test === 'function',
    supportsWordTimestamps: p.supportsWordTimestamps,
    supportsStreaming: p.supportsStreaming,
    unavailable: p.unavailable
  }
}

// the old single API config as a configured provider: OpenAI itself, a server on this computer,
// or any OpenAI-compatible API. returns the provider and how its fields map
export function legacyProvider(legacy: LegacyApi): { provider: SttProvider; values: Record<string, string>; keyField: string | null } {
  let host = ''
  try {
    host = new URL(legacy.baseUrl).hostname
  } catch {
    // validated before
  }
  const id = host === 'api.openai.com' ? 'openai' : isLoopbackEndpoint(legacy.baseUrl) ? 'local-openai-compatible' : 'openai-compatible'
  const provider = findProvider(id)!
  const values: Record<string, string> = {}
  if (provider.fields.some((f) => f.key === 'baseUrl')) values.baseUrl = legacy.baseUrl
  return { provider, values, keyField: provider.fields.some((f) => f.key === 'apiKey') ? 'apiKey' : null }
}
