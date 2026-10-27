import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { AgentConfig, AgentInfo } from '@shared/chat'
import AgentRank, { AccountForm } from './AgentRank'
import AgentSettings from './AgentSettings'
import { chat } from './api'
import './chat.css'

const EMPTY: AgentConfig = { defaultAgentId: null, custom: [], accounts: [], rank: [], autoOff: [] }

// settings section: which agents are on this computer, the order auto tries them in, and the
// same editor the composer opens
export default function AgentsSection(): ReactNode {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null)
  const [config, setConfig] = useState<AgentConfig>(EMPTY)
  const [scanning, setScanning] = useState(false)
  const [open, setOpen] = useState(false)
  const [account, setAccount] = useState<string | null>(null)

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

  const changed = (cfg: AgentConfig): void => {
    setConfig(cfg)
    void load()
  }

  return (
    <>
      <p className="form-hint">
        Agents only run when you send a chat message. Sign in to one in a terminal and it shows up here, or add your
        own command or API.
      </p>
      {agents === null ? (
        <p className="about-line">Looking...</p>
      ) : (
        <AgentRank agents={agents} config={config} onChange={changed} onAddAccount={setAccount} />
      )}
      <div className="suggest">
        <button type="button" className="pill teal" onClick={() => setOpen(true)}>
          Add or edit agents
        </button>
        <button type="button" className="pill" disabled={scanning} onClick={() => void load(true)}>
          {scanning ? 'Checking...' : 'Check again'}
        </button>
      </div>
      {account && (
        <AccountForm
          base={account}
          agents={agents ?? []}
          config={config}
          onSaved={(cfg) => {
            setAccount(null)
            changed(cfg)
          }}
          onClose={() => setAccount(null)}
        />
      )}
      {open && (
        <AgentSettings
          agents={agents ?? []}
          config={config}
          scanning={scanning}
          onRescan={() => void load(true)}
          onChange={changed}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
