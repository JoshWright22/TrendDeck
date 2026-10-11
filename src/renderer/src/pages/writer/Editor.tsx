import { useEffect, useState, type ReactNode } from 'react'
import type { Brand, Draft, DraftVersion, Idea, PlatformDraft } from '@shared/types'
import { CloseIcon, PlusIcon } from '../../components/Icons'
import { copyText } from './Mark'
import {
  fieldCount,
  fit,
  fullText,
  hasContent,
  hashtags,
  tidyHashtags,
  xLength,
  type PlatformSpec
} from './platforms'
import { buildPrompt, draftGenerator, generateDraft, onDraftGenerator, parseReply } from './generate'

const MAX_VERSIONS = 30
const MAX_POSTS = 25

const newId = (): string => crypto.randomUUID()

interface Props {
  brand: Brand
  draft: Draft
  idea: Idea | undefined
  spec: PlatformSpec
  onChange: (fn: (d: PlatformDraft) => PlatformDraft) => void
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }): ReactNode {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(false), 1200)
    return () => clearTimeout(t)
  }, [done])
  return (
    <button
      className={`pill small-pill${done ? ' done' : ''}`}
      disabled={!text.trim()}
      onClick={() => void copyText(text).then(setDone)}
    >
      {done ? 'Copied' : label}
    </button>
  )
}

function Counter({ n, limit, title }: { n: number; limit: number; title?: string }): ReactNode {
  return (
    <span className={`wr-count ${fit(n, limit)}`} title={title}>
      {n.toLocaleString()}/{limit.toLocaleString()}
    </span>
  )
}

// things the limits alone don't catch
function warnings(spec: PlatformSpec, d: PlatformDraft): string[] {
  const out: string[] = []
  const f = d.fields
  if (spec.id === 'youtube' && /[<>]/.test(`${f.title ?? ''}${f.description ?? ''}`)) {
    out.push("YouTube won't take < or > in the title or description.")
  }
  if (spec.id === 'youtube' && (f.tags ?? '').includes('#')) {
    out.push('Tags go in without the #.')
  }
  if ((spec.id === 'tiktok' || spec.id === 'instagram') && f.hashtags?.trim()) {
    const loose = f.hashtags.split(/\s+/).filter((w) => w && !w.startsWith('#'))
    if (loose.length) out.push('Some hashtags are missing the #, hit Tidy to fix them.')
  }
  if (spec.id === 'instagram' && hashtags(`${f.caption ?? ''} ${f.hashtags ?? ''}`).length > 30) {
    out.push('Instagram drops the whole caption past 30 hashtags.')
  }
  return out
}

function sameContent(a: { fields: Record<string, string>; thread: string[] }, b: PlatformDraft): boolean {
  const keys = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])
  for (const k of keys) if ((a.fields[k] ?? '') !== (b.fields[k] ?? '')) return false
  return a.thread.join('\u0000') === b.thread.join('\u0000')
}

function snapshot(d: PlatformDraft, kind: DraftVersion['kind']): DraftVersion {
  return { id: newId(), at: Date.now(), kind, fields: { ...d.fields }, thread: [...d.thread] }
}

// keeps the current text as a version unless an identical one is already saved
function withVersion(d: PlatformDraft, kind: DraftVersion['kind']): PlatformDraft {
  if (!hasContent(d) || d.versions.some((v) => sameContent(v, d))) return d
  return { ...d, versions: [snapshot(d, kind), ...d.versions].slice(0, MAX_VERSIONS) }
}

function preview(v: DraftVersion): string {
  const text = [...Object.values(v.fields), ...v.thread].find((s) => s.trim()) ?? ''
  return text.length > 90 ? `${text.slice(0, 90)}...` : text
}

function when(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function Fields({
  spec,
  d,
  onChange
}: {
  spec: PlatformSpec
  d: PlatformDraft
  onChange: Props['onChange']
}): ReactNode {
  const set = (key: string, value: string): void =>
    onChange((p) => ({ ...p, fields: { ...p.fields, [key]: value } }))
  return (
    <>
      {spec.fields.map((f) => {
        const n = fieldCount(f, d.fields)
        const value = d.fields[f.key] ?? ''
        const isTags = f.key === 'hashtags'
        return (
          <div className="wr-field" key={f.key}>
            <div className="wr-field-head">
              <label htmlFor={`wr-${f.key}`}>{f.label}</label>
              <span className="spacer" />
              <Counter n={n} limit={f.limit} title={f.countLabel} />
              {isTags && (
                <button
                  className="pill small-pill ghost-pill"
                  disabled={!value.trim()}
                  onClick={() => set(f.key, tidyHashtags(value))}
                  title="Add missing #, drop repeats"
                >
                  Tidy
                </button>
              )}
              <CopyButton text={value} />
            </div>
            <textarea
              id={`wr-${f.key}`}
              className={`wr-input ${fit(n, f.limit)}`}
              rows={f.rows}
              value={value}
              placeholder={f.placeholder}
              spellCheck
              onChange={(e) => set(f.key, e.target.value)}
            />
          </div>
        )
      })}
    </>
  )
}

function Thread({
  spec,
  d,
  onChange
}: {
  spec: PlatformSpec
  d: PlatformDraft
  onChange: Props['onChange']
}): ReactNode {
  const limit = spec.thread?.limit ?? 280
  const posts = d.thread.length ? d.thread : ['']
  const setPosts = (fn: (t: string[]) => string[]): void =>
    onChange((p) => ({ ...p, thread: fn(p.thread.length ? p.thread : ['']) }))
  return (
    <>
      {posts.map((post, i) => {
        const n = xLength(post)
        return (
          <div className="wr-field wr-post" key={i}>
            <div className="wr-field-head">
              <label htmlFor={`wr-post-${i}`}>
                {posts.length > 1 ? `Post ${i + 1}/${posts.length}` : 'Post'}
              </label>
              <span className="spacer" />
              <Counter n={n} limit={limit} title="Links count as 23, emoji count as 2" />
              <CopyButton text={post} />
              {posts.length > 1 && (
                <button
                  className="icon-btn small"
                  title="Remove this post"
                  aria-label={`Remove post ${i + 1}`}
                  onClick={() => setPosts((t) => t.filter((_, j) => j !== i))}
                >
                  <CloseIcon />
                </button>
              )}
            </div>
            <textarea
              id={`wr-post-${i}`}
              className={`wr-input ${fit(n, limit)}`}
              rows={4}
              value={post}
              placeholder={i === 0 ? 'What you want to say' : 'Next post in the thread'}
              onChange={(e) => setPosts((t) => t.map((p, j) => (j === i ? e.target.value : p)))}
            />
          </div>
        )
      })}
      <button
        className="pill small-pill ghost-pill wr-add-post"
        disabled={posts.length >= MAX_POSTS}
        onClick={() => setPosts((t) => [...t, ''])}
      >
        <PlusIcon />
        Add to thread
      </button>
    </>
  )
}

function useGenerator(): ReturnType<typeof draftGenerator> {
  const [gen, setGen] = useState(draftGenerator)
  useEffect(() => onDraftGenerator(() => setGen(draftGenerator())), [])
  return gen
}

function Generate({ brand, draft, idea, spec, onChange }: Props): ReactNode {
  const gen = useGenerator()
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const start = (): void => {
    setPrompt(buildPrompt(brand, draft, idea, spec))
    setError('')
    setOpen(true)
  }

  const send = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const reply = await generateDraft(prompt)
      const got = parseReply(spec, reply)
      onChange((p) => {
        // keep what was there before the agent wrote over it
        const kept = withVersion(p, 'manual')
        const next: PlatformDraft = {
          ...kept,
          fields: { ...kept.fields, ...got.fields },
          thread: got.thread.length ? got.thread : kept.thread
        }
        return { ...next, versions: [snapshot(next, 'generated'), ...next.versions].slice(0, MAX_VERSIONS) }
      })
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wr-side-box">
      <h4>Write with your agent</h4>
      {!gen ? (
        <p className="muted small">
          No agent is connected to the writer yet. Writing by hand works the same, and versions and copy work
          either way.
        </p>
      ) : !open ? (
        <>
          <p className="muted small">
            You see the prompt first and nothing is sent until you press send. Your text so far is kept as a
            version.
          </p>
          <button className="pill teal" onClick={start}>
            Draft {spec.name} with {gen.name}
          </button>
        </>
      ) : (
        <>
          <textarea
            className="wr-input wr-prompt"
            rows={9}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            aria-label="Prompt"
          />
          {error && <p className="form-error">{error}</p>}
          <div className="wr-row">
            <button className="btn ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
            <span className="spacer" />
            <button className="pill teal" onClick={() => void send()} disabled={busy || !prompt.trim()}>
              {busy ? 'Writing...' : 'Send'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function Versions({ d, onChange }: { d: PlatformDraft; onChange: Props['onChange'] }): ReactNode {
  const saved = d.versions.some((v) => sameContent(v, d))
  const restore = (v: DraftVersion): void =>
    onChange((p) => {
      const kept = withVersion(p, 'manual')
      return { ...kept, fields: { ...v.fields }, thread: v.thread.length ? [...v.thread] : [''] }
    })
  return (
    <div className="wr-side-box">
      <div className="wr-row">
        <h4>Versions</h4>
        <span className="spacer" />
        <button
          className="pill small-pill"
          disabled={!hasContent(d) || saved}
          onClick={() => onChange((p) => withVersion(p, 'manual'))}
        >
          {saved && hasContent(d) ? 'Saved' : 'Save version'}
        </button>
      </div>
      {d.versions.length === 0 ? (
        <p className="muted small">Save a version before big changes so you can come back to it.</p>
      ) : (
        <ul className="wr-versions">
          {d.versions.map((v) => {
            const isNow = sameContent(v, d)
            return (
              <li key={v.id} className={isNow ? 'now' : ''}>
                <div className="wr-version-top">
                  <span className="small">{when(v.at)}</span>
                  {v.kind === 'generated' && <span className="badge">agent</span>}
                  {isNow && <span className="muted small">current</span>}
                  <span className="spacer" />
                  {!isNow && (
                    <button className="pill small-pill ghost-pill" onClick={() => restore(v)}>
                      Restore
                    </button>
                  )}
                  <button
                    className="icon-btn small"
                    title="Delete version"
                    aria-label="Delete version"
                    onClick={() =>
                      onChange((p) => ({ ...p, versions: p.versions.filter((x) => x.id !== v.id) }))
                    }
                  >
                    <CloseIcon />
                  </button>
                </div>
                <p className="muted small wr-version-text">{preview(v) || 'Empty'}</p>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export default function Editor(props: Props): ReactNode {
  const { spec, draft, onChange } = props
  const d = draft.platforms[spec.id]
  const warn = warnings(spec, d)
  return (
    <div className="wr-editor">
      <div className="wr-main">
        {spec.thread ? (
          <Thread spec={spec} d={d} onChange={onChange} />
        ) : (
          <Fields spec={spec} d={d} onChange={onChange} />
        )}
        {warn.map((w) => (
          <p key={w} className="wr-warn">
            {w}
          </p>
        ))}
        <div className="wr-row wr-copy-all">
          <span className="muted small">
            {spec.thread ? 'Posts joined with a blank line' : 'Everything for this site in one go'}
          </span>
          <span className="spacer" />
          <CopyButton text={fullText(spec, d)} label="Copy all" />
        </div>
      </div>
      <aside className="wr-side">
        <Generate {...props} />
        <Versions d={d} onChange={onChange} />
      </aside>
    </div>
  )
}
