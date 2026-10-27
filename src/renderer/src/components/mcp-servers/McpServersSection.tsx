import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Brand } from '@shared/types'
import {
  looksSecret,
  MCP_SERVER_NAME,
  type McpPairInput,
  type McpPairView,
  type McpServerInput,
  type McpServerKind,
  type McpServerPreset,
  type McpServerStatus,
  type McpServerView
} from '@shared/mcp-servers'
import { CloseIcon, PlusIcon } from '../Icons'
import './mcp-servers.css'

// settings section: your own MCP servers. their tools show up for chat agents as <server>_<tool>.
// secret values go to main once and only ever come back as "saved, hidden"

interface PairDraft {
  rid: string
  key: string
  value: string
  secret: boolean
  // you ticked or unticked secret yourself, the key no longer decides it
  touched: boolean
  // a secret main already has. its value isn't here
  saved: boolean
  set: boolean
  replace: boolean
  clear: boolean
}

interface Draft {
  id: string
  create: boolean
  label: string
  kind: McpServerKind
  command: string
  argsText: string
  cwd: string
  env: PairDraft[]
  url: string
  headers: PairDraft[]
}

const rid = (): string => crypto.randomUUID()

function pairFromView(p: McpPairView): PairDraft {
  return p.secret
    ? { rid: rid(), key: p.key, value: '', secret: true, touched: true, saved: true, set: p.set, replace: false, clear: false }
    : { rid: rid(), key: p.key, value: p.value, secret: false, touched: true, saved: false, set: false, replace: false, clear: false }
}

function pairFromInput(p: McpPairInput): PairDraft {
  return { rid: rid(), key: p.key, value: p.value, secret: p.secret, touched: true, saved: false, set: false, replace: false, clear: false }
}

const blankPair = (): PairDraft => ({ rid: rid(), key: '', value: '', secret: false, touched: false, saved: false, set: false, replace: false, clear: false })

function fromView(v: McpServerView): Draft {
  return {
    id: v.id,
    create: false,
    label: v.label,
    kind: v.kind,
    command: v.command,
    argsText: v.args.join('\n'),
    cwd: v.cwd,
    env: v.env.map(pairFromView),
    url: v.url,
    headers: v.headers.map(pairFromView)
  }
}

function fromPreset(p: McpServerPreset): Draft {
  return {
    id: p.name,
    create: true,
    label: p.label,
    kind: p.kind,
    command: p.command,
    argsText: p.args.join('\n'),
    cwd: '',
    env: p.env.map(pairFromInput),
    url: p.url,
    headers: p.headers.map(pairFromInput)
  }
}

const blank = (): Draft => ({
  id: '',
  create: true,
  label: '',
  kind: 'stdio',
  command: '',
  argsText: '',
  cwd: '',
  env: [],
  url: '',
  headers: []
})

function pairInput(p: PairDraft): McpPairInput {
  if (p.saved && !p.replace) return { key: p.key, value: '', secret: true, clear: p.clear }
  return { key: p.key.trim(), value: p.value, secret: p.secret }
}

function toInput(d: Draft, brandId: string): McpServerInput {
  return {
    id: d.id,
    create: d.create,
    label: d.label.trim(),
    kind: d.kind,
    command: d.command.trim(),
    args: d.argsText
      .split(/\r?\n/)
      .map((a) => a.trim())
      .filter(Boolean),
    cwd: d.cwd.trim(),
    env: d.kind === 'stdio' ? d.env.map(pairInput) : [],
    url: d.url.trim(),
    headers: d.kind === 'http' ? d.headers.map(pairInput) : [],
    brandId
  }
}

function statusWords(kind: McpServerKind, s: McpServerStatus): string {
  if (s === 'connecting') return kind === 'stdio' ? 'Starting...' : 'Connecting...'
  if (s === 'ready') return kind === 'stdio' ? 'Running' : 'Connected'
  if (s === 'error') return kind === 'stdio' ? "Couldn't start" : "Couldn't connect"
  return kind === 'stdio' ? 'Not running' : 'Not connected'
}

function howWords(v: McpServerView): string {
  if (v.kind === 'http') {
    try {
      return new URL(v.url).host
    } catch {
      return v.url
    }
  }
  return [v.command, ...v.args].join(' ')
}

function PairRows({
  rows,
  kind,
  onChange
}: {
  rows: PairDraft[]
  kind: 'env' | 'header'
  onChange: (rows: PairDraft[]) => void
}): ReactNode {
  const set = (id: string, patch: Partial<PairDraft>): void => onChange(rows.map((r) => (r.rid === id ? { ...r, ...patch } : r)))
  const noun = kind === 'env' ? 'variable' : 'header'
  return (
    <div className="mcp-pairs">
      {rows.map((r) => (
        <div key={r.rid} className="mcp-pair">
          {r.saved ? (
            <>
              <span className="mcp-pair-key">{r.key}</span>
              {r.replace ? (
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={r.value}
                  placeholder="New value"
                  aria-label={`New value for ${r.key}`}
                  onChange={(e) => set(r.rid, { value: e.target.value })}
                />
              ) : (
                <span className="mcp-pair-hidden muted">{r.clear ? 'cleared when you save' : r.set ? 'saved, hidden' : 'not set'}</span>
              )}
              {r.replace ? (
                <button type="button" className="btn ghost" onClick={() => set(r.rid, { replace: false, value: '' })}>
                  Keep old
                </button>
              ) : (
                <button type="button" className="btn ghost" onClick={() => set(r.rid, { replace: true, clear: false })}>
                  {r.set ? 'Replace' : 'Set'}
                </button>
              )}
              {r.set && !r.replace && (
                <button type="button" className="btn ghost" onClick={() => set(r.rid, { clear: !r.clear })}>
                  {r.clear ? 'Undo' : 'Clear'}
                </button>
              )}
            </>
          ) : (
            <>
              <input
                className="mcp-pair-key-input"
                value={r.key}
                spellCheck={false}
                placeholder={kind === 'env' ? 'NAME' : 'Header-Name'}
                aria-label={`${noun} name`}
                onChange={(e) => {
                  const key = e.target.value
                  set(r.rid, r.touched ? { key } : { key, secret: looksSecret(key) })
                }}
              />
              <input
                type={r.secret ? 'password' : 'text'}
                autoComplete="off"
                spellCheck={false}
                value={r.value}
                placeholder="Value"
                aria-label={`Value for ${r.key || noun}`}
                onChange={(e) => set(r.rid, { value: e.target.value })}
              />
              <label className="toggle-row mcp-secret">
                <input type="checkbox" checked={r.secret} onChange={(e) => set(r.rid, { secret: e.target.checked, touched: true })} />
                <span>Secret</span>
              </label>
            </>
          )}
          <button
            type="button"
            className="row-close"
            title={`Remove ${r.key || noun}`}
            aria-label={`Remove ${r.key || noun}`}
            onClick={() => onChange(rows.filter((x) => x.rid !== r.rid))}
          >
            <CloseIcon />
          </button>
        </div>
      ))}
      <button type="button" className="btn ghost mcp-add-row" onClick={() => onChange([...rows, blankPair()])}>
        Add {kind === 'env' ? 'a variable' : 'a header'}
      </button>
    </div>
  )
}

function ServerForm({
  draft,
  brand,
  onChange,
  onDone
}: {
  draft: Draft
  brand: Brand
  onChange: (d: Draft) => void
  onDone: () => void
}): ReactNode {
  const api = window.trenddeckMcpServers
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<Draft>): void => onChange({ ...draft, ...patch })

  const save = async (): Promise<void> => {
    if (draft.create && !MCP_SERVER_NAME.test(draft.id)) {
      setError('The name can only use a to z and 0 to 9, start with a letter and be up to 20 long.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const r = await api.save(toInput(draft, brand.id))
      if (r.ok) onDone()
      else setError(r.error)
    } catch {
      setError("That server couldn't be saved.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="mcp-form"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <div className="mcp-seg" role="radiogroup" aria-label="How TrendDeck reaches the server">
        <button type="button" role="radio" aria-checked={draft.kind === 'stdio'} className={draft.kind === 'stdio' ? 'on' : ''} onClick={() => set({ kind: 'stdio' })}>
          Runs on this computer
        </button>
        <button type="button" role="radio" aria-checked={draft.kind === 'http'} className={draft.kind === 'http' ? 'on' : ''} onClick={() => set({ kind: 'http' })}>
          Web address
        </button>
      </div>
      <div className="mcp-two">
        <label>
          Name
          <input
            value={draft.id}
            maxLength={20}
            disabled={!draft.create}
            spellCheck={false}
            placeholder="files"
            onChange={(e) => set({ id: e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '') })}
          />
        </label>
        <label>
          Label
          <input value={draft.label} maxLength={40} placeholder="Project files" onChange={(e) => set({ label: e.target.value })} />
        </label>
      </div>
      <p className="form-hint">
        {draft.create
          ? `Agents see its tools as ${draft.id || 'name'}_tool. Lowercase letters and numbers, can't be changed later.`
          : `Agents see its tools as ${draft.id}_tool.`}
      </p>
      {draft.kind === 'stdio' ? (
        <>
          <label>
            Command
            <input value={draft.command} spellCheck={false} placeholder="npx" onChange={(e) => set({ command: e.target.value })} />
          </label>
          <label>
            Arguments, one per line
            <textarea
              className="mcp-args"
              rows={Math.min(8, Math.max(3, draft.argsText.split('\n').length + 1))}
              spellCheck={false}
              value={draft.argsText}
              placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\Users\\you\\folder'}
              onChange={(e) => set({ argsText: e.target.value })}
            />
          </label>
          <label>
            Folder to run in (optional)
            <input value={draft.cwd} spellCheck={false} placeholder="C:\Users\you\folder" onChange={(e) => set({ cwd: e.target.value })} />
          </label>
          <div className="mcp-sub">Environment variables</div>
          <PairRows rows={draft.env} kind="env" onChange={(env) => set({ env })} />
        </>
      ) : (
        <>
          <label>
            Server address
            <input value={draft.url} spellCheck={false} placeholder="https://example.com/mcp" onChange={(e) => set({ url: e.target.value })} />
          </label>
          <div className="mcp-sub">Headers</div>
          <PairRows rows={draft.headers} kind="header" onChange={(headers) => set({ headers })} />
        </>
      )}
      <p className="form-hint mcp-form-hint">
        Secret values are locked with your system keychain. After you save, they can only be replaced, never shown, and
        agents never get them.
      </p>
      {error && <p className="form-error">{error}</p>}
      <div className="row-actions">
        <button type="submit" className="btn primary" disabled={saving}>
          {saving ? 'Saving...' : draft.create ? `Add for ${brand.name}` : 'Save'}
        </button>
        <button type="button" className="btn ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function ServerRow({ s, brand, onEdit }: { s: McpServerView; brand: Brand; onEdit: () => void }): ReactNode {
  const api = window.trenddeckMcpServers
  const [confirm, setConfirm] = useState(false)
  const [testing, setTesting] = useState(false)
  const [note, setNote] = useState('')
  const others = s.brandCount - (s.enabled ? 1 : 0)

  const test = async (): Promise<void> => {
    setTesting(true)
    setNote('')
    try {
      const r = await api.test(s.id)
      setNote(r.ok ? `Works. ${r.tools === 1 ? 'Found 1 tool.' : `Found ${r.tools} tools.`}` : '')
    } finally {
      setTesting(false)
    }
  }

  return (
    <li className="mcp-server">
      <div className="mcp-head">
        <span className="mcp-label">{s.label}</span>
        <span className="settings-host" title={howWords(s)}>
          {s.id}, {howWords(s)}
        </span>
        <span className="mcp-status">{statusWords(s.kind, s.status)}</span>
      </div>
      <div className="mcp-toggles">
        <label className="toggle-row">
          <input type="checkbox" checked={s.enabled} onChange={(e) => void api.setEnabled(s.id, brand.id, e.target.checked)} />
          <span>On for {brand.name}</span>
        </label>
        <label className="toggle-row">
          <input type="checkbox" checked={!s.trusted} onChange={(e) => void api.setTrusted(s.id, !e.target.checked)} />
          <span>Ask before every call</span>
        </label>
      </div>
      {others > 0 && <p className="mcp-line muted">Also on for {others === 1 ? '1 other brand' : `${others} other brands`}.</p>}
      {s.status === 'error' && s.error && <p className="form-error mcp-line">{s.error}</p>}
      {note && s.status !== 'error' && <p className="mcp-line muted">{note}</p>}
      <p className="mcp-line muted mcp-tools">
        {s.tools.length
          ? `${s.tools.length === 1 ? '1 tool' : `${s.tools.length} tools`}: ${s.tools.map((t) => t.name).join(', ')}`
          : 'No tools read yet. Test the connection to see them.'}
      </p>
      {confirm ? (
        <div className="row-actions">
          <button type="button" className="btn danger" onClick={() => void api.remove(s.id)}>
            Remove {s.label}
          </button>
          <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>
            Keep it
          </button>
        </div>
      ) : (
        <div className="row-actions">
          <button type="button" className="btn ghost" disabled={testing || s.status === 'connecting'} onClick={() => void test()}>
            {testing ? 'Testing...' : 'Test connection'}
          </button>
          <button type="button" className="btn ghost" onClick={onEdit}>
            Edit
          </button>
          <button type="button" className="btn ghost" onClick={() => setConfirm(true)}>
            Remove
          </button>
        </div>
      )}
    </li>
  )
}

export default function McpServersSection({ brand }: { brand: Brand }): ReactNode {
  const api = window.trenddeckMcpServers
  const [servers, setServers] = useState<McpServerView[] | null>(null)
  const [presets, setPresets] = useState<McpServerPreset[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)

  const load = useCallback(async () => {
    const [list, pre] = await Promise.all([api.list(brand.id), api.presets(brand.id)])
    setServers(list)
    setPresets(pre)
  }, [api, brand.id])

  useEffect(() => {
    let alive = true
    const run = (): void => {
      void load().catch(() => alive && setServers((s) => s ?? []))
    }
    run()
    const off = api.onChanged(() => alive && run())
    return () => {
      alive = false
      off()
    }
  }, [api, load])

  useEffect(() => setDraft(null), [brand.id])

  const editing = draft && !draft.create ? draft.id : null

  return (
    <div className="mcp-servers">
      <p className="form-hint">
        Add your own MCP servers and agents in chat can use their tools. Each one is only on for the brands you turn it
        on for, and TrendDeck asks before every call until you trust it.
      </p>
      {servers && servers.length > 0 && (
        <ul className="settings-sites mcp-list">
          {servers.map((s) =>
            editing === s.id && draft ? (
              <li key={s.id} className="mcp-server">
                <ServerForm draft={draft} brand={brand} onChange={setDraft} onDone={() => setDraft(null)} />
              </li>
            ) : (
              <ServerRow key={s.id} s={s} brand={brand} onEdit={() => setDraft(fromView(s))} />
            )
          )}
        </ul>
      )}
      {servers && servers.length === 0 && !draft && <p className="about-line muted">No servers yet.</p>}
      {draft?.create ? (
        <ServerForm draft={draft} brand={brand} onChange={setDraft} onDone={() => setDraft(null)} />
      ) : (
        <div className="suggest">
          <button type="button" className="pill teal" onClick={() => setDraft(blank())}>
            <PlusIcon />
            Add server
          </button>
        </div>
      )}
      {presets.length > 0 && !draft?.create && (
        <>
          <div className="mcp-sub">Suggested servers</div>
          <ul className="mcp-presets">
            {presets.map((p) => (
              <li key={p.key}>
                <div className="mcp-preset-text">
                  <span className="mcp-label">{p.label}</span>
                  <span className="muted small">
                    {p.blurb} {p.note}
                  </span>
                </div>
                <button type="button" className="btn ghost" onClick={() => setDraft(fromPreset(p))}>
                  Add
                </button>
              </li>
            ))}
          </ul>
          <p className="form-hint mcp-form-hint">
            The first start can take a minute while npx or uvx downloads the server. If it times out, test it again.
          </p>
        </>
      )}
    </div>
  )
}
