import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  LOCAL_MODELS, WHISPER_LANGUAGES, localModel, prefsFor, sourceParts,
  type DictationApi, type DictationConfig, type DictationOptions, type LocalDevice, type LocalDtype, type LocalModelInfo,
  type LocalModelsState, type ProviderConfig, type SttModelInfo, type SttProviderInfo
} from '@shared/dictation'
import { Dropdown } from '../../chat/ui'
import { lastWhisperDevice, onWhisperDevice, useDictationSource, type Device } from '../../dictation/engine'
import { cleanError } from '../../plain-error'
import './dictation-settings.css'

// Settings, Dictation: where speech becomes text (a local model, a server on this computer or a
// cloud API), the models and providers for each, and how the composer's mic behaves

type View = 'local' | 'local-server' | 'api'
const PAUSES = [500, 1000, 1500, 2000, 3000, 5000]
const DTYPE_TEXT: Record<LocalDtype, string> = { fp32: 'Full (fp32)', fp16: 'Half (fp16)', q8: '8-bit (q8)', q4: '4-bit (q4)' }
const DEVICE_TEXT: Record<LocalDevice, string> = { auto: 'Auto', webgpu: 'Graphics card (WebGPU)', wasm: 'CPU' }
const RAN_TEXT: Record<Device, string> = { webgpu: 'Last ran on your graphics card (WebGPU).', wasm: 'Last ran on the CPU.' }

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.max(0, Math.round(bytes / 1e3))} KB`
}

const plainError = cleanError

// "Ctrl+Space" from a key press, null for a lone modifier
function shortcutFrom(e: KeyboardEvent): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null
  let key = ''
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3)
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5)
  else if (/^F\d{1,2}$/.test(e.code) || ['Space', 'Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash'].includes(e.code)) key = e.code
  else return null
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta'].filter(Boolean)
  return [...mods, key].join('+')
}

export default function DictationSettings(): ReactNode {
  const bridge = typeof window !== 'undefined' ? window.trenddeckDictation : undefined
  const [config, setConfig] = useState<DictationConfig | null>(null)
  const [state, setState] = useState<LocalModelsState>({ models: [], diskBytes: 0 })
  const [providers, setProviders] = useState<SttProviderInfo[]>([])
  const [view, setView] = useState<View>('local')
  const [error, setError] = useState('')
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    if (!bridge) return
    void bridge.getConfig().then((c) => {
      if (!mounted.current) return
      setConfig(c)
      const parts = sourceParts(c.source)
      if (parts?.kind === 'provider') setView(c.providers.find((p) => p.id === parts.id)?.kind ?? 'api')
    }).catch((err: unknown) => setError(plainError(err, 'Dictation settings could not be read.')))
    void bridge.models().then((s) => { if (mounted.current) setState(s) }).catch(() => {})
    void bridge.providers().then((p) => { if (mounted.current) setProviders(p) }).catch(() => {})
    const off = bridge.onModelProgress((p) => {
      if (!mounted.current) return
      if (p.state === 'downloading') {
        setState((s) => ({
          ...s,
          models: s.models.map((m) => m.id !== p.id ? m : {
            ...m, downloading: [...m.downloading.filter((d) => d.dtype !== p.dtype), { dtype: p.dtype, received: p.received, total: p.total }]
          })
        }))
      } else {
        if (p.state === 'error') setError(p.error ?? 'Download failed.')
        void bridge.models().then((s) => { if (mounted.current) setState(s) }).catch(() => {})
      }
    })
    // the agent can set dictation up while this is open
    const offConfig = bridge.onConfigChanged((c) => { if (mounted.current) setConfig(c) })
    return () => {
      mounted.current = false
      off()
      offConfig()
    }
  }, [bridge])

  if (!bridge) return <p className="form-hint">Dictation works in the TrendDeck app.</p>
  if (!config) return error ? <p className="form-error">{error}</p> : null

  const ctx: Ctx = {
    bridge, config, state, providers, setError,
    setConfig: (c) => { if (mounted.current) setConfig(c) },
    setState: (s) => { if (mounted.current) setState(s) },
    async run(fn) {
      setError('')
      try {
        await fn()
      } catch (err) {
        const message = plainError(err, 'Something went wrong.')
        if (mounted.current && message !== 'Download cancelled.') setError(message)
      }
    },
    async save(patch) {
      await ctx.run(async () => ctx.setConfig(await bridge.saveConfig(patch)))
    },
    async use(source) {
      await ctx.run(async () => {
        await useDictationSource(source)
        ctx.setConfig(await bridge.getConfig())
      })
    }
  }

  return (
    <div className="dz">
      <label>
        Source
        <Dropdown<View>
          className="block"
          label="Dictation source"
          value={view}
          options={[
            { value: 'local', label: 'Local models', hint: 'Runs on this computer' },
            { value: 'local-server', label: 'Local server', hint: 'A transcription server you run on this computer' },
            { value: 'api', label: 'Cloud API', hint: 'Audio goes to the provider' }
          ]}
          onChange={setView}
        />
      </label>
      <ActiveLine ctx={ctx} />
      {view === 'local' ? <LocalModels ctx={ctx} /> : <Providers key={view} ctx={ctx} kind={view} />}
      <Composer ctx={ctx} />
      {error && <p className="form-error dz-error">{error}</p>}
    </div>
  )
}

interface Ctx {
  bridge: DictationApi
  config: DictationConfig
  state: LocalModelsState
  providers: SttProviderInfo[]
  setConfig: (c: DictationConfig) => void
  setState: (s: LocalModelsState) => void
  setError: (e: string) => void
  run: (fn: () => Promise<void>) => Promise<void>
  save: (patch: Partial<DictationOptions>) => Promise<void>
  use: (source: string) => Promise<void>
}

function ActiveLine({ ctx }: { ctx: Ctx }): ReactNode {
  const parts = sourceParts(ctx.config.source)
  let text = ''
  if (parts?.kind === 'local') {
    const info = localModel(parts.id, ctx.config.customModels)
    const installed = ctx.state.models.find((m) => m.id === parts.id)?.installed.length
    text = info ? `In use: ${info.label}${installed ? '' : ', not downloaded yet'}. Your audio stays on this computer.` : ''
  } else if (parts) {
    const p = ctx.config.providers.find((x) => x.id === parts.id)
    if (p) text = `In use: ${p.label}${p.model ? `, ${p.model}` : ''}. ${p.kind === 'local-server' ? 'Stays on this computer.' : `Audio is sent to ${p.host || 'the provider'}`}`
  }
  return text ? <p className="dz-line">{text}</p> : null
}

// ---------- local models ----------

function LocalModels({ ctx }: { ctx: Ctx }): ReactNode {
  const { config, state, bridge } = ctx
  const [device, setDevice] = useState<Device | null>(() => lastWhisperDevice())
  const [repo, setRepo] = useState('')
  const [adding, setAdding] = useState(false)
  useEffect(() => onWhisperDevice(setDevice), [])
  const all = [...LOCAL_MODELS, ...config.customModels]
  const parts = sourceParts(config.source)
  const activeInfo = parts?.kind === 'local' ? localModel(parts.id, config.customModels) : undefined

  return (
    <>
      <label>
        Language
        <Dropdown
          className="block"
          label="Language"
          value={activeInfo?.englishOnly ? 'en' : config.language}
          disabled={!!activeInfo?.englishOnly}
          options={WHISPER_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
          onChange={(language) => void ctx.save({ language })}
        />
      </label>
      {activeInfo?.englishOnly && <p className="form-hint">{activeInfo.label} only understands English.</p>}
      <ul className="dz-list">
        {all.map((info) => <ModelRow key={info.id} ctx={ctx} info={info} />)}
      </ul>
      <p className="dz-meta">
        Models use {formatBytes(state.diskBytes)} on disk.{device && activeInfo ? ` ${RAN_TEXT[device]}` : ''}
      </p>
      <label>
        Add a model from Hugging Face
        <div className="dz-key">
          <input
            value={repo}
            spellCheck={false}
            placeholder="onnx-community/whisper-large-v3"
            onChange={(e) => setRepo(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && repo.trim()) { e.preventDefault(); void add() } }}
          />
          <button type="button" className="btn ghost" disabled={!repo.trim() || adding} onClick={() => void add()}>
            {adding ? 'Checking...' : 'Add'}
          </button>
        </div>
      </label>
      <p className="form-hint">Whisper and Moonshine models from onnx-community. They download and run like the ones above.</p>
    </>
  )

  async function add(): Promise<void> {
    setAdding(true)
    await ctx.run(async () => {
      ctx.setConfig(await bridge.addCustomModel(repo.trim()))
      ctx.setState(await bridge.models())
      setRepo('')
    })
    setAdding(false)
  }
}

function ModelRow({ ctx, info }: { ctx: Ctx; info: LocalModelInfo }): ReactNode {
  const { config, state, bridge } = ctx
  const status = state.models.find((m) => m.id === info.id)
  const prefs = prefsFor(info, config.localPrefs)
  const variant = info.variants[prefs.dtype]!
  const installed = !!status?.installed.includes(prefs.dtype)
  const downloading = status?.downloading.find((d) => d.dtype === prefs.dtype)
  const active = config.source === `local:${info.id}`
  const pct = downloading?.total ? Math.min(100, Math.floor((downloading.received / downloading.total) * 100)) : 0
  const dtypes = Object.keys(info.variants) as LocalDtype[]
  const setPrefs = (patch: Partial<typeof prefs>): void => {
    void ctx.save({ localPrefs: { ...config.localPrefs, [info.id]: { ...prefs, ...patch } } }).then(async () => {
      // a different size or device of the model in use loads on the next dictation
      if (active) await ctx.use(`local:${info.id}`)
    })
  }
  const facts = [
    info.speed,
    formatBytes(variant.bytes),
    info.englishOnly ? 'English only' : 'Many languages',
    info.wordTimes === 'exact' ? 'Word times' : 'Approximate word times'
  ].join(', ')

  return (
    <li className={`dz-row${active ? ' active' : ''}`}>
      <div className="dz-row-main">
        <div className="dz-row-text">
          <span className="dz-row-name">{info.label}{active && <span className="dz-row-state">In use</span>}</span>
          <span className="dz-row-facts">{facts}. {info.note}</span>
        </div>
        <div className="dz-row-actions">
          {downloading ? (
            <button type="button" className="btn ghost" onClick={() => void ctx.run(() => bridge.cancelDownload(info.id, prefs.dtype))}>Cancel</button>
          ) : installed ? (
            <>
              {!active && <button type="button" className="btn ghost" onClick={() => void ctx.use(`local:${info.id}`)}>Use</button>}
              <button type="button" className="btn ghost" onClick={() => void ctx.run(async () => ctx.setState(await bridge.deleteModel(info.id, prefs.dtype)))}>Delete</button>
            </>
          ) : (
            <button type="button" className="btn ghost" onClick={() => void ctx.run(async () => ctx.setState(await bridge.downloadModel(info.id, prefs.dtype)))}>Download</button>
          )}
          {info.custom && !downloading && (
            <button type="button" className="btn ghost" onClick={() => void ctx.run(async () => {
              ctx.setConfig(await bridge.removeCustomModel(info.id))
              ctx.setState(await bridge.models())
            })}>Remove</button>
          )}
        </div>
      </div>
      {downloading && (
        <div className="dz-progress">
          <span className="dz-row-facts">Downloading {pct}%</span>
          <div className="dz-bar" role="progressbar" aria-label={`Downloading ${info.label}`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
      <div className="dz-row-opts">
        <Dropdown<LocalDtype>
          label={`${info.label} precision`}
          title="Smaller downloads are faster and a little less accurate"
          value={prefs.dtype}
          options={dtypes.map((d) => ({
            value: d,
            label: `${DTYPE_TEXT[d]}, ${formatBytes(info.variants[d]!.bytes)}${status?.installed.includes(d) ? ', downloaded' : ''}`
          }))}
          onChange={(dtype) => setPrefs({ dtype })}
        />
        <Dropdown<LocalDevice>
          label={`${info.label} runs on`}
          title="Where the model runs. Auto uses the graphics card when it can"
          value={prefs.device}
          options={(['auto', 'webgpu', 'wasm'] as LocalDevice[]).map((d) => ({ value: d, label: `Runs on: ${DEVICE_TEXT[d]}` }))}
          onChange={(device) => setPrefs({ device })}
        />
      </div>
    </li>
  )
}

// ---------- providers ----------

function Providers({ ctx, kind }: { ctx: Ctx; kind: 'local-server' | 'api' }): ReactNode {
  const { config, providers } = ctx
  const configured = config.providers.filter((p) => p.kind === kind)
  const choices = providers.filter((p) => p.kind === kind)
  const [editing, setEditing] = useState<ProviderConfig | 'new' | null>(configured.length ? null : 'new')

  return (
    <>
      {configured.length > 0 && (
        <ul className="dz-list">
          {configured.map((p) => {
            const active = config.source === `provider:${p.id}`
            return (
              <li key={p.id} className={`dz-row${active ? ' active' : ''}`}>
                <div className="dz-row-main">
                  <div className="dz-row-text">
                    <span className="dz-row-name">{p.label}{active && <span className="dz-row-state">In use</span>}</span>
                    <span className="dz-row-facts">{[p.model, p.host].filter(Boolean).join(', ')}</span>
                  </div>
                  <div className="dz-row-actions">
                    {!active && <button type="button" className="btn ghost" onClick={() => void ctx.use(`provider:${p.id}`)}>Use</button>}
                    <button type="button" className="btn ghost" onClick={() => setEditing(p)}>Edit</button>
                    <button type="button" className="btn ghost" onClick={() => void ctx.run(async () => {
                      ctx.setConfig(await ctx.bridge.deleteProvider(p.id))
                      if (editing !== 'new' && editing?.id === p.id) setEditing(null)
                    })}>Delete</button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {editing ? (
        <ProviderForm
          key={editing === 'new' ? 'new' : editing.id}
          ctx={ctx}
          choices={choices}
          existing={editing === 'new' ? null : editing}
          onDone={() => setEditing(null)}
        />
      ) : (
        <button type="button" className="btn ghost dz-add" onClick={() => setEditing('new')}>
          {kind === 'api' ? 'Add a cloud API' : 'Add a local server'}
        </button>
      )}
    </>
  )
}

function ProviderForm({ ctx, choices, existing, onDone }: {
  ctx: Ctx
  choices: SttProviderInfo[]
  existing: ProviderConfig | null
  onDone: () => void
}): ReactNode {
  const firstAvailable = choices.find((c) => !c.unavailable) ?? choices[0]
  const [providerId, setProviderId] = useState(existing?.providerId ?? firstAvailable?.id ?? '')
  const info = choices.find((c) => c.id === providerId)
  const [values, setValues] = useState<Record<string, string>>(existing?.values ?? {})
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [model, setModel] = useState(existing?.model ?? info?.defaultModel ?? '')
  const [models, setModels] = useState<SttModelInfo[]>(info?.staticModels ?? [])
  const [other, setOther] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!existing || !info?.canListModels) return
    let live = true
    void ctx.bridge.providerModels(existing.id).then((m) => { if (live && m.length) setModels(m) }).catch(() => {})
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing?.id])

  if (!choices.length) return <p className="form-hint">No providers of this kind are available yet.</p>
  const modelKnown = models.some((m) => m.id === model)

  async function save(test: boolean): Promise<void> {
    if (!info) return
    setBusy(true)
    setResult(null)
    await ctx.run(async () => {
      const input: Record<string, string | null> = {}
      for (const f of info.fields) input[f.key] = f.secret ? (secrets[f.key] ?? '') : (values[f.key] ?? '')
      const before = new Set(ctx.config.providers.map((p) => p.id))
      const next = await ctx.bridge.saveProvider({ id: existing?.id, providerId: info.id, values: input, model })
      ctx.setConfig(next)
      setSecrets({})
      const saved = existing ?? next.providers.find((p) => !before.has(p.id)) ?? null
      if (test && saved) setResult(await ctx.bridge.testProvider(saved.id))
      else onDone()
    })
    setBusy(false)
  }

  const saved = existing ? ctx.config.providers.find((p) => p.id === existing.id) : null
  const host = saved?.host ?? ''

  return (
    <div className="dz-form">
      <label>
        Provider
        <Dropdown
          className="block"
          label="Provider"
          value={providerId}
          disabled={!!existing}
          options={choices.map((c) => ({ value: c.id, label: c.label, hint: c.unavailable, disabled: !!c.unavailable }))}
          onChange={(id) => {
            const next = choices.find((c) => c.id === id)
            setProviderId(id)
            setValues({})
            setSecrets({})
            setModel(next?.defaultModel ?? '')
            setModels(next?.staticModels ?? [])
            setOther(false)
          }}
        />
      </label>
      {info?.fields.map((f) => {
        const choicesFor = f.options?.map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
        return (
          <label key={f.key}>
            {f.label}{f.required ? '' : ' (optional)'}
            {choicesFor?.length ? (
              <Dropdown
                className="block"
                label={f.label}
                value={values[f.key] ?? ''}
                options={[...(f.required ? [] : [{ value: '', label: 'Default' }]), ...choicesFor]}
                onChange={(v) => setValues({ ...values, [f.key]: v })}
              />
            ) : f.secret ? (
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={secrets[f.key] ?? ''}
                placeholder={saved?.hasSecret[f.key] ? 'Saved. Type to replace it' : f.placeholder ?? ''}
                onChange={(e) => setSecrets({ ...secrets, [f.key]: e.target.value })}
              />
            ) : (
              <input
                type={f.kind === 'url' ? 'url' : 'text'}
                spellCheck={false}
                value={values[f.key] ?? ''}
                placeholder={f.placeholder ?? ''}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              />
            )}
          </label>
        )
      })}
      <label>
        Model
        {models.length > 0 && !other ? (
          <Dropdown
            className="block"
            label="Model"
            value={modelKnown ? model : '__other'}
            options={[
              ...models.map((m) => ({ value: m.id, label: m.label || m.id, hint: [m.wordTimestamps ? 'Word times' : 'No word times', m.note].filter(Boolean).join('. ') })),
              { value: '__other', label: 'Other model...' }
            ]}
            onChange={(v) => {
              if (v === '__other') setOther(true)
              else setModel(v)
            }}
          />
        ) : (
          <input value={model} spellCheck={false} placeholder={info?.defaultModel ?? ''} onChange={(e) => setModel(e.target.value)} />
        )}
      </label>
      {info && (
        <p className="dz-line">{info.kind === 'local-server' ? 'Stays on this computer.' : `Audio is sent to ${host || 'the provider you pick'}`}</p>
      )}
      <div className="dz-form-actions">
        <button type="button" className="btn primary" disabled={busy || !info || !!info.unavailable} onClick={() => void save(false)}>Save</button>
        {info?.canTest !== false && (
          <button type="button" className="btn ghost" disabled={busy || !info || !!info.unavailable} onClick={() => void save(true)}>Save and test</button>
        )}
        <button type="button" className="btn ghost" disabled={busy} onClick={onDone}>Close</button>
      </div>
      {result && <p className={result.ok ? 'dz-line' : 'form-error'}>{result.message}</p>}
    </div>
  )
}

// ---------- the composer's mic ----------

function Composer({ ctx }: { ctx: Ctx }): ReactNode {
  const { config } = ctx
  const [recording, setRecording] = useState(false)

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(false)
        return
      }
      const shortcut = shortcutFrom(e)
      if (!shortcut) return
      setRecording(false)
      void ctx.save({ holdKey: shortcut })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, ctx])

  return (
    <div className="dz-group">
      <div className="dz-row-main">
        <span className="dz-row-name">Hold to talk</span>
        <button type="button" className="btn ghost dz-shortcut" aria-label="Change the hold-to-talk shortcut" onClick={() => setRecording(!recording)}>
          {recording ? 'Press keys, Esc to stop' : <kbd>{config.holdKey.replace(/\+/g, ' + ')}</kbd>}
        </button>
      </div>
      <label className="toggle-row">
        <input type="checkbox" checked={config.autoSend} onChange={(e) => void ctx.save({ autoSend: e.target.checked })} />
        <span>Send automatically after a pause</span>
      </label>
      {config.autoSend && (
        <label className="dz-pause">
          Pause before sending
          <Dropdown
            className="block"
            label="Pause before sending"
            value={String(config.autoSendPauseMs)}
            options={(PAUSES.includes(config.autoSendPauseMs) ? PAUSES : [...PAUSES, config.autoSendPauseMs].sort((a, b) => a - b))
              .map((ms) => ({ value: String(ms), label: `${ms / 1000} ${ms === 1000 ? 'second' : 'seconds'}` }))}
            onChange={(v) => void ctx.save({ autoSendPauseMs: Number(v) })}
          />
        </label>
      )}
    </div>
  )
}
