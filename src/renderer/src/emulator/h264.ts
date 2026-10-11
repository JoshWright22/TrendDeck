// turns the raw h264 byte stream from screenrecord into frames with the browser's own decoder

type Draw = (frame: VideoFrame) => void

const START = [0, 0, 1]

function hex(n: number): string {
  return n.toString(16).padStart(2, '0')
}

export class H264Player {
  private buf = new Uint8Array(0)
  private decoder: VideoDecoder | null = null
  // sps, pps and sei waiting to go out with the next frame
  private prefix: Uint8Array[] = []
  private gotKey = false
  private ts = 0
  private idle = 0
  failed = false

  constructor(
    private draw: Draw,
    private onFail: () => void
  ) {}

  static supported(): boolean {
    return typeof VideoDecoder !== 'undefined'
  }

  push(chunk: Uint8Array): void {
    if (this.failed) return
    const next = new Uint8Array(this.buf.length + chunk.length)
    next.set(this.buf)
    next.set(chunk, this.buf.length)
    this.buf = next
    this.split()
    // screenrecord only sends when the screen changes, so a quiet stream means the last
    // nal unit is complete even though no start code came after it
    window.clearTimeout(this.idle)
    this.idle = window.setTimeout(() => this.flushTail(), 25)
  }

  private flushTail(): void {
    const b = this.buf
    if (this.failed || b.length < 4) return
    const skip = b[2] === 1 ? 3 : b[3] === 1 ? 4 : 0
    if (!skip) return
    this.buf = new Uint8Array(0)
    this.nal(b.subarray(skip))
  }

  // every nal unit starts with 00 00 01 (or 00 00 00 01), the last one waits for more bytes
  private split(): void {
    const b = this.buf
    const starts: number[] = []
    for (let i = 0; i + 2 < b.length; i++) {
      if (b[i] === START[0] && b[i + 1] === START[1] && b[i + 2] === START[2]) {
        starts.push(i + 3)
        i += 2
      }
    }
    if (starts.length < 2) return
    for (let n = 0; n < starts.length - 1; n++) {
      let end = starts[n + 1] - 3
      if (end > 0 && b[end - 1] === 0) end--
      this.nal(b.subarray(starts[n], end))
    }
    this.buf = b.slice(starts[starts.length - 1] - 3)
  }

  private nal(body: Uint8Array): void {
    if (body.length === 0) return
    const type = body[0] & 0x1f
    const withStart = new Uint8Array(body.length + 4)
    withStart.set([0, 0, 0, 1])
    withStart.set(body, 4)
    if (type === 7) {
      this.configure(body)
      this.prefix = [withStart]
      return
    }
    if (type === 8 || type === 6) {
      this.prefix.push(withStart)
      return
    }
    if (type !== 1 && type !== 5) return
    const key = type === 5
    if (!key && !this.gotKey) return
    if (key) this.gotKey = true
    const parts = [...this.prefix, withStart]
    this.prefix = []
    const size = parts.reduce((n, p) => n + p.length, 0)
    const data = new Uint8Array(size)
    let at = 0
    for (const p of parts) {
      data.set(p, at)
      at += p.length
    }
    if (!this.decoder || this.decoder.state !== 'configured') return
    // 30 fps worth of time per frame, screenrecord doesn't give us its own clock here
    this.ts += 33333
    try {
      this.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: this.ts, data }))
    } catch {
      this.fail()
    }
  }

  private configure(sps: Uint8Array): void {
    if (sps.length < 4) return
    const codec = `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`
    if (this.decoder && this.decoder.state === 'configured') return
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.draw(frame)
        frame.close()
      },
      error: () => this.fail()
    })
    // no description means the chunks are annex b, the way screenrecord sends them
    this.decoder.configure({ codec, optimizeForLatency: true })
  }

  private fail(): void {
    if (this.failed) return
    this.failed = true
    this.close()
    this.onFail()
  }

  close(): void {
    window.clearTimeout(this.idle)
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close()
    this.decoder = null
  }
}
