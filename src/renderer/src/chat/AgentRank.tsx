import { useEffect, useState, type ReactNode } from 'react'
import type { AgentConfig, AgentInfo } from '@shared/chat'
import { ACCOUNT_ENV, accountId, baseAgentId, rankedIds } from '@shared/agents'
import Modal from '../components/Modal'
import { Dropdown, Menu } from './ui'
import { chat } from './api'

const cleanError = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const clock = (at: number): string => {
  const d = new Date(at)
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return at - Date.now() < 20 * 3_600_000 ? time : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`
}

// how it stands, in words
export function agentStatus(a: AgentInfo): string {
  if (!a.installed) return 'Not found'
  if (a.held) {
    const back = a.held.until ? `, back at ${clock(a.held.until)}` : ''
    if (a.held.why === 'rate_limit') return `Rate limited${back}`
    if (a.held.why === 'auth') return 'Sign in failed. Sign in, then check again'
    return `At its limit${back}`
  }
  if (a.signedIn === false) return 'Signed out'
  if (a.signedIn === true) return 'Signed in'
  return 'Ready'
}

const canSignIn = (a: AgentInfo): boolean => a.installed && baseAgentId(a.id) in ACCOUNT_ENV

function Arrow({ down }: { down?: boolean }): ReactNode {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d={down ? 'M3 4.5l3 3 3-3' : 'M3 7.5l3-3 3 3'} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

interface Props {
  agents: AgentInfo[]
  config: AgentConfig
  onChange: (config: AgentConfig) => void
  onAddAccount: (base: string) => void
}

// the order auto tries agents in, which ones it may use, and the extra accounts
export default function AgentRank({ agents, config, onChange, onAddAccount }: Props): ReactNode {
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const installed = agents.filter((a) => a.installed)
  const byId = new Map(installed.map((a) => [a.id, a]))
  const order = rankedIds(
    installed.map((a) => a.id),
    config.rank
  )
  const missing = agents.filter((a) => !a.installed && a.kind === 'cli' && !a.base)
  const bases = installed.filter((a) => a.kind === 'cli' && !a.base && a.id in ACCOUNT_ENV)

  const save = (rank: string[], autoOff: string[]): void => {
    setError('')
    void chat()
      .setRank(rank, autoOff)
      .then(onChange)
      .catch((err) => setError(cleanError(err)))
  }

  const move = (i: number, step: number): void => {
    const next = [...order]
    const j = i + step
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    save(next, config.autoOff)
  }

  const toggle = (id: string): void => {
    const off = config.autoOff.includes(id) ? config.autoOff.filter((x) => x !== id) : [...config.autoOff, id]
    save(order, off)
  }

  const signIn = (a: AgentInfo): void => {
    setError('')
    void chat()
      .signIn(a.id)
      .then(() => setNotice(`Sign in to ${a.name} in the window that opened, then click Check again.`))
      .catch((err) => setError(cleanError(err)))
  }

  const remove = (a: AgentInfo): void => {
    setError('')
    void chat()
      .removeAccount(a.id)
      .then(onChange)
      .catch((err) => setError(cleanError(err)))
  }

  return (
    <div className="cx-rank">
      <p className="form-hint">
        Auto answers with the first one here that's free, and moves down the list when one is rate limited, out of usage or
        signed out.
      </p>
      <ol className="cx-agent-list cx-rank-list" aria-label="Order Auto tries agents in">
        {order.map((id, i) => {
          const a = byId.get(id)!
          const on = !config.autoOff.includes(id)
          const status = agentStatus(a)
          return (
            <li key={id} className={on ? '' : 'off'}>
              <span className="cx-rank-n">{i + 1}</span>
              <span className="cx-agent-name">{a.name}</span>
              <span className="muted small cx-agent-detail" title={a.folder ?? a.detail}>
                {status}
              </span>
              {canSignIn(a) && (a.signedIn !== true || a.held?.why === 'auth') && (
                <button type="button" className="cx-rank-btn" onClick={() => signIn(a)}>
                  Sign in
                </button>
              )}
              <button
                type="button"
                className={`cx-rank-btn${on ? ' on' : ''}`}
                aria-pressed={on}
                title={on ? 'Auto may use this one, click to leave it out' : 'Auto leaves this one out, click to use it'}
                onClick={() => toggle(id)}
              >
                {on ? 'Used by Auto' : 'Not used'}
              </button>
              <button type="button" className="cx-rank-btn icon" aria-label={`Move ${a.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                <Arrow />
              </button>
              <button
                type="button"
                className="cx-rank-btn icon"
                aria-label={`Move ${a.name} down`}
                disabled={i === order.length - 1}
                onClick={() => move(i, 1)}
              >
                <Arrow down />
              </button>
              {a.base && (
                <Menu
                  label={`More for ${a.name}`}
                  className="cx-rank-more"
                  items={[
                    ...(canSignIn(a) ? [{ label: 'Sign in again', onSelect: () => signIn(a) }] : []),
                    { label: 'Remove this account', onSelect: () => remove(a), danger: true }
                  ]}
                />
              )}
            </li>
          )
        })}
      </ol>
      {!order.length && <p className="form-hint">No agents found yet.</p>}
      {notice && <p className="form-hint">{notice}</p>}
      {error && <p className="form-error">{error}</p>}
      {bases.length > 0 && (
        <Menu
          label="Add another account"
          className="cx-rank-add"
          align="left"
          trigger={<span>Add another account</span>}
          items={bases.map((b) => ({ label: b.name, onSelect: () => onAddAccount(b.id) }))}
        />
      )}
      {missing.length > 0 && <p className="form-hint">Not found on this computer: {missing.map((a) => a.name).join(', ')}.</p>}
    </div>
  )
}

interface FormProps {
  base: string
  agents: AgentInfo[]
  config: AgentConfig
  onSaved: (config: AgentConfig) => void
  onClose: () => void
}

// another sign in for claude code or codex, kept in its own folder
export function AccountForm({ base, agents, config, onSaved, onClose }: FormProps): ReactNode {
  const baseName = agents.find((a) => a.id === base)?.name ?? base
  const count = config.accounts.filter((a) => baseAgentId(a.id) === base).length
  const [name, setName] = useState(`${baseName} ${count + 2}`)
  const [folders, setFolders] = useState<{ found: string[]; fresh: string } | null>(null)
  const [picked, setPicked] = useState('')
  const [folder, setFolder] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    void chat()
      .accountFolders(base)
      .then((f) => {
        if (!alive) return
        setFolders(f)
        setFolder((cur) => cur || f.found[0] || f.fresh)
      })
    return () => {
      alive = false
    }
  }, [base])

  const options = [
    ...(folders?.found ?? []).map((f) => ({ value: f, label: f, hint: 'Already on this computer' })),
    ...(folders?.fresh ? [{ value: folders.fresh, label: folders.fresh, hint: 'A new, empty folder' }] : []),
    ...(picked && !folders?.found.includes(picked) && picked !== folders?.fresh ? [{ value: picked, label: picked }] : [])
  ]

  const choose = async (): Promise<void> => {
    const path = await chat().pickFolder()
    if (!path) return
    setPicked(path)
    setFolder(path)
  }

  const save = async (): Promise<void> => {
    if (!folder) return
    setSaving(true)
    setError('')
    try {
      const label = name.trim() || `${baseName} ${count + 2}`
      const taken = [...agents.map((a) => a.id), ...config.accounts.map((a) => a.id)]
      onSaved(await chat().saveAccount({ id: accountId(base, label, taken), name: label, folder }))
    } catch (err) {
      setError(cleanError(err))
      setSaving(false)
    }
  }

  return (
    <Modal title={`Add another ${baseName} account`} onClose={onClose}>
      <form
        className="cx-agent-form"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <label>
          Name
          <input value={name} maxLength={40} autoFocus onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="cx-account-folder">
          <span>Folder</span>
          <Dropdown
            label="Folder"
            title="Where this account keeps its sign in"
            value={folder}
            options={options.length ? options : [{ value: '', label: 'Looking...' }]}
            onChange={setFolder}
            actions={[{ label: 'Choose a folder...', onSelect: () => void choose() }]}
          />
        </div>
        <p className="form-hint">
          Each account keeps its sign in in its own folder ({ACCOUNT_ENV[base]}). After saving, click Sign in and log in
          with that account in the window that opens. TrendDeck never reads what's in the folder.
        </p>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!folder || saving}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  )
}
