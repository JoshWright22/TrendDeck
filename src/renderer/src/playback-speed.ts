// videos and recordings in TrendDeck play at 2x by default, you watch faster than you talk. each
// player's own menu still changes it for that one. only playback here, exports and renders keep
// their real speed
const KEY = 'trenddeck.playbackRate'
export const DEFAULT_RATE = 2

export function playbackRate(): number {
  const n = Number(localStorage.getItem(KEY))
  return n >= 0.25 && n <= 4 ? n : DEFAULT_RATE
}

export function setPlaybackRate(n: number): void {
  if (n >= 0.25 && n <= 4) localStorage.setItem(KEY, String(n))
}

// every <video> and <audio> as it loads, the media events don't bubble so this listens on capture
export function applyPlaybackSpeed(root: Document = document): void {
  root.addEventListener(
    'loadstart',
    (e) => {
      const el = e.target
      if (!(el instanceof HTMLMediaElement) || el.dataset.keepRate === 'true') return
      const r = playbackRate()
      el.defaultPlaybackRate = r
      el.playbackRate = r
      // a voice sped up keeps its pitch
      el.preservesPitch = true
    },
    true
  )
}
