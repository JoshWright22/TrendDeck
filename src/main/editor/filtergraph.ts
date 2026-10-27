import {
  clipSpans,
  effectDef,
  evalEffect,
  evalParam,
  itemEnd,
  sourceTimeAt,
  ticksToSeconds,
  type CaptionTrack,
  type Ease,
  type EffectInstance,
  type GraphicItem,
  type Keyframe,
  type MediaItem,
  type ParamValue,
  type Project,
  type SequenceItem,
  type Tick,
  type TrackItem,
  getSequence
} from '@shared/editor'

// turns a stretch of a sequence into one ffmpeg filter graph. pure: no files are touched here,
// the caller writes `files` into tempDir before running. every clip gets its own input with an
// input-side seek, so a 10 minute timeline doesn't decode from the top for each clip

export interface FontResolver {
  // a font file for drawtext
  file(family: string, bold: boolean, italic: boolean): string
  // a folder libass can scan for caption fonts
  dir: string
}

export interface OutputSize {
  width: number
  height: number
  fit: 'fit' | 'fill'
}

export interface GraphOptions {
  from: Tick
  to: Tick
  tempDir: string
  audio: boolean
  fonts?: FontResolver
  useProxies?: boolean
  output?: OutputSize
}

export interface RenderGraph {
  inputArgs: string[]
  filter: string
  maps: string[]
  files: { name: string; content: string }[]
  warnings: string[]
  seconds: number
}

export const EXPORT_PRESETS = {
  youtube_1080p: { label: 'YouTube 1080p', width: 1920, height: 1080, fit: 'fit', crf: 18, maxrate: '16M', bufsize: '32M', x264Preset: 'medium', audioBitrate: '320k' },
  vertical_1080x1920: { label: 'Shorts / Reels / TikTok', width: 1080, height: 1920, fit: 'fill', crf: 19, maxrate: '12M', bufsize: '24M', x264Preset: 'medium', audioBitrate: '256k' },
  square_1080: { label: 'Square', width: 1080, height: 1080, fit: 'fill', crf: 19, maxrate: '10M', bufsize: '20M', x264Preset: 'medium', audioBitrate: '256k' }
} as const satisfies Record<string, { width: number; height: number; fit: 'fit' | 'fill'; crf: number; maxrate: string; bufsize: string; x264Preset: string; audioBitrate: string; label: string }>

const DEFAULT_FONTS: FontResolver = { file: () => 'C:/Windows/Fonts/arial.ttf', dir: 'C:/Windows/Fonts' }

// numbers in filter args: no exponent, at most 6 decimals
export function n(x: number): string {
  if (!Number.isFinite(x)) return '0'
  const s = (Math.round(x * 1e6) / 1e6).toFixed(6).replace(/\.?0+$/, '')
  return s === '-0' ? '0' : s
}

const secs = (t: Tick): string => n(ticksToSeconds(t))

// a path inside a quoted filter option value
export function filterPath(p: string): string {
  return `'${p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''")}'`
}

// #RRGGBB(AA) to ffmpeg's 0xRRGGBB@alpha, with an extra opacity multiplier
export function ffColor(c: string, opacity = 1): string {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c)
  if (!m) return `black@${n(opacity)}`
  const a = (m[2] ? parseInt(m[2], 16) / 255 : 1) * opacity
  return `0x${m[1].toUpperCase()}@${n(Math.max(0, Math.min(1, a)))}`
}

function easeExpr(e: Ease, x: string): string {
  switch (e) {
    case 'linear':
      return x
    case 'hold':
      return '0'
    case 'ease_in':
      return `pow(${x},2)`
    case 'ease_out':
      return `(1-pow(1-${x},2))`
    case 'ease_in_out':
      return `if(lt(${x},0.5),2*pow(${x},2),1-2*pow(1-${x},2))`
  }
}

// a keyframe track as an ffmpeg expression of time variable v, keys mapped to local seconds
export function keyframeExpr(keys: Keyframe[], toLocal: (t: Tick) => number, v = 't'): string {
  if (keys.length === 0) return '0'
  const pts = keys.map((k) => ({ t: toLocal(k.t), value: k.value, ease: k.ease }))
  if (pts.length === 1) return n(pts[0].value)
  let expr = n(pts[pts.length - 1].value)
  for (let i = pts.length - 2; i >= 0; i--) {
    const a = pts[i]
    const b = pts[i + 1]
    const span = b.t - a.t
    const x = span > 0 ? `((${v}-${n(a.t)})/${n(span)})` : '1'
    const seg = `${n(a.value)}+${n(b.value - a.value)}*${easeExpr(a.ease, x)}`
    expr = `if(lt(${v},${n(b.t)}),${seg},${expr})`
  }
  return `if(lt(${v},${n(pts[0].t)}),${n(pts[0].value)},${expr})`
}

class Builder {
  inputs: string[][] = []
  chains: string[] = []
  files: { name: string; content: string }[] = []
  warnings: string[] = []
  private count = 0

  constructor(
    readonly p: Project,
    readonly seq: SequenceItem,
    readonly o: GraphOptions & { fonts: FontResolver }
  ) {}

  label(prefix: string): string {
    return `${prefix}${this.count++}`
  }

  input(args: string[]): number {
    this.inputs.push(args)
    return this.inputs.length - 1
  }

  file(name: string, content: string): string {
    this.files.push({ name, content })
    return `${this.o.tempDir.replace(/[\\/]+$/, '')}/${name}`
  }

  warn(w: string): void {
    if (!this.warnings.includes(w)) this.warnings.push(w)
  }

  get rate(): string {
    return `${this.seq.fps.num}/${this.seq.fps.den}`
  }

  // seconds from the start of the rendered range, the output's clock
  rel(t: Tick): number {
    return ticksToSeconds(t - this.o.from)
  }

  // seconds on the sequence clock. clip chains run on this so fade starts and keyframe times
  // never go negative when the range starts partway into a clip
  abs(t: Tick): number {
    return Math.max(0, ticksToSeconds(t))
  }

  // the sequence clock as seen from an overlay, whose t is the output's clock
  get seqT(): string {
    return this.o.from ? `(t+${secs(this.o.from)})` : 't'
  }

  mediaPath(m: MediaItem): string {
    return this.o.useProxies && m.proxyPath ? m.proxyPath : m.path
  }
}

interface Fx {
  get(defId: string): EffectInstance | undefined
}

function effects(c: TrackItem): Fx {
  const on = c.effects.filter((f) => f.enabled)
  return { get: (id) => on.find((f) => f.defId === id) }
}

// a param that may be animated, as a constant or an expression of timeline-relative t
function paramExpr(b: Builder, c: TrackItem, fx: EffectInstance | undefined, key: string, fallback: number, v = 't'): { animated: boolean; expr: string; at: number } {
  const def = fx ? effectDef(fx.defId)?.params.find((x) => x.key === key) : undefined
  const pv: ParamValue | undefined = fx?.params[key]
  const at = Number(evalParam(pv, def?.default ?? fallback, c.sourceIn))
  if (pv && 'keyframes' in pv && pv.keyframes.length > 1) {
    const toLocal = (src: Tick): number => b.abs(c.start + Math.round((src - c.sourceIn) / c.speed))
    return { animated: true, expr: keyframeExpr(pv.keyframes, toLocal, v), at }
  }
  return { animated: false, expr: n(at), at }
}

// picture size after fit, before the transform scale
function fitSize(sw: number, sh: number, W: number, H: number, mode: string): [number, number] {
  if (mode === 'none' || !sw || !sh) return [sw || W, sh || H]
  if (mode === 'stretch') return [W, H]
  const k = mode === 'fill' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh)
  return [sw * k, sh * k]
}

const even = (x: number): number => Math.max(2, Math.round(x / 2) * 2)

// the effect chain shared by media and graphics. input is a stream whose pts are already
// timeline-relative; returns filters to append and the overlay position expressions
function pictureChain(b: Builder, c: TrackItem, sw: number, sh: number): { filters: string[]; x: string; y: string; animatedPos: boolean } {
  const fx = effects(c)
  const W = b.seq.width
  const H = b.seq.height
  const filters: string[] = []
  const tf = fx.get('transform')

  const crop = fx.get('crop')
  let cw = sw
  let ch = sh
  if (crop) {
    const v = evalEffect(crop, c.sourceIn)
    if (Object.values(crop.params).some((pv) => 'keyframes' in pv && pv.keyframes.length > 1)) b.warn('animated crop is exported at its first value')
    const l = Number(v.left) / 100
    const r = Number(v.right) / 100
    const t = Number(v.top) / 100
    const bo = Number(v.bottom) / 100
    if (l + r < 1 && t + bo < 1 && l + r + t + bo > 0) {
      filters.push(`crop=w=iw*${n(1 - l - r)}:h=ih*${n(1 - t - bo)}:x=iw*${n(l)}:y=ih*${n(t)}`)
      cw = sw * (1 - l - r)
      ch = sh * (1 - t - bo)
    }
  }

  const fit = tf ? String(evalEffect(tf, c.sourceIn).fit) : 'fit'
  const [fw, fh] = fitSize(cw, ch, W, H, fit)
  const scale = paramExpr(b, c, tf, 'scale', 100)
  if (scale.animated) {
    filters.push(`scale=w='trunc(max(2,${n(fw)}*(${scale.expr})/100)/2)*2':h='trunc(max(2,${n(fh)}*(${scale.expr})/100)/2)*2':eval=frame`)
  } else filters.push(`scale=${even((fw * scale.at) / 100)}:${even((fh * scale.at) / 100)}`)
  filters.push('setsar=1')

  const color = fx.get('color')
  if (color) {
    const ev = paramExpr(b, c, color, 'exposure', 0)
    const con = paramExpr(b, c, color, 'contrast', 0)
    const sat = paramExpr(b, c, color, 'saturation', 100)
    const temp = paramExpr(b, c, color, 'temperature', 6500)
    if (ev.animated || temp.animated) b.warn('animated exposure and temperature are exported at their first value')
    if (con.animated || sat.animated || con.at !== 0 || sat.at !== 100) {
      filters.push(`eq=contrast='1+(${con.expr})/100':saturation='(${sat.expr})/100':eval=${con.animated || sat.animated ? 'frame' : 'init'}`)
    }
    if (ev.at !== 0) {
      const g = n(Math.pow(2, ev.at / 2.2))
      filters.push(`colorchannelmixer=rr=${g}:gg=${g}:bb=${g}`)
    }
    if (temp.at !== 6500) filters.push(`colortemperature=temperature=${n(temp.at)}`)
  }

  const blur = fx.get('gaussian_blur')
  if (blur) {
    const r = paramExpr(b, c, blur, 'radius', 10)
    if (r.animated) b.warn('animated blur is exported at its first value')
    if (r.at > 0) filters.push(`gblur=sigma=${n(r.at / 2)}`)
  }

  filters.push('format=rgba')
  // geq calls its time variable T
  const op = paramExpr(b, c, tf, 'opacity', 100, 'T')
  if (op.animated) filters.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip((${op.expr})/100,0,1)'`)
  else if (op.at < 100) filters.push(`colorchannelmixer=aa=${n(op.at / 100)}`)

  const rot = paramExpr(b, c, tf, 'rotation', 0)
  if (rot.animated || rot.at % 360 !== 0) filters.push(`rotate=a='(${rot.expr})*PI/180':ow='hypot(iw,ih)':oh=ow:c=none`)

  // fades and transitions on alpha, in range-relative seconds
  const fade = fx.get('fade')
  if (fade) {
    const fi = Number(evalParam(fade.params.fade_in, 0, 0))
    const fo = Number(evalParam(fade.params.fade_out, 0, 0))
    if (fi > 0) filters.push(`fade=t=in:st=${n(b.abs(c.start))}:d=${secs(fi)}:alpha=1`)
    if (fo > 0) filters.push(`fade=t=out:st=${n(b.abs(itemEnd(c) - fo))}:d=${secs(fo)}:alpha=1`)
  }

  // overlay expressions see the output clock, so they get the sequence clock spelled out
  const v = b.seqT
  const px = paramExpr(b, c, tf, 'position_x', 0, v)
  const py = paramExpr(b, c, tf, 'position_y', 0, v)
  const ax = paramExpr(b, c, tf, 'anchor_x', 0, v)
  const ay = paramExpr(b, c, tf, 'anchor_y', 0, v)
  const k = `(${paramExpr(b, c, tf, 'scale', 100, v).expr})/100`
  // centred, plus the position offset, minus the anchor scaled with the picture
  const place = (base: string, pos: typeof px, anchor: typeof ax): string =>
    `${base}${pos.animated || pos.at ? `+(${pos.expr})` : ''}${anchor.animated || anchor.at ? `-(${anchor.expr})*${k}` : ''}`
  return {
    filters,
    x: place('(W-w)/2', px, ax),
    y: place('(H-h)/2', py, ay),
    animatedPos: px.animated || py.animated || ax.animated || ay.animated || scale.animated || rot.animated
  }
}

// alpha ramps for transitions: in on the incoming clip, out on an outgoing clip under a dip
function transitionFades(b: Builder, spans: ReturnType<typeof clipSpans>, i: number): string[] {
  const out: string[] = []
  const tr = spans[i].transition
  if (tr) {
    const d = tr.end - tr.start
    if (tr.def.defId === 'dip_to_color') out.push(`fade=t=in:st=${n(b.abs(tr.start + d / 2))}:d=${secs(d / 2)}:alpha=1`)
    else out.push(`fade=t=in:st=${n(b.abs(tr.start))}:d=${secs(d)}:alpha=1`)
  }
  const next = spans.find((s) => s.transition?.fromClipId === spans[i].clip.id)
  if (next?.transition?.def.defId === 'dip_to_color') {
    const d = next.transition.end - next.transition.start
    out.push(`fade=t=out:st=${n(b.abs(next.transition.start))}:d=${secs(d / 2)}:alpha=1`)
  }
  return out
}

// the picture of a graphic item as an rgba stream at doc size, starting at pts 0
function graphicCanvas(b: Builder, g: GraphicItem, dur: Tick, srcIn: Tick): string {
  const doc = g.doc
  const D = secs(dur)
  let cur = b.label('g')
  b.chains.push(`color=c=${doc.background ? ffColor(doc.background) : 'black@0'}:s=${even(doc.width)}x${even(doc.height)}:r=${b.rate}:d=${D},format=rgba[${cur}]`)
  const draw = (f: string): void => {
    const next = b.label('g')
    b.chains.push(`[${cur}]${f}[${next}]`)
    cur = next
  }
  for (const l of doc.layers) {
    if (!l.visible) continue
    if (l.blend !== 'normal') b.warn(`${l.blend} blend is exported as normal`)
    const op = l.opacity / 100
    const t = l.transform
    if (l.type === 'raster') {
      const m = b.p.items[l.mediaId]
      if (m?.kind !== 'media') {
        b.warn(`a layer in ${g.name} points at missing media`)
        continue
      }
      const k = m.info.isStill
        ? b.input(['-loop', '1', '-framerate', b.rate, '-t', D, '-i', b.mediaPath(m)])
        : b.input(['-ss', secs(srcIn), '-t', D, '-i', b.mediaPath(m)])
      const lw = even(m.info.width * t.scaleX)
      const lh = even(m.info.height * t.scaleY)
      const parts = [`setpts=PTS-STARTPTS`, `fps=${b.rate}`, `scale=${lw}:${lh}`, 'format=rgba']
      if (op < 1) parts.push(`colorchannelmixer=aa=${n(op)}`)
      if (t.rotation % 360) parts.push(`rotate=a=${n((t.rotation * Math.PI) / 180)}:ow='hypot(iw,ih)':oh=ow:c=none`)
      const lay = b.label('l')
      b.chains.push(`[${k}:v]${parts.join(',')}[${lay}]`)
      const next = b.label('g')
      b.chains.push(`[${cur}][${lay}]overlay=x='${n(t.x)}-w/2':y='${n(t.y)}-h/2':eof_action=pass:format=rgb[${next}]`)
      cur = next
    } else if (l.type === 'text') {
      const st = l.style
      if (t.rotation % 360) b.warn('rotated text layers are exported unrotated')
      const text = st.uppercase ? l.text.toUpperCase() : l.text
      const path = b.file(`text${b.files.length}.txt`, text)
      const size = Number(st.size) * t.scaleY
      const parts = [
        `drawtext=fontfile=${filterPath(b.o.fonts.file(String(st.font), !!st.bold, !!st.italic))}`,
        `textfile=${filterPath(path)}`,
        'expansion=none',
        `fontsize=${n(size)}`,
        `fontcolor=${ffColor(String(st.color), op)}`,
        `x='${n(t.x)}-text_w/2'`,
        `y='${n(t.y)}-text_h/2'`
      ]
      if (Number(st.stroke_width) > 0) parts.push(`borderw=${n(Number(st.stroke_width))}`, `bordercolor=${ffColor(String(st.stroke_color), op)}`)
      if (Number(st.background_opacity) > 0) parts.push('box=1', `boxcolor=${ffColor(String(st.background), (op * Number(st.background_opacity)) / 100)}`, `boxborderw=${n(size * 0.25)}`)
      draw(parts.join(':'))
    } else if (l.type === 'shape') {
      if (l.shape === 'ellipse') b.warn('ellipse shapes are exported as rectangles')
      if (t.rotation % 360) b.warn('rotated shapes are exported unrotated')
      const w = l.width * t.scaleX
      const h = l.height * t.scaleY
      const box = `x=${n(t.x - w / 2)}:y=${n(t.y - h / 2)}:w=${n(w)}:h=${n(h)}`
      draw(`drawbox=${box}:color=${ffColor(l.fill, op)}:t=fill`)
      if (l.stroke && l.strokeWidth > 0) draw(`drawbox=${box}:color=${ffColor(l.stroke, op)}:t=${n(l.strokeWidth)}`)
    } else {
      b.warn('adjustment layers are not exported yet')
    }
  }
  return cur
}

function videoTracks(b: Builder, base: string): string {
  let cur = base
  for (const track of b.seq.videoTracks) {
    if (track.hidden) continue
    const spans = clipSpans(track)
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i]
      const c = span.clip
      const a = Math.max(span.visibleStart, b.o.from)
      const e = Math.min(span.visibleEnd, b.o.to)
      if (!c.enabled || e <= a) continue
      const item = b.p.items[c.itemRef]
      const media = item?.kind === 'media' ? item : item?.kind === 'subclip' ? b.p.items[item.sourceId] : undefined
      const offset = item?.kind === 'subclip' ? item.in : 0
      let stream: string
      let sw: number
      let sh: number
      const head: string[] = []
      if (media?.kind === 'media') {
        if (!media.info.hasVideo) continue
        const srcA = Math.max(0, offset + sourceTimeAt(c, a))
        const k = media.info.isStill
          ? b.input(['-loop', '1', '-framerate', b.rate, '-t', secs(e - a), '-i', b.mediaPath(media)])
          : b.input(['-ss', secs(srcA), '-t', secs(Math.round((e - a) * c.speed)), '-i', b.mediaPath(media)])
        stream = `${k}:v`
        head.push('setpts=PTS-STARTPTS')
        if (c.speed !== 1 && !media.info.isStill) head.push(`setpts=PTS/${n(c.speed)}`)
        // resample to the sequence rate before the offset; after it, fps can drop a lone frame
        head.push(`fps=${b.rate}`)
        sw = media.info.width
        sh = media.info.height
      } else if (item?.kind === 'graphic') {
        stream = graphicCanvas(b, item, e - a, sourceTimeAt(c, a))
        sw = item.doc.width
        sh = item.doc.height
      } else {
        b.warn(item?.kind === 'sequence' ? 'nested sequences are not exported yet' : `clip ${c.id} points at missing media`)
        continue
      }
      head.push(`setpts=PTS+${n(b.abs(a))}/TB`)
      const pic = pictureChain(b, c, sw, sh)
      const chain = [...head, ...pic.filters, ...transitionFades(b, spans, i)]
      if (b.o.from) chain.push(`setpts=PTS-${secs(b.o.from)}/TB`)
      const clipLabel = b.label('c')
      b.chains.push(`[${stream}]${chain.join(',')}[${clipLabel}]`)
      const tr = span.transition
      if (tr?.def.defId === 'dip_to_color' && tr.start < b.o.to && tr.end > b.o.from) {
        const d = tr.end - tr.start
        const solid = b.label('s')
        b.chains.push(
          `color=c=${ffColor(String(tr.def.params.color ?? '#000000'))}:s=${b.seq.width}x${b.seq.height}:r=${b.rate}:d=${secs(d)},format=rgba,` +
            `setpts=PTS+${n(b.abs(tr.start))}/TB,fade=t=in:st=${n(b.abs(tr.start))}:d=${secs(d / 2)}:alpha=1,fade=t=out:st=${n(b.abs(tr.start + d / 2))}:d=${secs(d / 2)}:alpha=1,` +
            `trim=start=${secs(b.o.from)},setpts=PTS-${secs(b.o.from)}/TB[${solid}]`
        )
        const next = b.label('v')
        b.chains.push(`[${cur}][${solid}]overlay=eof_action=pass:format=auto[${next}]`)
        cur = next
      }
      const next = b.label('v')
      b.chains.push(
        `[${cur}][${clipLabel}]overlay=x='${pic.x}':y='${pic.y}':eval=${pic.animatedPos ? 'frame' : 'init'}:eof_action=pass:format=auto:enable='between(t,${n(b.rel(a))},${n(b.rel(e))})'[${next}]`
      )
      cur = next
    }
  }
  return cur
}

// ASS colour: &HAABBGGRR with alpha inverted
function assColor(c: string, opacity = 1): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(c) ?? ['', 'FF', 'FF', 'FF', 'FF']
  const a = (m[4] ? parseInt(m[4], 16) / 255 : 1) * opacity
  const hex = (x: number): string => Math.round(x).toString(16).padStart(2, '0').toUpperCase()
  return `&H${hex(255 * (1 - a))}${m[3].toUpperCase()}${m[2].toUpperCase()}${m[1].toUpperCase()}`
}

function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100))
  const h = Math.floor(cs / 360000)
  const m = Math.floor(cs / 6000) % 60
  const s = Math.floor(cs / 100) % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}

function wrap(text: string, max: number): string {
  return text
    .split('\n')
    .map((para) => {
      const lines: string[] = []
      let line = ''
      for (const w of para.split(/\s+/).filter(Boolean)) {
        if (line && line.length + 1 + w.length > max) {
          lines.push(line)
          line = w
        } else line = line ? `${line} ${w}` : w
      }
      if (line) lines.push(line)
      return lines.join('\\N')
    })
    .join('\\N')
}

// libass subtitles for every visible caption track, one style per track
export function buildAss(seq: SequenceItem, tracks: CaptionTrack[], from: Tick, to: Tick): string {
  const styles: string[] = []
  const events: string[] = []
  tracks.forEach((ct, i) => {
    const st = ct.style
    const name = `T${i}`
    const align = st.align === 'left' ? 1 : st.align === 'right' ? 3 : 2
    const boxed = Number(st.background_opacity) > 0
    const marginV = Math.round(seq.height * (1 - Number(st.position_y) / 100))
    styles.push(
      [
        `Style: ${name}`,
        String(st.font).replace(/,/g, ' '),
        n(Number(st.size)),
        assColor(String(st.color)),
        assColor(String(st.color)),
        assColor(boxed ? String(st.background) : String(st.stroke_color), boxed ? Number(st.background_opacity) / 100 : 1),
        assColor(String(st.background), Number(st.background_opacity) / 100),
        st.bold ? -1 : 0,
        st.italic ? -1 : 0,
        0,
        0,
        100,
        100,
        0,
        0,
        boxed ? 3 : 1,
        n(boxed ? Number(st.size) * 0.15 : Number(st.stroke_width)),
        0,
        align,
        Math.round(seq.width * 0.05),
        Math.round(seq.width * 0.05),
        Math.max(0, marginV),
        1
      ].join(',')
    )
    for (const cue of ct.cues) {
      const s = Math.max(cue.start, from)
      const e = Math.min(cue.start + cue.duration, to)
      if (e <= s) continue
      const raw = st.uppercase ? cue.text.toUpperCase() : cue.text
      // braces would start ASS override tags
      const text = wrap(raw.replace(/[{}]/g, ''), Number(st.max_chars) || 32)
      events.push(`Dialogue: 0,${assTime(ticksToSeconds(s - from))},${assTime(ticksToSeconds(e - from))},${name},,0,0,0,,${text}`)
    }
  })
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${seq.width}`,
    `PlayResY: ${seq.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    ''
  ].join('\n')
}

// audio gain over clip-local time t: volume keyframes, fades and transitions in one expression
function gainExpr(c: TrackItem, a: Tick, spans: ReturnType<typeof clipSpans>, i: number): { expr: string; constant: boolean } {
  const fx = effects(c)
  const local = (t: Tick): number => ticksToSeconds(t - a)
  const vol = fx.get('volume')
  const pv = vol?.params.gain
  const terms: string[] = []
  let constant = true
  if (pv && 'keyframes' in pv && pv.keyframes.length > 1) {
    constant = false
    terms.push(`pow(10,(${keyframeExpr(pv.keyframes, (src) => local(c.start + Math.round((src - c.sourceIn) / c.speed)))})/20)`)
  } else {
    const db = Number(evalParam(pv, 0, c.sourceIn))
    if (db !== 0) terms.push(n(Math.pow(10, db / 20)))
  }
  const ramp = (start: Tick, dur: Tick, up: boolean): string => {
    constant = false
    const x = `clip((t-${n(local(start))})/${secs(dur)},0,1)`
    return up ? x : `(1-${x})`
  }
  const fade = fx.get('fade')
  if (fade) {
    const fi = Number(evalParam(fade.params.fade_in, 0, 0))
    const fo = Number(evalParam(fade.params.fade_out, 0, 0))
    if (fi > 0) terms.push(ramp(c.start, fi, true))
    if (fo > 0) terms.push(ramp(itemEnd(c) - fo, fo, false))
  }
  const tr = spans[i].transition
  if (tr) terms.push(ramp(tr.start, tr.end - tr.start, true))
  const next = spans.find((s) => s.transition?.fromClipId === c.id)
  if (next?.transition) terms.push(ramp(next.transition.start, next.transition.end - next.transition.start, false))
  return { expr: terms.length ? terms.join('*') : '1', constant }
}

// speed as a chain of atempo steps, each within 0.5..2 for the best quality
function atempo(speed: number): string[] {
  const out: string[] = []
  let s = speed
  while (s > 2) {
    out.push('atempo=2')
    s /= 2
  }
  while (s < 0.5) {
    out.push('atempo=0.5')
    s /= 0.5
  }
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${n(s)}`)
  return out
}

function audioTracks(b: Builder): string {
  const sr = b.seq.sampleRate || 48000
  const D = secs(b.o.to - b.o.from)
  const baseLabel = b.label('ab')
  b.chains.push(`anullsrc=r=${sr}:cl=stereo,atrim=duration=${D}[${baseLabel}]`)
  const mix: string[] = [baseLabel]
  for (const track of b.seq.audioTracks) {
    if (track.muted) continue
    const spans = clipSpans(track)
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i]
      const c = span.clip
      const a = Math.max(span.visibleStart, b.o.from)
      const e = Math.min(span.visibleEnd, b.o.to)
      if (!c.enabled || e <= a) continue
      const item = b.p.items[c.itemRef]
      const media = item?.kind === 'media' ? item : item?.kind === 'subclip' ? b.p.items[item.sourceId] : undefined
      if (media?.kind !== 'media' || !media.info.hasAudio) {
        if (item?.kind === 'sequence') b.warn('nested sequences are not exported yet')
        continue
      }
      const offset = item?.kind === 'subclip' ? item.in : 0
      const srcA = Math.max(0, offset + sourceTimeAt(c, a))
      const k = b.input(['-ss', secs(srcA), '-t', secs(Math.round((e - a) * c.speed)), '-i', b.mediaPath(media)])
      const gain = gainExpr(c, a, spans, i)
      const parts = ['asetpts=PTS-STARTPTS', ...atempo(c.speed), `aresample=${sr}`, 'aformat=sample_fmts=fltp:channel_layouts=stereo']
      if (gain.expr !== '1') parts.push(`volume='${gain.expr}':eval=${gain.constant ? 'once' : 'frame'}`)
      const delay = Math.round(ticksToSeconds(a - b.o.from) * sr)
      if (delay > 0) parts.push(`adelay=delays=${delay}S:all=1`)
      const lab = b.label('a')
      b.chains.push(`[${k}:a]${parts.join(',')}[${lab}]`)
      mix.push(lab)
    }
  }
  if (mix.length === 1) return baseLabel
  const out = b.label('am')
  b.chains.push(`${mix.map((m) => `[${m}]`).join('')}amix=inputs=${mix.length}:duration=first:dropout_transition=0:normalize=0[${out}]`)
  return out
}

export function buildRenderGraph(project: Project, sequenceId: string, opts: GraphOptions): RenderGraph {
  const seq = getSequence(project, sequenceId)
  if (opts.to <= opts.from) throw new Error('render range is empty')
  const b = new Builder(project, seq, { ...opts, fonts: opts.fonts ?? DEFAULT_FONTS })
  const D = secs(opts.to - opts.from)
  b.chains.push(`color=c=black:s=${seq.width}x${seq.height}:r=${b.rate}:d=${D},format=yuv420p[base]`)
  let v = videoTracks(b, 'base')

  const caps = seq.captionTracks.filter((ct) => !ct.hidden && ct.cues.some((c) => c.start < opts.to && c.start + c.duration > opts.from))
  if (caps.length) {
    const path = b.file('captions.ass', buildAss(seq, caps, opts.from, opts.to))
    const next = b.label('v')
    b.chains.push(`[${v}]ass=filename=${filterPath(path)}:fontsdir=${filterPath(b.o.fonts.dir)}[${next}]`)
    v = next
  }

  const out = opts.output
  const tail: string[] = []
  if (out && (out.width !== seq.width || out.height !== seq.height)) {
    if (out.fit === 'fill') tail.push(`scale=${out.width}:${out.height}:force_original_aspect_ratio=increase`, `crop=${out.width}:${out.height}`)
    else tail.push(`scale=${out.width}:${out.height}:force_original_aspect_ratio=decrease`, `pad=${out.width}:${out.height}:(ow-iw)/2:(oh-ih)/2:color=black`)
  }
  tail.push('setsar=1', 'format=yuv420p')
  b.chains.push(`[${v}]${tail.join(',')}[vout]`)
  const maps = ['-map', '[vout]']
  if (opts.audio) {
    const a = audioTracks(b)
    b.chains.push(`[${a}]anull[aout]`)
    maps.push('-map', '[aout]')
  }
  return {
    inputArgs: b.inputs.flat(),
    filter: b.chains.join(';\n'),
    maps,
    files: b.files,
    warnings: b.warnings,
    seconds: ticksToSeconds(opts.to - opts.from)
  }
}
