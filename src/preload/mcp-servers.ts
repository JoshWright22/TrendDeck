import { ipcRenderer } from 'electron'
import type { McpServersApi } from '@shared/mcp-servers'

// your own MCP servers' half of the preload, exposed as window.trenddeckMcpServers. main keeps
// the secrets and runs the servers, this only asks and listens
export const mcpServersApi: McpServersApi = {
  list: (brandId) => ipcRenderer.invoke('mcp-servers:list', brandId),
  save: (input) => ipcRenderer.invoke('mcp-servers:save', input),
  remove: (id) => ipcRenderer.invoke('mcp-servers:remove', id),
  setEnabled: (id, brandId, on) => ipcRenderer.invoke('mcp-servers:set-enabled', id, brandId, on),
  setTrusted: (id, on) => ipcRenderer.invoke('mcp-servers:set-trusted', id, on),
  test: (id) => ipcRenderer.invoke('mcp-servers:test', id),
  presets: (brandId) => ipcRenderer.invoke('mcp-servers:presets', brandId),
  onChanged: (fn) => {
    const listener = (): void => fn()
    ipcRenderer.on('mcp-servers:changed', listener)
    return () => ipcRenderer.removeListener('mcp-servers:changed', listener)
  }
}
