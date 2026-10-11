import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  analyze,
  buildContext,
  PLATFORM_NAMES,
  summaryText,
  VOICE_PLATFORMS,
  type ImportPlatform,
  type VoiceData,
  type VoiceImportResult,
  type VoiceParts,
  type VoicePlatform
} from '@shared/voice'
import PageHeader from '../../components/PageHeader'
import type { PageProps } from '../types'
import Profile from './Profile'
import Posts from './Posts'
import { draftChat } from './chatDraft'
import './voice.css'

type Tab = 'profile' | 'posts' | 'summary' | 'context'

const SAVE_MS = 400

function Summary({ data, onChange }: { data: VoiceData; onChange: (fn: (d: VoiceData) => VoiceData) => void }): ReactNode {
  const computed = useMemo(() => summaryText(analyze(data.posts), data.posts), [data.posts])
  const edited = data.summaryText !== null
  return (
    <section className="v-card">
      <h3>How your past posts look</h3>
      <p className="muted small">
        Counted from your post library on this computer, no agent involved. Edit it if something is off.
        {edited && ' You edited this, so it stops updating when posts change.'}
      </p>
      {data.posts.length === 0 && !edited ? (
        <p className="feed-empty">Add some posts first and this fills in.</p>
      ) : (
        <textarea
          className="v-summary"
          spellCheck={false}
          value={data.summaryText ?? computed}
          onChange={(e) => {
            const v = e.target.value
            onChange((d) => ({ ...d, summaryText: v }))
          }}
        />
      )}
      {edited && (
        <div className="v-row">
          <button className="pill" onClick={() => onChange((d) => ({ ...d, summaryText: null }))}>
            Reset to the counted version
          </button>
        </div>
      )}
    </section>
  )
}

const LEARN_ASK =
  "Here's my brand voice and some of my past posts. Read them and tell me how I write in a few short points: what I always do, what I never do, and anything my profile is missing. Don't write a post yet."

function Context(props: {
  brandName: string
  data: VoiceData
  onChange: (fn: (d: VoiceData) => VoiceData) => void
  chatOpen: boolean
  onToggleChat: () => void
}): ReactNode {
  const { brandName, data, onChange } = props
  const [platform, setPlatform] = useState<VoicePlatform | ''>('')
  const [copied, setCopied] = useState(false)
  const [drafted, setDrafted] = useState(false)
  const ctx = useMemo(
    () => buildContext(brandName, data, platform || undefined),
    [brandName, data, platform]
  )
  const setPart = (key: keyof VoiceParts): void =>
    onChange((d) => ({ ...d, parts: { ...d.parts, [key]: !d.parts[key] } }))

  const learn = (): void => {
    draftChat(`${LEARN_ASK}\n\n${ctx.text}`)
    if (!props.chatOpen) props.onToggleChat()
    setDrafted(true)
  }

  const full = ctx.chars >= ctx.budget * 0.98
  return (
    <section className="v-card">
      <h3>What the agent gets</h3>
      <p className="muted small">
        This exact text goes in front of every chat message for this brand. Switch parts off to leave them out.
      </p>
      <div className="v-row">
        {(['profile', 'summary', 'examples'] as const).map((k) => (
          <label key={k} className="v-switch">
            <input type="checkbox" checked={data.parts[k]} onChange={() => setPart(k)} />
            {k === 'profile' ? 'Profile' : k === 'summary' ? 'Summary' : 'Example posts'}
          </label>
        ))}
        <label className="muted small">
          Writing for{' '}
          <select value={platform} onChange={(e) => setPlatform(e.target.value as VoicePlatform | '')}>
            <option value="">Any site</option>
            {VOICE_PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {PLATFORM_NAMES[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="muted small">
          Size limit{' '}
          <input
            className="v-budget"
            type="number"
            min={500}
            max={40000}
            step={500}
            value={data.budget}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n)) onChange((d) => ({ ...d, budget: Math.min(40000, Math.max(500, n)) }))
            }}
          />{' '}
          characters
        </label>
      </div>
      <div className="v-meter" aria-hidden="true">
        <span
          className={full ? 'full' : ''}
          style={{ width: `${Math.min(100, (100 * ctx.chars) / ctx.budget)}%` }}
        />
      </div>
      <p className="small v-sizes num">
        {ctx.chars.toLocaleString()} of {ctx.budget.toLocaleString()} characters, about{' '}
        {Math.ceil(ctx.chars / 4).toLocaleString()} tokens. Profile {ctx.profileChars.toLocaleString()}, summary{' '}
        {ctx.summaryChars.toLocaleString()}, {ctx.examples} example posts
        {ctx.skipped > 0 && `, ${ctx.skipped} more didn't fit`}.
      </p>
      <pre className="v-preview">{ctx.text}</pre>
      <div className="v-row">
        <button
          className="pill"
          onClick={() => {
            void navigator.clipboard.writeText(ctx.text).then(() => setCopied(true))
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button className="pill teal" onClick={learn} title="Puts a message in the chat box, you send it">
          Learn my voice
        </button>
        {drafted && <span className="muted small">It's in the chat box. Nothing is sent until you send it.</span>}
      </div>
    </section>
  )
}

export default function VoicePage({ brand, chatOpen, onToggleChat }: PageProps): ReactNode {
  const [data, setData] = useState<VoiceData | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('profile')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<VoiceData | null>(null)
  const brandId = brand.id

  useEffect(() => {
    let alive = true
    window.trenddeck
      .voiceLoad(brandId)
      .then((d) => alive && setData(d))
      .catch((err) => alive && setError(String(err)))
    return () => {
      alive = false
    }
  }, [brandId])

  const flush = useCallback((): Promise<void> => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const d = pending.current
    pending.current = null
    return d ? window.trenddeck.voiceSave(brandId, d) : Promise.resolve()
  }, [brandId])

  // save on the way out
  useEffect(() => () => void flush(), [flush])

  const edit = useCallback(
    (fn: (d: VoiceData) => VoiceData): void => {
      setData((d) => {
        if (!d) return d
        const next = fn(d)
        pending.current = next
        return next
      })
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void flush(), SAVE_MS)
    },
    [flush]
  )

  const runImport = async (platforms: ImportPlatform[]): Promise<VoiceImportResult[]> => {
    await flush()
    const res = await window.trenddeck.voiceImport(brandId, platforms)
    setData(res.data)
    return res.results
  }

  const tabs: [Tab, string][] = [
    ['profile', 'Profile'],
    ['posts', `Past posts${data?.posts.length ? ` (${data.posts.length})` : ''}`],
    ['summary', 'Summary'],
    ['context', 'What the agent gets']
  ]

  return (
    <div className="page voice-page">
      <PageHeader title="Brand voice" chatOpen={chatOpen} onToggleChat={onToggleChat}>
        <nav className="v-tabs" aria-label="Brand voice sections">
          {tabs.map(([k, label]) => (
            <button
              key={k}
              className={`filter-chip${tab === k ? ' on' : ''}`}
              aria-current={tab === k ? 'page' : undefined}
              onClick={() => setTab(k)}
            >
              {label}
            </button>
          ))}
        </nav>
      </PageHeader>
      <div className="scroll">
        {error && <p className="v-note bad">{error}</p>}
        {data && tab === 'profile' && (
          <Profile profile={data.profile} onChange={(fn) => edit((d) => ({ ...d, profile: fn(d.profile) }))} />
        )}
        {data && tab === 'posts' && (
          <Posts
            posts={data.posts}
            onChange={(fn) => edit((d) => ({ ...d, posts: fn(d.posts) }))}
            onImport={runImport}
          />
        )}
        {data && tab === 'summary' && <Summary data={data} onChange={edit} />}
        {data && tab === 'context' && (
          <Context
            brandName={brand.name}
            data={data}
            onChange={edit}
            chatOpen={chatOpen}
            onToggleChat={onToggleChat}
          />
        )}
      </div>
    </div>
  )
}
