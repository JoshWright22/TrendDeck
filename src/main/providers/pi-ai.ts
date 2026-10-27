import type { ModelOption } from '@shared/chat'
import type { ProviderCapabilities } from '@shared/providers'
import type { ProviderAdapter, ProviderHealth, ProviderSession, SessionStart } from './types'

// ---------------------------------------------------------------------------------------
// STUB, NOT WIRED. registry.ts doesn't list it, so nothing routes here.
//
// placeholder for a pi-ai based adapter (many api providers and subscriptions behind one
// client). the provider code is meant to be ported in by hand later; nothing has been
// copied from anywhere into this file. to finish it:
//   1. pick the agent ids it owns in handles(), e.g. "pi-<provider>"
//   2. health(): read stored credentials only, never start an oauth flow from here
//   3. listModels(): ask the provider's model list, fall back to a static list
//   4. startSession(): stream text/thinking/tool events through start.emit as ProviderEvents,
//      ask for approvals with an approval-request event and wait on respondToApproval,
//      end every turn by resolving sendTurn (the chat sends turn-end itself)
//   5. add it to ADAPTERS in registry.ts, before legacyAdapter
// keys stay in the main process (agents/config.ts seals them), never in prompts or events
// ---------------------------------------------------------------------------------------

const capabilities: ProviderCapabilities = {
  steer: false,
  approvals: false,
  userInput: false,
  resume: false,
  interrupt: false,
  liveModels: false,
  permissionModes: false
}

export const piAiAdapter: ProviderAdapter = {
  kind: 'pi-ai',
  capabilities,
  handles: () => false,
  async health(): Promise<ProviderHealth> {
    return { installed: false, detail: '', signedIn: null, note: 'Not built yet' }
  },
  async listModels(): Promise<ModelOption[]> {
    return [{ id: '', label: 'Model' }]
  },
  async startSession(_start: SessionStart): Promise<ProviderSession> {
    throw new Error('The pi-ai adapter is a stub and is not wired up yet')
  }
}
