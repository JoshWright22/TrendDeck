import { useState, type ReactNode } from 'react'
import {
  IMPORT_PLATFORMS,
  PLATFORM_NAMES,
  VOICE_PLATFORMS,
  cleanHandle,
  type VoiceProfile
} from '@shared/voice'
import { CloseIcon } from '../../components/Icons'

interface Props {
  profile: VoiceProfile
  onChange: (fn: (p: VoiceProfile) => VoiceProfile) => void
}

type ListKey = 'tone' | 'topics' | 'useWords' | 'avoidWords' | 'useEmoji' | 'avoidEmoji' | 'ctas' | 'links' | 'hashtags'

function ChipField(props: {
  label: string
  hint: string
  values: string[]
  // ctas have commas in them, so they're added one per enter
  oneAtATime?: boolean
  clean?: (s: string) => string
  onChange: (values: string[]) => void
}): ReactNode {
  const { label, hint, values, oneAtATime, clean = (s) => s.trim(), onChange } = props
  const [draft, setDraft] = useState('')
  const commit = (): void => {
    const parts = oneAtATime ? [draft] : draft.split(',')
    const next = [...values]
    for (const raw of parts) {
      const v = clean(raw)
      if (v && !next.some((x) => x.toLowerCase() === v.toLowerCase())) next.push(v)
    }
    onChange(next)
    setDraft('')
  }
  return (
    <div className="v-field">
      <label>
        {label}
        <input
          value={draft}
          placeholder={hint}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => draft.trim() && commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || (!oneAtATime && e.key === ',')) {
              e.preventDefault()
              commit()
            }
          }}
        />
      </label>
      {values.length > 0 && (
        <div className="v-chips">
          {values.map((v) => (
            <span key={v} className="chip">
              {v}
              <button aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>
                <CloseIcon />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function Area(props: { label: string; hint: string; value: string; onChange: (v: string) => void }): ReactNode {
  return (
    <div className="v-field">
      <label>
        {props.label}
        <textarea
          rows={3}
          value={props.value}
          placeholder={props.hint}
          onChange={(e) => props.onChange(e.target.value)}
        />
      </label>
    </div>
  )
}

export default function Profile({ profile, onChange }: Props): ReactNode {
  const set = <K extends keyof VoiceProfile>(key: K, value: VoiceProfile[K]): void =>
    onChange((p) => ({ ...p, [key]: value }))
  const chips = (key: ListKey, label: string, hint: string, extra: Partial<Parameters<typeof ChipField>[0]> = {}): ReactNode => (
    <ChipField label={label} hint={hint} values={profile[key]} onChange={(v) => set(key, v)} {...extra} />
  )

  return (
    <div className="v-profile">
      <section className="v-card">
        <h3>Who you are</h3>
        <Area
          label="The brand"
          hint="What this brand is and what it posts about, in your words"
          value={profile.about}
          onChange={(v) => set('about', v)}
        />
        <Area
          label="Audience"
          hint="Who reads it, what they care about"
          value={profile.audience}
          onChange={(v) => set('audience', v)}
        />
        {chips('tone', 'Tone', 'blunt, funny, nerdy... comma or enter to add')}
        {chips('topics', 'Topics it covers', 'budget pc builds, game news...')}
        <Area
          label="Never says or does"
          hint="Off limits topics, words, jokes, claims"
          value={profile.never}
          onChange={(v) => set('never', v)}
        />
      </section>

      <section className="v-card">
        <h3>Words and emoji</h3>
        {chips('useWords', 'Words it uses', 'slang, catchphrases')}
        {chips('avoidWords', 'Words it avoids', 'words that sound off brand')}
        {chips('useEmoji', 'Emoji it uses', '🔥, 💀')}
        {chips('avoidEmoji', 'Emoji it avoids', '🚀, ✨')}
      </section>

      <section className="v-card">
        <h3>Calls to action and links</h3>
        {chips('ctas', 'Calls to action', 'One per enter, like "Sub for part 2"', { oneAtATime: true })}
        {chips('links', 'Links', 'your site, store, discord', { oneAtATime: true })}
        {chips('hashtags', 'Hashtags', '#pcbuild, #budgetgaming', {
          clean: (s) => s.trim().replace(/\s+/g, '').replace(/^#*/, '#').replace(/^#$/, '')
        })}
      </section>

      <section className="v-card">
        <h3>Per site</h3>
        <p className="muted small">
          Your handle is where "Import from my accounts" looks. X and Reddit can find it from your login.
        </p>
        <div className="v-handles">
          {IMPORT_PLATFORMS.map((k) => (
            <label key={k}>
              {PLATFORM_NAMES[k]}
              <input
                value={profile.handles[k] ?? ''}
                placeholder="@handle"
                onChange={(e) =>
                  onChange((p) => ({ ...p, handles: { ...p.handles, [k]: cleanHandle(e.target.value) } }))
                }
              />
            </label>
          ))}
        </div>
        {VOICE_PLATFORMS.map((k) => (
          <Area
            key={k}
            label={`Notes for ${PLATFORM_NAMES[k]}`}
            hint={k === 'x' ? 'Short, no hashtags, threads for long stuff' : 'How posts here differ'}
            value={profile.platformNotes[k] ?? ''}
            onChange={(v) => onChange((p) => ({ ...p, platformNotes: { ...p.platformNotes, [k]: v } }))}
          />
        ))}
      </section>
    </div>
  )
}
