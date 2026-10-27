import type { TrendDeckApi } from '@shared/types'
import type { McpApi } from '@shared/mcp'
import type { VaultApi } from '@shared/vault'
import type { WorkspaceBridge } from '@shared/workspace'

declare global {
  interface Window {
    trenddeck: TrendDeckApi
    trenddeckMcp: McpApi
    trenddeckVault: VaultApi
    trenddeckWorkspace: WorkspaceBridge
  }
}

export {}
