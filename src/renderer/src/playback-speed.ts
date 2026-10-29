// videos and recordings in TrendDeck play at the preview speed, 2x unless you or the agent change
// it (main/preview-speed.ts, the Craft editor uses the same one). each player's own menu still
// changes it for that one. only playback here, exports and renders keep their real speed
let rate = 2

const apply = (el: HTMLMediaElement): void => {
  if (el.dataset.keepRate === 'true' || el.srcObject) return
  el.defaultPlaybackRate = rate
  el.playbackRate = rate
  // a voice sped up keeps its pitch
  el.preservesPitch = true
}

// every <video> and <audio> as it loads, the media events don't bubble so this listens on capture
export function applyPlaybackSpeed(root: Document = document): void {
  root.addEventListener(
    'loadstart',
    (e) => {
      if (e.target instanceof HTMLMediaElement) apply(e.target)
    },
    true
  )
  const api = window.trenddeckCards
  if (!api?.previewSpeed) return
  const set = (n: number): void => {
    if (!(n > 0)) return
    rate = n
    root.querySelectorAll('video, audio').forEach((el) => apply(el as HTMLMediaElement))
  }
  void api.previewSpeed().then(set, () => {})
  api.onPreviewSpeed(set)
}
