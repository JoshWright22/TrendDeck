// cuts long audio into pieces at quiet moments, for models without their own chunking (Moonshine)
// and for API uploads that have a size limit. framework-free, used by the worker and the engine

export interface Piece {
  // sample offsets, end exclusive
  start: number
  end: number
}

// pieces of at most maxSec, each cut at the quietest 50 ms in the last searchSec of the window
export function splitAtPauses(pcm: Float32Array, rate: number, maxSec: number, searchSec = Math.min(5, maxSec / 3)): Piece[] {
  const max = Math.floor(maxSec * rate)
  if (pcm.length <= max) return [{ start: 0, end: pcm.length }]
  const frame = Math.max(1, Math.floor(rate * 0.05))
  const search = Math.floor(searchSec * rate)
  const pieces: Piece[] = []
  let start = 0
  while (pcm.length - start > max) {
    const limit = start + max
    let best = limit
    let bestEnergy = Infinity
    for (let at = limit - search; at + frame <= limit; at += frame) {
      let e = 0
      for (let i = at; i < at + frame; i++) e += pcm[i] * pcm[i]
      if (e < bestEnergy) {
        bestEnergy = e
        best = at + Math.floor(frame / 2)
      }
    }
    pieces.push({ start, end: best })
    start = best
  }
  pieces.push({ start, end: pcm.length })
  return pieces
}

// nothing worth transcribing: peak below about -40 dBFS
export function isSilent(pcm: Float32Array): boolean {
  for (let i = 0; i < pcm.length; i++) if (Math.abs(pcm[i]) > 0.01) return false
  return true
}
