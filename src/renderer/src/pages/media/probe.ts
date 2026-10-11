import { mediaUrl, type MediaItem, type MediaProbe } from '@shared/media'

const THUMB_W = 320
const TIMEOUT_MS = 15000

function draw(el: CanvasImageSource, w: number, h: number): string | null {
  if (!w || !h) return null
  const scale = Math.min(1, THUMB_W / w)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(w * scale)
  canvas.height = Math.round(h * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(el, 0, 0, canvas.width, canvas.height)
  try {
    return canvas.toDataURL('image/jpeg', 0.75)
  } catch {
    return null
  }
}

function withTimeout(run: (done: (p: MediaProbe) => void) => () => void): Promise<MediaProbe> {
  return new Promise((resolve) => {
    let cleanup = (): void => {}
    const timer = setTimeout(() => finish({ duration: null, width: null, height: null, thumb: null }), TIMEOUT_MS)
    function finish(p: MediaProbe): void {
      clearTimeout(timer)
      cleanup()
      resolve(p)
    }
    cleanup = run(finish)
  })
}

// the platform's own video element grabs the poster frame, no ffmpeg
function probeVideo(src: string, audioOnly: boolean): Promise<MediaProbe> {
  return withTimeout((done) => {
    const v = document.createElement(audioOnly ? 'audio' : 'video') as HTMLVideoElement
    v.crossOrigin = 'anonymous'
    v.muted = true
    v.preload = 'metadata'
    const fail = (): void => done({ duration: null, width: null, height: null, thumb: null })
    v.onerror = fail
    v.onloadedmetadata = () => {
      const duration = isFinite(v.duration) ? v.duration : null
      if (audioOnly) {
        done({ duration, width: null, height: null, thumb: null })
        return
      }
      // a second in skips most black first frames
      v.currentTime = duration ? Math.min(1, duration * 0.1) : 0
    }
    v.onseeked = () => {
      const w = v.videoWidth || null
      const h = v.videoHeight || null
      done({
        duration: isFinite(v.duration) ? v.duration : null,
        width: w,
        height: h,
        thumb: w && h ? draw(v, w, h) : null
      })
    }
    v.src = src
    return () => {
      v.removeAttribute('src')
      v.load()
    }
  })
}

function probeImage(src: string): Promise<MediaProbe> {
  return withTimeout((done) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = () => {
      const w = img.naturalWidth || null
      const h = img.naturalHeight || null
      done({ duration: null, width: w, height: h, thumb: w && h ? draw(img, w, h) : null })
    }
    img.onerror = () => done({ duration: null, width: null, height: null, thumb: null })
    img.src = src
    return () => {
      img.src = ''
    }
  })
}

const queued = new Set<string>()
let chain: Promise<void> = Promise.resolve()

// one file at a time so a big import doesn't open fifty decoders at once
export function probeLater(items: MediaItem[]): void {
  for (const item of items) {
    if (item.probed || item.missing || queued.has(item.id)) continue
    queued.add(item.id)
    chain = chain.then(async () => {
      const src = mediaUrl(item.brandId, item.id)
      let probe: MediaProbe = { duration: null, width: null, height: null, thumb: null }
      if (item.kind === 'video') probe = await probeVideo(src, false)
      else if (item.kind === 'audio') probe = await probeVideo(src, true)
      else if (item.kind === 'image') probe = await probeImage(src)
      await window.trenddeck.media.setProbe(item.brandId, item.id, probe).catch(() => {})
      queued.delete(item.id)
    })
  }
}
