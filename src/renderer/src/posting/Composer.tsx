import { useEffect, useState, type ReactNode } from 'react'
import type { Brand } from '@shared/types'
import {
  PLATFORMS,
  PLATFORM_NAMES,
  PLATFORM_RULES,
  type BrandPosting,
  type Platform,
  type PostItem,
  type Visibility
} from '@shared/posting'
import Modal from '../components/Modal'
import MediaPicker from '../pages/media/MediaPicker'

interface Props {
  brand: Brand
  settings: BrandPosting
  // null makes a new post, otherwise this is the review screen for one
  post: PostItem | null
  onClose: () => void
}

const pad = (n: number): string => String(n).padStart(2, '0')

function toLocalInput(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

type When = 'now' | 'later' | 'draft'

export default function Composer({ brand, settings, post, onClose }: Props): ReactNode {
  const [platforms, setPlatforms] = useState<Platform[]>(post ? [post.platform] : [])
  const [title, setTitle] = useState(post?.title ?? '')
  const [body, setBody] = useState(post?.body ?? '')
  // a media library id, posting turns it into a file itself
  const [mediaId, setMediaId] = useState(post?.mediaId ?? '')
  const [mediaName, setMediaName] = useState('')
  const [picking, setPicking] = useState(false)
  const [mediaUrl, setMediaUrl] = useState(post?.mediaUrl ?? '')
  const [subreddit, setSubreddit] = useState(post?.subreddit || brand.subreddits[0] || '')
  const [visibility, setVisibility] = useState<Visibility>(post?.visibility ?? 'public')
  const [mode, setMode] = useState<When>(post?.scheduledAt ? 'later' : post ? 'draft' : 'now')
  const [at, setAt] = useState(toLocalInput(post?.scheduledAt ?? Date.now() + 60 * 60 * 1000))
  const [error, setError] = useState('')

  // name for a post that already had a file
  useEffect(() => {
    if (!post?.mediaId) return
    void window.trenddeck.media.list(brand.id, {}).then((l) => {
      const m = l.find((x) => x.id === post.mediaId)
      setMediaName(m ? `${m.name}${m.ext ? `.${m.ext}` : ''}` : 'not in Media anymore')
    })
  }, [brand.id, post?.mediaId])

  const has = (p: Platform): boolean => platforms.includes(p)
  const anyTitle = platforms.some((p) => PLATFORM_RULES[p].needsTitle)
  const igApi = has('instagram') && settings.modes.instagram === 'api'
  const bodyMax = platforms.length ? Math.min(...platforms.map((p) => PLATFORM_RULES[p].bodyMax)) : 0
  const titleMax = Math.min(...platforms.map((p) => PLATFORM_RULES[p].titleMax || 300), 300)

  // what's missing per platform, shown before anything is saved
  const issues: string[] = []
  for (const p of platforms) {
    const r = PLATFORM_RULES[p]
    const name = PLATFORM_NAMES[p]
    const apiIg = p === 'instagram' && settings.modes.instagram === 'api'
    if (r.needsMedia && !mediaId && !apiIg) issues.push(`${name} needs an image or video`)
    if (apiIg && !mediaUrl) issues.push('Instagram api mode needs a public link to the media')
    if (r.needsTitle && !title.trim()) issues.push(`${name} needs a title`)
    if (r.titleMax && title.length > r.titleMax) issues.push(`${name} titles stop at ${r.titleMax}`)
    if (body.length > r.bodyMax) issues.push(`${name} text stops at ${r.bodyMax}`)
    if (p === 'reddit' && !subreddit) issues.push('Reddit needs a subreddit')
  }

  const save = async (): Promise<void> => {
    if (!platforms.length) return setError('Pick at least one site')
    if (mode !== 'draft' && issues.length) return setError(issues[0])
    const scheduledAt = mode === 'later' ? new Date(at).getTime() : null
    if (mode === 'later' && (!scheduledAt || scheduledAt < Date.now() - 60000)) {
      return setError('Pick a time in the future')
    }
    const now = Date.now()
    const posts: PostItem[] = platforms.map((platform) => ({
      id: post?.id ?? crypto.randomUUID(),
      brandId: brand.id,
      platform,
      title: title.trim(),
      body: body.trim(),
      mediaId,
      byAgent: post?.byAgent ?? false,
      mediaUrl: mediaUrl.trim(),
      subreddit: subreddit.replace(/^r\//i, '').trim(),
      visibility,
      scheduledAt,
      status: mode === 'later' ? 'scheduled' : 'draft',
      createdAt: post?.createdAt ?? now,
      updatedAt: now,
      note: '',
      url: ''
    }))
    await window.trenddeck.posting.save(posts)
    if (mode === 'now') for (const p of posts) await window.trenddeck.posting.run(p.id)
    onClose()
  }


  return (
    <>
    <Modal title={post ? `Review for ${PLATFORM_NAMES[post.platform]}` : 'New post'} onClose={onClose}>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        {!post && (
          <div className="field">
            <span className="field-name">Post to</span>
            <div className="platform-picks">
              {PLATFORMS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`filter-chip${has(p) ? ' on' : ''}`}
                  aria-pressed={has(p)}
                  onClick={() => setPlatforms((all) => (has(p) ? all.filter((x) => x !== p) : [...all, p]))}
                >
                  {PLATFORM_NAMES[p]}
                </button>
              ))}
            </div>
          </div>
        )}

        {anyTitle && (
          <label>
            Title
            <input value={title} maxLength={titleMax} onChange={(e) => setTitle(e.target.value)} />
          </label>
        )}

        <label>
          {has('youtube') ? 'Caption or description' : 'Caption or post text'}
          <textarea value={body} rows={5} onChange={(e) => setBody(e.target.value)} />
          {bodyMax > 0 && (
            <span className={`count-line${body.length > bodyMax ? ' over' : ''}`}>
              {body.length} / {bodyMax}
            </span>
          )}
        </label>

        <div className="field">
          <span className="field-name">Image or video</span>
          <div className="media-row">
            <button type="button" className="pill" onClick={() => setPicking(true)}>
              {mediaId ? 'Change' : 'Pick from Media'}
            </button>
            {mediaId ? (
              <>
                <span className="media-name">{mediaName}</span>
                <button type="button" className="btn ghost" onClick={() => setMediaId('')}>
                  Remove
                </button>
              </>
            ) : (
              <span className="muted small">None, text only</span>
            )}
          </div>
        </div>

        {igApi && (
          <label>
            Public link to the media (Instagram api)
            <input
              value={mediaUrl}
              placeholder="https://..."
              spellCheck={false}
              onChange={(e) => setMediaUrl(e.target.value)}
            />
          </label>
        )}

        {has('reddit') && (
          <label>
            Subreddit
            <input
              value={subreddit}
              list="posting-subs"
              placeholder="without the r/"
              spellCheck={false}
              onChange={(e) => setSubreddit(e.target.value.replace(/[^A-Za-z0-9_/]/g, ''))}
            />
            <datalist id="posting-subs">
              {brand.subreddits.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </label>
        )}

        {(has('youtube') || has('tiktok')) && (
          <label>
            Who can see it on {has('youtube') ? 'YouTube' : 'TikTok'}
            <select value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)}>
              <option value="public">Public</option>
              {has('youtube') && <option value="unlisted">Unlisted</option>}
              <option value="private">Private</option>
            </select>
          </label>
        )}

        <div className="field">
          <span className="field-name">When</span>
          <div className="platform-picks">
            {(['now', 'later', 'draft'] as When[]).map((w) => (
              <button
                key={w}
                type="button"
                className={`filter-chip${mode === w ? ' on' : ''}`}
                aria-pressed={mode === w}
                onClick={() => setMode(w)}
              >
                {w === 'now' ? 'Now' : w === 'later' ? 'Later' : 'Save for later'}
              </button>
            ))}
            {mode === 'later' && (
              <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
            )}
          </div>
          {mode === 'later' && (
            <p className="form-hint">Scheduled posts go out while TrendDeck is open.</p>
          )}
        </div>

        {issues.length > 0 && (
          <ul className="issues">
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          <span className="muted small">
            {settings.autoPost ? 'The app presses Post itself' : 'Stops at Post for you to check'}
          </span>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            {mode === 'now' ? 'Post' : mode === 'later' ? 'Schedule' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
    {picking && (
      <MediaPicker
        brandId={brand.id}
        multiple={false}
        onClose={() => setPicking(false)}
        onPick={(items) => {
          const m = items[0]
          if (m) {
            setMediaId(m.id)
            setMediaName(`${m.name}${m.ext ? `.${m.ext}` : ''}`)
          }
          setPicking(false)
        }}
      />
    )}
    </>
  )
}
