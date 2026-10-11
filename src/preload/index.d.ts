import type { TrendDeckApi } from '@shared/types'
import type { McpApi } from '@shared/mcp'

declare global {
  interface Window {
    trenddeck: TrendDeckApi
    trenddeckMcp: McpApi
  }
}

export {}
