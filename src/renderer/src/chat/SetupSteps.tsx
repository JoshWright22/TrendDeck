import type { ReactNode } from 'react'
import type { AgentInfo } from '@shared/chat'
import { safeHref } from './api'

interface Props {
  agents: AgentInfo[]
  scanning: boolean
  onRescan: () => void
  onAdd: () => void
}

// shown in place of the chat when no agent is on this computer yet
export default function SetupSteps({ agents, scanning, onRescan, onAdd }: Props): ReactNode {
  const clis = agents.filter((a) => a.kind === 'cli')
  return (
    <div className="cx-setup">
      <p className="cx-hello">Deal an agent in first</p>
      <p className="muted">
        Chat runs on an AI agent you already pay for. Install one, sign in once in a terminal, then come back and hit
        Check again.
      </p>
      <ol className="cx-setup-list">
        {clis.map((a) => {
          const href = a.url ? safeHref(a.url) : null
          return (
            <li key={a.id}>
              <span className="cx-setup-name">
                {href ? (
                  <a href={href} target="_blank" rel="noreferrer">
                    {a.name}
                  </a>
                ) : (
                  a.name
                )}
              </span>
              {a.setup && <code>{a.setup}</code>}
            </li>
          )
        })}
      </ol>
      <p className="muted small">
        Anything else works too: any command line agent, or an OpenAI-compatible API like DeepSeek, GLM, OpenRouter or a
        local Ollama model.
      </p>
      <div className="cx-setup-actions">
        <button className="pill teal" onClick={onRescan} disabled={scanning}>
          {scanning ? 'Checking...' : 'Check again'}
        </button>
        <button className="pill" onClick={onAdd}>
          Add your own
        </button>
      </div>
    </div>
  )
}
