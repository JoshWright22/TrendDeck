import type { Ease, EffectInstance, Keyframe, ParamScalar, ParamValue } from './model'
import type { Tick } from './time'

// effects are data. each def describes its params once, and the inspector panels, agent docs,
// argument checks and the ffmpeg export all read from here

export type ParamType = 'number' | 'boolean' | 'color' | 'enum' | 'string' | 'duration'

export type ParamUnit = 'px' | '%' | 'deg' | 'ev' | 'dB' | 'x' | 'K' | 'ticks' | 'pt'

export interface ParamDef {
  key: string
  label: string
  type: ParamType
  default: ParamScalar
  min?: number
  max?: number
  step?: number
  unit?: ParamUnit
  options?: string[]
  // only number params can be keyframed
  keyframeable: boolean
  doc: string
}

// what an effect can sit on. 'clip' defs describe clip properties set by their own command
export type EffectTarget = 'video' | 'audio' | 'transition' | 'text' | 'clip'

export interface EffectDef {
  id: string
  label: string
  category: 'transform' | 'color' | 'blur' | 'time' | 'audio' | 'fade' | 'transition' | 'text'
  targets: EffectTarget[]
  doc: string
  params: ParamDef[]
}

const num = (
  key: string,
  label: string,
  def: number,
  min: number,
  max: number,
  unit: ParamUnit | undefined,
  doc: string,
  step?: number
): ParamDef => ({ key, label, type: 'number', default: def, min, max, unit, step, keyframeable: true, doc })

const DEFS: EffectDef[] = [
  {
    id: 'transform',
    label: 'Transform',
    category: 'transform',
    targets: ['video'],
    doc: 'Moves, scales, rotates and fades the clip picture inside the sequence frame.',
    params: [
      num('position_x', 'Position X', 0, -10000, 10000, 'px', 'Horizontal offset of the anchor from frame centre. Positive moves right.'),
      num('position_y', 'Position Y', 0, -10000, 10000, 'px', 'Vertical offset of the anchor from frame centre. Positive moves down.'),
      num('scale', 'Scale', 100, 0, 1000, '%', 'Uniform size. 100 is the fitted size.'),
      num('rotation', 'Rotation', 0, -3600, 3600, 'deg', 'Clockwise rotation around the anchor.'),
      num('anchor_x', 'Anchor X', 0, -10000, 10000, 'px', 'Pivot offset from the clip centre, in clip pixels.'),
      num('anchor_y', 'Anchor Y', 0, -10000, 10000, 'px', 'Pivot offset from the clip centre, in clip pixels.'),
      num('opacity', 'Opacity', 100, 0, 100, '%', '0 is invisible, 100 fully opaque.'),
      {
        key: 'fit',
        label: 'Fit',
        type: 'enum',
        default: 'fit',
        options: ['fit', 'fill', 'stretch', 'none'],
        keyframeable: false,
        doc: 'How the source is sized to the frame before scale applies: fit (letterbox), fill (crop to cover), stretch, or none (native pixels).'
      }
    ]
  },
  {
    id: 'crop',
    label: 'Crop',
    category: 'transform',
    targets: ['video'],
    doc: 'Trims the edges of the clip picture, as a percentage of the source size.',
    params: [
      num('left', 'Left', 0, 0, 100, '%', 'Percent cut from the left edge.'),
      num('right', 'Right', 0, 0, 100, '%', 'Percent cut from the right edge.'),
      num('top', 'Top', 0, 0, 100, '%', 'Percent cut from the top edge.'),
      num('bottom', 'Bottom', 0, 0, 100, '%', 'Percent cut from the bottom edge.')
    ]
  },
  {
    id: 'color',
    label: 'Color',
    category: 'color',
    targets: ['video'],
    doc: 'Basic grade: exposure, contrast, saturation and white balance.',
    params: [
      num('exposure', 'Exposure', 0, -4, 4, 'ev', 'Stops of brightness. +1 doubles the light.', 0.01),
      num('contrast', 'Contrast', 0, -100, 100, '%', 'Negative flattens, positive adds punch.'),
      num('saturation', 'Saturation', 100, 0, 300, '%', '0 is black and white, 100 unchanged.'),
      num('temperature', 'Temperature', 6500, 2000, 12000, 'K', 'Target white balance. Lower is warmer, higher is cooler.')
    ]
  },
  {
    id: 'gaussian_blur',
    label: 'Gaussian Blur',
    category: 'blur',
    targets: ['video'],
    doc: 'Softens the clip picture.',
    params: [num('radius', 'Radius', 10, 0, 200, 'px', 'Blur strength, in sequence pixels.')]
  },
  {
    id: 'speed',
    label: 'Speed',
    category: 'time',
    targets: ['clip'],
    doc: 'Playback rate of a clip. Set with clip.set_speed, not effect.add; changing it keeps the clip start and rescales its length.',
    params: [{ ...num('speed', 'Speed', 1, 0.1, 16, 'x', '1 is normal, 2 twice as fast, 0.5 half speed.', 0.01), keyframeable: false }]
  },
  {
    id: 'volume',
    label: 'Volume',
    category: 'audio',
    targets: ['audio'],
    doc: 'Clip loudness.',
    params: [num('gain', 'Gain', 0, -60, 24, 'dB', 'Decibels added. 0 unchanged, -6 about half as loud, -60 silent.', 0.1)]
  },
  {
    id: 'fade',
    label: 'Fade',
    category: 'fade',
    targets: ['video', 'audio', 'text'],
    doc: 'Fades the clip in from transparent or silent at its start and out at its end.',
    params: [
      { key: 'fade_in', label: 'Fade In', type: 'duration', default: 0, min: 0, unit: 'ticks', keyframeable: false, doc: 'Length of the fade in from the clip start. Any time input works.' },
      { key: 'fade_out', label: 'Fade Out', type: 'duration', default: 0, min: 0, unit: 'ticks', keyframeable: false, doc: 'Length of the fade out to the clip end. Any time input works.' }
    ]
  },
  {
    id: 'cross_dissolve',
    label: 'Cross Dissolve',
    category: 'transition',
    targets: ['transition'],
    doc: 'Blends the outgoing clip into the incoming one. Audio crossfades the same way.',
    params: []
  },
  {
    id: 'dip_to_color',
    label: 'Dip to Color',
    category: 'transition',
    targets: ['transition'],
    doc: 'Fades the outgoing clip to a colour, then up into the incoming clip.',
    params: [{ key: 'color', label: 'Color', type: 'color', default: '#000000', keyframeable: false, doc: 'The colour dipped through.' }]
  },
  {
    id: 'text_style',
    label: 'Text Style',
    category: 'text',
    targets: ['text'],
    doc: 'Look of titles, text layers and caption tracks.',
    params: [
      { key: 'font', label: 'Font', type: 'string', default: 'Inter', keyframeable: false, doc: 'Font family name.' },
      { ...num('size', 'Size', 64, 4, 1000, 'px', 'Font size in pixels of the frame or doc.'), keyframeable: false },
      { key: 'bold', label: 'Bold', type: 'boolean', default: true, keyframeable: false, doc: 'Heavy weight.' },
      { key: 'italic', label: 'Italic', type: 'boolean', default: false, keyframeable: false, doc: 'Slanted.' },
      { key: 'uppercase', label: 'Uppercase', type: 'boolean', default: false, keyframeable: false, doc: 'Show all text in capitals.' },
      { key: 'color', label: 'Color', type: 'color', default: '#FFFFFF', keyframeable: false, doc: 'Fill colour.' },
      { key: 'stroke_color', label: 'Outline Color', type: 'color', default: '#000000', keyframeable: false, doc: 'Outline colour.' },
      { ...num('stroke_width', 'Outline', 4, 0, 50, 'px', 'Outline thickness, 0 for none.'), keyframeable: false },
      { key: 'background', label: 'Box Color', type: 'color', default: '#000000', keyframeable: false, doc: 'Colour of the box behind the text.' },
      { ...num('background_opacity', 'Box Opacity', 0, 0, 100, '%', 'Box behind the text, 0 for none.'), keyframeable: false },
      { key: 'align', label: 'Align', type: 'enum', default: 'center', options: ['left', 'center', 'right'], keyframeable: false, doc: 'Horizontal alignment.' },
      { ...num('position_y', 'Vertical Position', 80, 0, 100, '%', 'Captions only: baseline height as percent of frame height from the top.'), keyframeable: false },
      { ...num('max_chars', 'Max Line Length', 32, 8, 200, undefined, 'Captions only: characters per line before wrapping.'), keyframeable: false }
    ]
  }
]

const BY_ID = new Map(DEFS.map((d) => [d.id, d]))

export function effectDefs(): readonly EffectDef[] {
  return DEFS
}

export function effectDef(id: string): EffectDef | undefined {
  return BY_ID.get(id)
}

export function paramDef(defId: string, key: string): ParamDef | undefined {
  return BY_ID.get(defId)?.params.find((p) => p.key === key)
}

export function defaultParams(def: EffectDef): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {}
  for (const p of def.params) out[p.key] = { value: p.default }
  return out
}

export function defaultScalars(defId: string): Record<string, ParamScalar> {
  const out: Record<string, ParamScalar> = {}
  for (const p of effectDef(defId)?.params ?? []) out[p.key] = p.default
  return out
}

// checks one value against its def. returns the cleaned value or an error message
export function checkParam(p: ParamDef, v: unknown): { ok: true; value: ParamScalar } | { ok: false; reason: string } {
  switch (p.type) {
    case 'number':
    case 'duration': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, reason: `${p.key} must be a number` }
      if (p.min !== undefined && v < p.min) return { ok: false, reason: `${p.key} must be at least ${p.min}` }
      if (p.max !== undefined && v > p.max) return { ok: false, reason: `${p.key} must be at most ${p.max}` }
      return { ok: true, value: p.type === 'duration' ? Math.round(v) : v }
    }
    case 'boolean':
      return typeof v === 'boolean' ? { ok: true, value: v } : { ok: false, reason: `${p.key} must be true or false` }
    case 'color':
      return typeof v === 'string' && /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)
        ? { ok: true, value: v.toUpperCase() }
        : { ok: false, reason: `${p.key} must be a #RRGGBB or #RRGGBBAA colour` }
    case 'enum':
      return typeof v === 'string' && p.options?.includes(v)
        ? { ok: true, value: v }
        : { ok: false, reason: `${p.key} must be one of ${p.options?.join(', ')}` }
    case 'string':
      return typeof v === 'string' ? { ok: true, value: v } : { ok: false, reason: `${p.key} must be text` }
  }
}

function ease(e: Ease, x: number): number {
  switch (e) {
    case 'linear':
      return x
    case 'hold':
      return 0
    case 'ease_in':
      return x * x
    case 'ease_out':
      return 1 - (1 - x) * (1 - x)
    case 'ease_in_out':
      return x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x)
  }
}

// value of a keyframe track at source time t. the ease of a key shapes the segment after it
export function evalKeyframes(keys: Keyframe[], t: Tick): number {
  if (keys.length === 0) return 0
  if (t <= keys[0].t) return keys[0].value
  const last = keys[keys.length - 1]
  if (t >= last.t) return last.value
  let lo = 0
  let hi = keys.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (keys[mid].t <= t) lo = mid
    else hi = mid
  }
  const a = keys[lo]
  const b = keys[hi]
  const x = (t - a.t) / (b.t - a.t)
  return a.value + (b.value - a.value) * ease(a.ease, x)
}

export function evalParam(v: ParamValue | undefined, fallback: ParamScalar, t: Tick): ParamScalar {
  if (!v) return fallback
  if ('keyframes' in v) return evalKeyframes(v.keyframes, t)
  return v.value
}

// every param of an effect at source time t, defaults filled in
export function evalEffect(fx: EffectInstance, t: Tick): Record<string, ParamScalar> {
  const def = effectDef(fx.defId)
  const out: Record<string, ParamScalar> = {}
  for (const p of def?.params ?? []) out[p.key] = evalParam(fx.params[p.key], p.default, t)
  return out
}

export function isAnimated(v: ParamValue | undefined): v is { keyframes: Keyframe[] } {
  return !!v && 'keyframes' in v && v.keyframes.length > 1
}

// markdown reference of every effect, for agent prompts and docs
export function effectDocs(): string {
  const lines: string[] = []
  for (const d of DEFS) {
    lines.push(`### ${d.id} (${d.label}) [${d.targets.join(', ')}]`, d.doc)
    for (const p of d.params) {
      const range = p.min !== undefined || p.max !== undefined ? ` ${p.min ?? ''}..${p.max ?? ''}` : ''
      const opts = p.options ? ` one of ${p.options.join('|')}` : ''
      lines.push(`- ${p.key}: ${p.type}${range}${p.unit ? ` ${p.unit}` : ''}${opts}, default ${JSON.stringify(p.default)}${p.keyframeable ? ', keyframeable' : ''}. ${p.doc}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
