import { useEffect, useState, type ReactNode } from 'react'
import { mediaUrl, type MediaInfo } from '@shared/media'
import VideoReview from './VideoReview'

export default function MediaReview({ brandId, mediaId, revision, onFeedback }: {
  brandId: string
  mediaId: string
  revision?: string
  onFeedback: (text: string) => void
}): ReactNode {
  const [media, setMedia] = useState<MediaInfo | null>(null)
  const [status, setStatus] = useState('Loading media?')
  useEffect(() => {
    let active = true
    let sequence = 0
    setMedia(null)
    setStatus('Loading media?')
    const load = (): void => {
      const request = ++sequence
      void window.trenddeck.media.list(brandId, {}).then((items) => {
        if (!active || request !== sequence) return
        const item = items.find((entry) => entry.id === mediaId && entry.brandId === brandId && entry.agentAllowed && !entry.missing)
        setMedia(item ?? null)
        setStatus(item ? '' : 'This media is missing or is not shared with the agent. Check this brand?s media library.')
      }).catch(() => {
        if (active && request === sequence) { setMedia(null); setStatus('Could not load this media. Try again from the media library.') }
      })
    }
    load()
    const unsubscribe = window.trenddeck.media.onChange((changedBrand) => { if (changedBrand === brandId) load() })
    return () => { active = false; unsubscribe() }
  }, [brandId, mediaId])
  if (!media) return <p className="muted" role="status">{status}</p>
  const source = mediaUrl(brandId, mediaId)
  const intent = (action: string): void => onFeedback(`${action}\nMedia: ${media.name}.${media.ext}\nMedia ID: ${media.id}${revision ? `\nRevision: ${revision}` : ''}\nConfirm the target project, timeline position and current revision before changing the edit. Keep the source footage intact.`)
  return (
    <section className="cx-media-review" aria-label={`Review ${media.name}`}>
      {media.kind === 'video' ? <VideoReview src={source} name={`${media.name}.${media.ext}`} clipId={media.id} revision={revision} onFeedback={onFeedback} />
        : media.kind === 'audio' ? <audio controls preload="metadata" src={source} aria-label={media.name} />
          : media.kind === 'image' ? <img src={source} alt={media.name} style={{ maxWidth: '100%', maxHeight: 320 }} />
            : <p>{media.name}.{media.ext}</p>}
      <div className="cx-media-actions">
        <button type="button" className="ws-head-btn" onClick={() => intent('Review this media without changing the timeline.')}>Ask about it</button>
        <button type="button" className="ws-head-btn" onClick={() => intent('Insert this media at the editor playhead. If no playhead is available, ask me for the destination.')}>Ask agent to insert</button>
        <button type="button" className="ws-head-btn" onClick={() => intent('Replace the selected timeline section with this media. If there is no selection, ask me to select one first.')}>Ask agent to replace selection</button>
      </div>
    </section>
  )
}
