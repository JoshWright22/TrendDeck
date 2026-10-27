import { useState, type ReactNode } from 'react'
import type { AgentConfig, AgentInfo, CustomAgent, CustomAgentInput } from '@shared/chat'
import Modal from '../components/Modal'
import AgentRank, { AccountForm } from './AgentRank'
import { chat } from './api'

interface Props {
  agents: AgentInfo[]
  config: AgentConfig
  scanning: boolean
  onRescan: () => void
  onChange: (config: AgentConfig) => void
  onClose: () => void
}

const PRESETS: { name: string; baseUrl: string; model: string }[] = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
  { name: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' }
]

function blank(): CustomAgentInput {
  return { id: `custom-${crypto.randomUUID().slice(0, 18)}`, name: '', kind: 'api', command: '', baseUrl: '', model: '', apiKey: '' }
}

function fromAgent(a: CustomAgent): CustomAgentInput {
  const { hasKey: _hasKey, ...rest } = a
  return { ...rest, apiKey: '' }
}

const cleanError = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

// the agents list plus the form for custom ones. kept in the chat so the settings modal stays small
export default function AgentSettings({ agents, config, scanning, onRescan, onChange, onClose }: Props): ReactNode {
  const [form, setForm] = useState<CustomAgentInput | null>(null)
  const [hasKey, setHasKey] = useState(false)
  const [error, setError] = useState('')
  // the cli an account is being added for
  const [account, setAccount] = useState<string | null>(null)

  const set = (patch: Partial<CustomAgentInput>): void => setForm((f) => (f ? { ...f, ...patch } : f))

  const save = async (): Promise<void> => {
    if (!form) return
    setError('')
    try {
      const cfg = await chat().saveCustomAgent({ ...form, name: form.name.trim() || (form.kind === 'api' ? 'API agent' : 'Command agent') })
      onChange(cfg)
      setForm(null)
    } catch (err) {
      setError(cleanError(err))
    }
  }

  if (account) {
    return (
      <AccountForm
        base={account}
        agents={agents}
        config={config}
        onSaved={(cfg) => {
          setAccount(null)
          onChange(cfg)
        }}
        onClose={() => setAccount(null)}
      />
    )
  }

  if (form) {
    return (
      <Modal title={config.custom.some((c) => c.id === form.id) ? 'Edit agent' : 'Add an agent'} onClose={() => setForm(null)}>
        <form
          className="cx-agent-form"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <div className="cx-seg" role="radiogroup" aria-label="Agent type">
            <button type="button" className={form.kind === 'api' ? 'on' : ''} onClick={() => set({ kind: 'api' })}>
              API
            </button>
            <button type="button" className={form.kind === 'command' ? 'on' : ''} onClick={() => set({ kind: 'command' })}>
              Command
            </button>
          </div>
          <label>
            Name
            <input value={form.name} maxLength={40} placeholder="e.g. DeepSeek" onChange={(e) => set({ name: e.target.value })} />
          </label>
          {form.kind === 'api' ? (
            <>
              <div className="cx-presets">
                {PRESETS.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    className="filter-chip"
                    onClick={() => set({ name: form.name || p.name, baseUrl: p.baseUrl, model: p.model || form.model })}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
              <label>
                API URL
                <input
                  value={form.baseUrl}
                  spellCheck={false}
                  placeholder="https://api.example.com/v1"
                  onChange={(e) => set({ baseUrl: e.target.value })}
                />
              </label>
              <label>
                Model
                <input value={form.model} spellCheck={false} placeholder="model name" onChange={(e) => set({ model: e.target.value })} />
              </label>
              <label>
                API key
                <input
                  value={form.apiKey}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={hasKey ? 'Saved, type to replace it' : 'Leave empty for local models'}
                  onChange={(e) => set({ apiKey: e.target.value })}
                />
              </label>
              <p className="form-hint">
                Any OpenAI-compatible endpoint. The key is encrypted on this computer and only sent to that URL.
              </p>
            </>
          ) : (
            <>
              <label>
                Command
                <input
                  value={form.command}
                  spellCheck={false}
                  placeholder='mytool --print "{prompt}"'
                  onChange={(e) => set({ command: e.target.value })}
                />
              </label>
              <p className="form-hint">
                Runs with no shell. {'{prompt}'} gets swapped for the message and brand info, without it the prompt goes
                in on stdin. Whatever it prints is the reply.
              </p>
            </>
          )}
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            {hasKey && form.kind === 'api' && (
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  set({ clearKey: true, apiKey: '' })
                  setHasKey(false)
                }}
              >
                Forget key
              </button>
            )}
            <span className="spacer" />
            <button type="button" className="btn ghost" onClick={() => setForm(null)}>
              Cancel
            </button>
            <button type="submit" className="btn primary">
              Save
            </button>
          </div>
        </form>
      </Modal>
    )
  }

  return (
    <Modal title="Agents" onClose={onClose}>
      <AgentRank agents={agents} config={config} onChange={onChange} onAddAccount={setAccount} />
      <div className="cx-agent-sub">
        <span>Your own</span>
        <span className="spacer" />
        <button
          className="pill teal"
          onClick={() => {
            setError('')
            setHasKey(false)
            setForm(blank())
          }}
        >
          Add agent
        </button>
      </div>
      {config.custom.length === 0 ? (
        <p className="form-hint">Any command, or an OpenAI-compatible API URL and key.</p>
      ) : (
        <ul className="cx-agent-list">
          {config.custom.map((a) => (
            <li key={a.id}>
              <span className="cx-dot on" />
              <span className="cx-agent-name">{a.name}</span>
              <span className="muted small cx-agent-detail">{a.kind === 'api' ? a.baseUrl : a.command}</span>
              <button
                className="pill"
                onClick={() => {
                  setError('')
                  setHasKey(a.hasKey)
                  setForm(fromAgent(a))
                }}
              >
                Edit
              </button>
              <button className="pill" onClick={() => void chat().removeCustomAgent(a.id).then(onChange)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onRescan} disabled={scanning}>
          {scanning ? 'Checking...' : 'Check again'}
        </button>
        <span className="spacer" />
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  )
}
