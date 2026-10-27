import { useState, type ReactNode } from 'react'
import { formatReview, reviewTime, type ReviewComment, type VideoCard as Card } from '@shared/cards'
import VideoReview, { type DraftComment } from '../VideoReview'
import { cleanError, type CardActions } from './useCards'

// saves each comment's frame in main and swaps in its id, then the review goes to the agent
export async function sendReview(
  brandId: string,
  cardId: string,
  projectId: string,
  file: string,
  projectName: string,
  drafts: DraftComment[],
  send: (text: string) => Promise<void>
): Promise<void> {
  const comments: ReviewComment[] = []
  for (const d of drafts) {
    const { frameDataUrl, ...c } = d
    if (frameDataUrl) {
      c.frameId = await window.trenddeckCards.saveFrame(brandId, cardId, {
        dataUrl: frameDataUrl,
        timeSeconds: c.from,
        width: c.frameWidth ?? 0,
        height: c.frameHeight ?? 0,
        box: c.box ?? null
      })
    }
    comments.push(c)
  }
  await send(formatReview({ cardId, projectId, file, comments }, projectName))
}

export default function VideoCard({ card, a }: { card: Card; a: CardActions }): ReactNode {
  const [note, setNote] = useState('')
  const src = window.trenddeckCards.projectFileUrl(a.brand.id, card.media)
  const project = a.brand.projects.find((p) => p.id === card.media.projectId)

  // opens FilmCraft on the project in the chat, then asks the agent to put the playhead there
  const openAt = async (time: number): Promise<void> => {
    setNote('')
    try {
      await window.trenddeckCraft.open({ appId: 'filmcraft', brandId: a.brand.id, projectId: card.media.projectId, file: null })
      if (a.hasAgent) {
        await a.sendToAgent(
          `I opened FilmCraft on this project. Put its playhead at ${reviewTime(time)} (${Math.round(time * 1000) / 1000} s), the spot I'm looking at in ${card.media.file}.`
        )
      }
      setNote(`FilmCraft is open. ${a.hasAgent ? 'Your agent will move the playhead.' : ''}`.trim())
    } catch (err) {
      setNote(cleanError(err))
    }
  }

  return (
    <article className="cx-card2" aria-label={`Video ${card.title}`}>
      <header className="cx-card2-head">
        <strong>{card.title}</strong>
        <span className="muted">{card.auto ? 'New render' : card.media.file}</span>
      </header>
      {card.note && <p className="cx-card2-body">{card.note}</p>}
      {card.media.kind === 'video' ? (
        <VideoReview
          src={src}
          name={card.media.file}
          initialRange={{ from: card.from, to: card.to }}
          onSend={(drafts) => sendReview(a.brand.id, card.id, card.media.projectId, card.media.file, project?.name ?? '', drafts, a.sendToAgent)}
          actions={(time) => (
            <button type="button" onClick={() => void openAt(time)} title="Open FilmCraft on this project at this time">
              Open in FilmCraft here
            </button>
          )}
        />
      ) : card.media.kind === 'image' ? (
        <img className="cx-card2-image" src={src} alt={card.title} />
      ) : (
        <audio controls preload="metadata" src={src} aria-label={card.title} />
      )}
      {note && <p className="cx-card2-note">{note}</p>}
    </article>
  )
}
