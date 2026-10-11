import { promises as fs } from 'node:fs'
import type { VideoInfo } from '@shared/reuse'

// reads just enough of an mp4/mov to get length and frame size, no ffmpeg
// only the moov box is read, it's small even for big files

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl'])

interface Found {
  seconds: number
  width: number
  height: number
}

function walk(buf: Buffer, start: number, end: number, out: Found, track: { video: boolean; w: number; h: number }): void {
  let pos = start
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    let head = 8
    if (size === 1 && pos + 16 <= end) {
      size = Number(buf.readBigUInt64BE(pos + 8))
      head = 16
    } else if (size === 0) size = end - pos
    if (size < head || pos + size > end) return
    const body = pos + head
    if (type === 'mvhd') {
      const v = buf[body]
      const scale = v === 1 ? buf.readUInt32BE(body + 20) : buf.readUInt32BE(body + 12)
      const dur = v === 1 ? Number(buf.readBigUInt64BE(body + 24)) : buf.readUInt32BE(body + 16)
      if (scale) out.seconds = dur / scale
    } else if (type === 'tkhd') {
      // width and height are the last 8 bytes, 16.16 fixed point
      track.w = buf.readUInt32BE(pos + size - 8) / 65536
      track.h = buf.readUInt32BE(pos + size - 4) / 65536
      // rotation matrix, a 90 degree turn swaps the sides
      const v = buf[body]
      const m = body + (v === 1 ? 52 : 40)
      const a = buf.readInt32BE(m)
      const b = buf.readInt32BE(m + 4)
      if (a === 0 && b !== 0) [track.w, track.h] = [track.h, track.w]
    } else if (type === 'hdlr') {
      track.video = buf.toString('latin1', body + 8, body + 12) === 'vide'
    } else if (type === 'trak') {
      const t = { video: false, w: 0, h: 0 }
      walk(buf, body, pos + size, out, t)
      if (t.video && t.w && t.h && !out.width) {
        out.width = Math.round(t.w)
        out.height = Math.round(t.h)
      }
    } else if (CONTAINERS.has(type)) {
      walk(buf, body, pos + size, out, track)
    }
    pos += size
  }
}

export function parseMoov(buf: Buffer): Found {
  const out: Found = { seconds: 0, width: 0, height: 0 }
  walk(buf, 0, buf.length, out, { video: false, w: 0, h: 0 })
  return out
}

export async function probeVideo(path: string): Promise<VideoInfo> {
  const info: VideoInfo = { path, bytes: 0, seconds: 0, width: 0, height: 0, error: '' }
  let fh: fs.FileHandle | null = null
  try {
    fh = await fs.open(path, 'r')
    info.bytes = (await fh.stat()).size
    // find moov at the top level, then read only it
    let pos = 0
    const head = Buffer.alloc(16)
    while (pos + 8 <= info.bytes) {
      await fh.read(head, 0, 16, pos)
      let size = head.readUInt32BE(0)
      const type = head.toString('latin1', 4, 8)
      if (size === 1) size = Number(head.readBigUInt64BE(8))
      else if (size === 0) size = info.bytes - pos
      if (size < 8) break
      if (type === 'moov') {
        if (size > 64 * 1024 * 1024) throw new Error('moov too big')
        const buf = Buffer.alloc(size)
        await fh.read(buf, 0, size, pos)
        const f = parseMoov(buf)
        Object.assign(info, f)
        break
      }
      pos += size
    }
    if (!info.seconds) info.error = "Couldn't read the video length, only mp4 and mov are checked"
  } catch (e) {
    info.error = e instanceof Error && 'code' in e ? `Can't open the file (${String((e as NodeJS.ErrnoException).code)})` : "Couldn't read the video"
  } finally {
    await fh?.close()
  }
  return info
}
