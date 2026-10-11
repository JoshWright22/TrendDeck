import { useEffect, useState, type ReactNode } from 'react'
import { Dropdown } from '../../chat/ui'
import type { ScheduleSlot } from '@shared/types'
import type { PostItem, Visibility } from '@shared/posting'
import {
  SHORT_LIMITS,
  SHORT_NAMES,
  SHORT_PLATFORMS,
  type ChannelShort,
  type ShortPlatform,
  type VideoInfo
} from '@shared/reuse'
import PageHeader from '../../components/PageHeader'
import MediaPicker from '../media/MediaPicker'
import type { PageProps } from '../types'
import { checkShort, clock, mb, type Caption } from './checks'
import './reuse.css'

const pad = (n: number): string => String(n).padStart(2, '0')
const toLocal = (at: number): string => {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// the schedule page uses display names
const SLOT_NAMES: Record<ShortPlatform, string> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok'
}

const emptyCaps = (): Record<ShortPlatform, Caption> => ({
  youtube: { title: '', body: '' },
  instagram: { title: '', body: '' },
  tiktok: { title: '', body: '' }
})

const channelKey = (brandId: string): string => `reuse.channel.${brandId}`

export default function ShortsPage({
  brand,
  editBrand,
  chatOpen,
  onToggleChat
}: PageProps): ReactNode {
  const [video, setVideo] = useState<VideoInfo | null>(null)
  const [on, setOn] = useState<ShortPlatform[]>([...SHORT_PLATFORMS])
  const [caps, setCaps] = useState(emptyCaps)
  const [visibility, setVisibility] = useState<Visibility>('public')
  const [at, setAt] = useState(toLocal(Date.now() + 60 * 60 * 1000))
  // minutes between each platform, 0 sends them all at once
  const [gap, setGap] = useState(30)
  const [step, setStep] = useState<'edit' | 'review'>('edit')
  const [msg, setMsg] = useState('')
  const [fromShort, setFromShort] = useState<ChannelShort | null>(null)
  const [picking, setPicking] = useState(false)

  const [channel, setChannel] = useState(() => localStorage.getItem(channelKey(brand.id)) ?? '')
  const [shorts, setShorts] = useState<ChannelShort[]>([])
  const [listing, setListing] = useState(false)
  const [listError, setListError] = useState('')

  useEffect(() => {
    // new brand, start clean
    setVideo(null)
    setCaps(emptyCaps())
    setStep('edit')
    setShorts([])
    setListError('')
    setFromShort(null)
    setMsg('')
    setChannel(localStorage.getItem(channelKey(brand.id)) ?? '')
  }, [brand.id])

  const pick = async (mediaId: string): Promise<void> => {
    setVideo(await window.trenddeck.reuse.probe(brand.id, mediaId))
  }

  const setCap = (p: ShortPlatform, patch: Partial<Caption>): void =>
    setCaps((c) => ({ ...c, [p]: { ...c[p], ...patch } }))

  // puts the youtube title and description into the other two
  const copyDown = (): void =>
    setCaps((c) => {
      const text = [c.youtube.title, c.youtube.body].filter(Boolean).join('\n\n')
      return { ...c, instagram: { title: '', body: text }, tiktok: { title: '', body: text } }
    })

  const toggle = (p: ShortPlatform): void =>
    setOn((o) =>
      o.includes(p) ? o.filter((x) => x !== p) : SHORT_PLATFORMS.filter((x) => x === p || o.includes(x))
    )

  const checks = {} as Record<ShortPlatform, ReturnType<typeof checkShort>>
  for (const p of on) checks[p] = checkShort(p, video, caps[p])
  const blocked = on.some((p) => checks[p].problems.length > 0)
  const start = new Date(at).getTime()
  const timeOf = (i: number): number => start + i * gap * 60000

  const queue = async (): Promise<void> => {
    if (!video || !on.length || blocked) return
    if (!start || start < Date.now() - 60000) return setMsg('Pick a time in the future')
    const now = Date.now()
    const posts: PostItem[] = on.map((p, i) => ({
      id: crypto.randomUUID(),
      brandId: brand.id,
      platform: p,
      title: SHORT_LIMITS[p].titleMax ? caps[p].title.trim() : '',
      body: caps[p].body.trim(),
      mediaId: video.mediaId,
      byAgent: false,
      mediaUrl: '',
      subreddit: '',
      visibility,
      scheduledAt: timeOf(i),
      status: 'scheduled',
      createdAt: now,
      updatedAt: now,
      note: fromShort ? `From Short ${fromShort.url}` : '',
      url: ''
    }))
    await window.trenddeck.posting.save(posts)
    const slots: ScheduleSlot[] = posts.map((post, i) => ({
      id: crypto.randomUUID(),
      at: timeOf(i),
      platform: SLOT_NAMES[on[i]],
      title: post.title || post.body.split('\n')[0].slice(0, 80) || 'Short',
      ideaId: '',
      draft: post.body,
      done: false
    }))
    editBrand((b) => ({ ...b, schedule: [...(b.schedule ?? []), ...slots] }))
    setMsg(`Queued ${posts.length} posts. They're in Posting and on the Schedule.`)
    setVideo(null)
    setCaps(emptyCaps())
    setFromShort(null)
    setOn([...SHORT_PLATFORMS])
    setStep('edit')
  }

  const loadShorts = async (): Promise<void> => {
    setListing(true)
    setListError('')
    const res = await window.trenddeck.reuse.listShorts(brand.id, channel)
    setListing(false)
    setShorts(res.shorts)
    setListError(res.error)
    if (res.shorts.length) localStorage.setItem(channelKey(brand.id), channel.trim())
  }

  // youtube is left off since its already there, the file still comes from your disk
  const reuse = (s: ChannelShort): void => {
    setFromShort(s)
    setOn(['instagram', 'tiktok'])
    setCaps((c) => ({
      ...c,
      instagram: { title: '', body: s.title },
      tiktok: { title: '', body: s.title }
    }))
    setStep('edit')
    setMsg('Now pick the video file for this Short')
  }

  return (
    <div className="page reuse-page">
      <PageHeader title="Shorts" chatOpen={chatOpen} onToggleChat={onToggleChat} />
      <div className="reuse-body">
        <section className="reuse-main">
          {step === 'edit' ? (
            <>
              <div className="reuse-video">
                <button type="button" className="pill teal" onClick={() => setPicking(true)}>
                  {video ? 'Change video' : 'Pick a vertical video'}
                </button>
                {video && (
                  <span className="muted small" title={video.name}>
                    {video.name} · {mb(video.bytes)}
                    {video.seconds ? ` · ${clock(video.seconds)}` : ''}
                    {video.width ? ` · ${video.width}x${video.height}` : ''}
                  </span>
                )}
              </div>
              {fromShort && (
                <p className="muted small">Reusing {fromShort.title || fromShort.id}</p>
              )}
              <div className="reuse-picks">
                {SHORT_PLATFORMS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`filter-chip${on.includes(p) ? ' on' : ''}`}
                    onClick={() => toggle(p)}
                  >
                    {SHORT_NAMES[p]}
                  </button>
                ))}
                <button type="button" className="btn ghost" onClick={copyDown}>
                  Copy YouTube text to the others
                </button>
              </div>
              <div className="reuse-cols">
                {on.map((p) => {
                  const lim = SHORT_LIMITS[p]
                  const c = checks[p]
                  return (
                    <div key={p} className="reuse-col">
                      <h3>{SHORT_NAMES[p]}</h3>
                      {lim.titleMax > 0 && (
                        <label className="field">
                          <span className="field-name">
                            Title{' '}
                            <span className="muted">
                              {caps[p].title.length}/{lim.titleMax}
                            </span>
                          </span>
                          <input
                            value={caps[p].title}
                            onChange={(e) => setCap(p, { title: e.target.value })}
                          />
                        </label>
                      )}
                      <label className="field">
                        <span className="field-name">
                          {p === 'youtube' ? 'Description' : 'Caption'}{' '}
                          <span className="muted">
                            {caps[p].body.length}/{lim.captionMax}
                          </span>
                        </span>
                        <textarea
                          rows={6}
                          value={caps[p].body}
                          onChange={(e) => setCap(p, { body: e.target.value })}
                        />
                      </label>
                      <ul className="reuse-checks">
                        {c.problems.map((t) => (
                          <li key={t} className="bad">
                            {t}
                          </li>
                        ))}
                        {c.warnings.map((t) => (
                          <li key={t} className="warn">
                            {t}
                          </li>
                        ))}
                        {!c.problems.length && !c.warnings.length && (
                          <li className="ok">Good to go</li>
                        )}
                      </ul>
                    </div>
                  )
                })}
              </div>
              <div className="reuse-when">
                <label className="field">
                  <span className="field-name">First one goes out</span>
                  <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
                </label>
                <label className="field">
                  <span className="field-name">Minutes between each</span>
                  <input
                    type="number"
                    min={0}
                    max={1440}
                    value={gap}
                    onChange={(e) => setGap(Math.max(0, Math.min(1440, Number(e.target.value) || 0)))}
                  />
                </label>
                <label className="field">
                  <span className="field-name">Visibility</span>
                  <Dropdown<Visibility>
                    label="Visibility"
                    value={visibility}
                    options={[
                      { value: 'public', label: 'Public' },
                      { value: 'unlisted', label: 'Unlisted' },
                      { value: 'private', label: 'Private' }
                    ]}
                    onChange={setVisibility}
                  />
                </label>
                <button
                  type="button"
                  className="pill teal"
                  disabled={!video || !on.length || blocked}
                  onClick={() => {
                    setMsg('')
                    setStep('review')
                  }}
                >
                  Review
                </button>
              </div>
            </>
          ) : (
            <div className="reuse-review">
              <h3>Check it over</h3>
              <p className="muted small">{video?.name}</p>
              {on.map((p, i) => (
                <div key={p} className="reuse-row">
                  <b>{SHORT_NAMES[p]}</b>
                  <span className="muted">{new Date(timeOf(i)).toLocaleString()}</span>
                  {SHORT_LIMITS[p].titleMax > 0 && <span>{caps[p].title}</span>}
                  <span className="reuse-snip">
                    {caps[p].body || <i className="muted">No caption</i>}
                  </span>
                  {checks[p].warnings.map((w) => (
                    <span key={w} className="warn small">
                      {w}
                    </span>
                  ))}
                </div>
              ))}
              <div className="reuse-when">
                <button type="button" className="btn ghost" onClick={() => setStep('edit')}>
                  Back
                </button>
                <button type="button" className="pill teal" onClick={() => void queue()}>
                  Queue {on.length} posts
                </button>
              </div>
            </div>
          )}
          {msg && <p className="reuse-msg">{msg}</p>}
        </section>

        <aside className="reuse-side">
          <h3>Import my Shorts</h3>
          <p className="muted small">
            Reads your channel with this brand&apos;s YouTube login. Pick one to send it to Instagram
            and TikTok.
          </p>
          <div className="reuse-video">
            <input
              placeholder="youtube.com/@yourname"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
            />
            <button
              type="button"
              className="pill"
              disabled={listing || !channel.trim()}
              onClick={() => void loadShorts()}
            >
              {listing ? 'Reading' : 'List'}
            </button>
          </div>
          {listError && <p className="warn small">{listError}</p>}
          <ul className="reuse-shorts">
            {shorts.map((s) => (
              <li key={s.id}>
                <span title={s.url}>{s.title || s.id}</span>
                <button type="button" className="btn ghost" onClick={() => reuse(s)}>
                  Reuse
                </button>
                {s.views && <span className="muted small">{s.views}</span>}
              </li>
            ))}
          </ul>
        </aside>
      </div>
      {picking && (
        <MediaPicker
          brandId={brand.id}
          multiple={false}
          kind="video"
          onClose={() => setPicking(false)}
          onPick={(items) => {
            setPicking(false)
            if (items[0]) void pick(items[0].id)
          }}
        />
      )}
    </div>
  )
}
