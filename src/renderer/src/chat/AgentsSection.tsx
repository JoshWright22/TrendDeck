import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { AgentConfig, AgentInfo } from '@shared/chat'
import AgentSettings from './AgentSettings'
import { chat } from './api'
import './chat.css'

// settings section: which agents are on this computer, and the same editor the composer opens
export default function AgentsSection(): ReactNode {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null)
  const [config, setConfig] = useState<AgentConfig>({ defaultAgentId: null, custom: [] })
  const [scanning, setScanning] = useState(false)
  const [open, setOpen] = useState(false)

  const load = useCallback(async (rescan = false) => {
    setScanning(true)
    try {
      const [list, cfg] = await Promise.all([chat().listAgents(rescan), chat().getAgentConfig()])
      setAgents(list)
      setConfig(cfg)
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const found = (agents ?? []).filter((a) => a.installed)

  return (
    <>
      <p className="form-hint">
        Agents only run when you send a chat message. Sign in to one in a terminal and it shows up here, or add your
        own command or API.
      </p>
      <p className="about-line">
        {agents === null
          ? 'Looking...'
          : found.length === 0
            ? 'None found yet'
            : found.map((a) => a.name).join(', ')}
      </p>
      <div className="suggest">
        <button type="button" className="pill teal" onClick={() => setOpen(true)}>
          Add or edit agents
        </button>
        <button type="button" className="pill" disabled={scanning} onClick={() => void load(true)}>
          {scanning ? 'Checking...' : 'Check again'}
        </button>
      </div>
      {open && (
        <AgentSettings
          agents={agents ?? []}
          config={config}
          scanning={scanning}
          onRescan={() => void load(true)}
          onChange={(cfg) => {
            setConfig(cfg)
            void load()
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
