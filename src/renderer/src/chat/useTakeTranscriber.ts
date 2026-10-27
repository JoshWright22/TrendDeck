import { useEffect } from 'react'
import type { ChatCard, TakeCard } from '@shared/cards'
import { transcribePcm } from '../dictation/engine'
import { cleanError } from '../plain-error'

// takes are transcribed here, in the window, because Whisper runs in the window's worker. main
// makes the card and pulls the audio out with ffmpeg; this takes the brand's waiting takes one at
// a time, whichever chat they are in, and hands the words back

const running = new Set<string>()
let queue: Promise<void> = Promise.resolve()

function transcribe(card: TakeCard): void {
  if (running.has(card.id)) return
  running.add(card.id)
  queue = queue.then(async () => {
    try {
      const bytes = await window.trenddeckTakes.audio(card.brandId, card.id)
      const t = await transcribePcm(new Float32Array(bytes))
      await window.trenddeckTakes.setTranscript(card.brandId, card.id, t)
    } catch (err) {
      const message = cleanError(err, "Couldn't transcribe this take.")
      await window.trenddeckTakes.setTranscript(card.brandId, card.id, null, message).catch(() => {})
    } finally {
      running.delete(card.id)
    }
  })
}

const waiting = (c: ChatCard): c is TakeCard => c.type === 'take' && c.state === 'transcribing'

export function useTakeTranscriber(brandId: string, visible: ChatCard[]): void {
  // takes made while another chat is open still get done
  useEffect(
    () =>
      window.trenddeckCards.onChanged(({ brandId: b, card }) => {
        if (b === brandId && waiting(card)) transcribe(card)
      }),
    [brandId]
  )
  // and ones left waiting from before, when their chat opens
  useEffect(() => {
    for (const c of visible) if (waiting(c)) transcribe(c)
  }, [visible])
}
