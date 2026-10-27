import type { ProviderInfo } from '@shared/providers'
import { claudeAdapter } from './claude'
import { codexAdapter } from './codex/adapter'
import { legacyAdapter, legacyKind } from './legacy'
import type { ProviderAdapter } from './types'

// first adapter that takes the agent id wins, legacy takes whatever is left.
// pi-ai.ts is a stub and isn't listed on purpose
const ADAPTERS: ProviderAdapter[] = [claudeAdapter, codexAdapter, legacyAdapter]

// agents whose own adapter couldn't run here (e.g. a codex too old for app-server), until restart
const unavailable = new Set<string>()

export function markUnavailable(agentId: string): void {
  unavailable.add(agentId)
}

export function adapterFor(agentId: string): ProviderAdapter {
  if (unavailable.has(agentId)) return legacyAdapter
  return ADAPTERS.find((a) => a.handles(agentId)) ?? legacyAdapter
}

// used when an adapter throws ProviderUnavailable
export const fallbackAdapter = legacyAdapter

export async function providerInfo(agentId: string): Promise<ProviderInfo> {
  const a = adapterFor(agentId)
  return { agentId, kind: a === legacyAdapter ? await legacyKind(agentId) : a.kind, capabilities: a.capabilities }
}
