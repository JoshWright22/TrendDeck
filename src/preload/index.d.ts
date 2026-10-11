import type { TrendDeckApi } from '@shared/types'
import type { McpApi } from '@shared/mcp'
import type { VaultApi } from '@shared/vault'

declare global {
  interface Window {
    trenddeck: TrendDeckApi
    trenddeckMcp: McpApi
    trenddeckVault: VaultApi
  }
}

export {}
