import type { TrendDeckApi } from '@shared/types'
import type { McpApi } from '@shared/mcp'
import type { VaultApi } from '@shared/vault'
import type { WorkspaceBridge } from '@shared/workspace'
import type { EditorBridge } from '@shared/editor/ipc'
import type { CraftApi } from '@shared/craft'

declare global {
  interface Window {
    trenddeck: TrendDeckApi
    trenddeckMcp: McpApi
    trenddeckVault: VaultApi
    trenddeckWorkspace: WorkspaceBridge
    trenddeckEditor: EditorBridge
    trenddeckCraft: CraftApi
  }
}

export {}
