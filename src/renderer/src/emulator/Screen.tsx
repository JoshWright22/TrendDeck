import { useEffect, useRef, type ReactNode } from 'react'
import type { PhoneInput, PhoneKey } from '@shared/emulator'
import { H264Player } from './h264'

interface Props {
  brandId: string
  on: boolean
}

const KEYS: Record<string, PhoneKey> = {
  Backspace: 'del',
  Enter: 'enter',
  Escape: 'back',
  Tab: 'tab',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right'
}

// the phone's screen, grabbed one frame at a time and drawn into a canvas
export default function Screen({ brandId, on }: Props): ReactNode {
  const canvas = useRef<HTMLCanvasElement>(null)
  const api = window.trenddeck.emulator

  useEffect(() => {
    if (!on) return
    let alive = true
    let grabbing = false
    // set once video has drawn a frame, the grabs stop then
    let drawn = false
    let videoDead = false

    // fallback: one raw screen grab at a time, slow but works everywhere
    const grabLoop = async (): Promise<void> => {
      if (grabbing) return
      grabbing = true
      while (alive && !(drawn && !videoDead)) {
        // nothing to draw into while the window is hidden, so don't grab
        if (document.hidden) {
          await new Promise((r) => setTimeout(r, 500))
          continue
        }
        const frame = await api.frame(brandId).catch(() => null)
        const c = canvas.current
        if (!alive || (drawn && !videoDead)) break
        if (!frame || !c) {
          await new Promise((r) => setTimeout(r, 500))
          continue
        }
        if (c.width !== frame.width) c.width = frame.width
        if (c.height !== frame.height) c.height = frame.height
        const px = new Uint8ClampedArray(frame.pixels.buffer as ArrayBuffer, frame.pixels.byteOffset, frame.pixels.byteLength)
        c.getContext('2d')?.putImageData(new ImageData(px, frame.width, frame.height), 0, 0)
        await new Promise((r) => requestAnimationFrame(r))
      }
      grabbing = false
    }

    if (!H264Player.supported()) {
      void grabLoop()
      return () => {
        alive = false
      }
    }

    // grabs show something right away, video takes over once its first frame lands
    void grabLoop()
    const fallback = (): void => {
      if (!alive || videoDead) return
      videoDead = true
      void api.stream(brandId, false)
      player.close()
      void grabLoop()
    }
    const player = new H264Player((frame) => {
      const c = canvas.current
      if (!c) return
      drawn = true
      if (c.width !== frame.displayWidth) c.width = frame.displayWidth
      if (c.height !== frame.displayHeight) c.height = frame.displayHeight
      c.getContext('2d')?.drawImage(frame, 0, 0)
    }, fallback)
    const off = api.onVideo((id, chunk) => {
      if (id !== brandId || videoDead) return
      if (chunk === null) fallback()
      else player.push(chunk)
    })
    void api.stream(brandId, true).catch(fallback)
    // no video picture after a while means it doesn't work on this phone, keep grabbing
    const timer = window.setTimeout(() => {
      if (!drawn) fallback()
    }, 30000)
    return () => {
      alive = false
      window.clearTimeout(timer)
      off()
      player.close()
      void api.stream(brandId, false).catch(() => {})
    }
  }, [on, brandId, api])

  const send = (input: PhoneInput): void => {
    void api.input(brandId, input).catch(() => {})
  }

  // canvas pixels are phone pixels, the element is just scaled to fit
  const toPhone = (e: { clientX: number; clientY: number }): [number, number] => {
    const c = canvas.current
    if (!c) return [0, 0]
    const r = c.getBoundingClientRect()
    return [((e.clientX - r.left) * c.width) / r.width, ((e.clientY - r.top) * c.height) / r.height]
  }

  const down = useRef<{ x: number; y: number; at: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.focus()
    const [x, y] = toPhone(e)
    down.current = { x, y, at: performance.now() }
  }
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const start = down.current
    down.current = null
    if (!start) return
    const [x, y] = toPhone(e)
    const ms = Math.round(performance.now() - start.at)
    const moved = Math.hypot(x - start.x, y - start.y)
    if (moved < 12 && ms < 450) send({ type: 'tap', x, y })
    // holding still is a long press, a swipe to the same spot
    else send({ type: 'swipe', x1: start.x, y1: start.y, x2: x, y2: y, ms: Math.max(ms, 80) })
  }

  // wheel scrolls turn into one swipe once the wheel stops
  const wheel = useRef<{ dy: number; x: number; y: number; timer: number } | null>(null)
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>): void => {
    const [x, y] = toPhone(e)
    const w = wheel.current ?? { dy: 0, x, y, timer: 0 }
    w.dy += e.deltaY
    window.clearTimeout(w.timer)
    w.timer = window.setTimeout(() => {
      const c = canvas.current
      wheel.current = null
      if (!c) return
      const dist = Math.max(-c.height * 0.6, Math.min(c.height * 0.6, w.dy * 1.5))
      const y2 = Math.max(1, Math.min(c.height - 1, w.y - dist))
      send({ type: 'swipe', x1: w.x, y1: w.y, x2: w.x, y2, ms: 200 })
    }, 120)
    wheel.current = w
  }

  // typed letters go out in small batches, one adb command per key is slow
  const typed = useRef({ text: '', timer: 0 })
  const flush = (): void => {
    const t = typed.current
    window.clearTimeout(t.timer)
    if (t.text) send({ type: 'text', text: t.text })
    t.text = ''
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const key = KEYS[e.key]
    if (key) {
      e.preventDefault()
      flush()
      send({ type: 'key', key })
      return
    }
    if (e.key.length === 1) {
      e.preventDefault()
      const t = typed.current
      t.text += e.key
      window.clearTimeout(t.timer)
      t.timer = window.setTimeout(flush, 120)
    }
  }
  const onPaste = (e: React.ClipboardEvent<HTMLCanvasElement>): void => {
    const text = e.clipboardData.getData('text')
    if (text) {
      flush()
      send({ type: 'text', text })
    }
  }

  return (
    <canvas
      ref={canvas}
      className="phone-canvas"
      tabIndex={0}
      width={720}
      height={1520}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (down.current = null)}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onContextMenu={(e) => {
        e.preventDefault()
        send({ type: 'key', key: 'back' })
      }}
    />
  )
}
