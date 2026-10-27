import { defineCommand, seqTime, type CommandSpec } from '../command'
import { checkParam, defaultParams, effectDef, paramDef } from '../effects'
import { centeredTransform, createGraphic, createImageDoc, createTextLayer } from '../factory'
import type { BlendMode, GraphicItem, Id, ImageDoc, Layer, LayerTransform, Project } from '../model'
import { s, type JsonSchema } from '../schema'
import { type TimeInput } from '../time'
import { fail, getItem, setItem } from '../timeline'

const BLENDS: BlendMode[] = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'add', 'difference']

function graphic(p: Project, id: Id): GraphicItem {
  const g = getItem(p, id)
  if (g.kind !== 'graphic') fail(`${id} is not an image document`)
  return g
}

function withDoc(p: Project, g: GraphicItem, doc: ImageDoc): Project {
  return setItem(p, { ...g, doc })
}

const COLOR = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i

const transformSchema: JsonSchema = s.object(
  {
    x: s.optional(s.number('Layer centre x in doc pixels.')),
    y: s.optional(s.number('Layer centre y in doc pixels.')),
    scaleX: s.optional(s.number('Horizontal scale, 1 is native.')),
    scaleY: s.optional(s.number('Vertical scale, 1 is native.')),
    rotation: s.optional(s.number('Clockwise degrees.'))
  },
  'Partial transform, unspecified fields keep their value.'
)

const layerProps = {
  name: s.optional(s.string('Layer name.')),
  visible: s.optional(s.boolean('Shown.')),
  opacity: s.optional(s.number('0..100.', { minimum: 0, maximum: 100 })),
  blend: s.optional(s.enum(BLENDS, 'Blend mode.')),
  transform: s.optional(transformSchema),
  mediaId: s.optional(s.string('raster: image or video media to show.')),
  text: s.optional(s.string('text: the words.')),
  style: s.optional({ type: 'object', description: 'text: text_style values.' } as JsonSchema),
  shape: s.optional(s.enum(['rect', 'ellipse'], 'shape: kind.')),
  width: s.optional(s.number('shape: width.', { minimum: 0 })),
  height: s.optional(s.number('shape: height.', { minimum: 0 })),
  fill: s.optional(s.string('shape: #RRGGBB(AA) fill.')),
  stroke: s.optional(s.string('shape: outline colour, empty for none.')),
  strokeWidth: s.optional(s.number('shape: outline width.', { minimum: 0 })),
  radius: s.optional(s.number('shape: corner radius.', { minimum: 0 })),
  effectDefId: s.optional(s.string('adjustment: a video effect def id, e.g. color or gaussian_blur.')),
  params: s.optional({ type: 'object', description: 'adjustment: effect param values.' } as JsonSchema)
}

type LayerArgs = {
  name?: string
  visible?: boolean
  opacity?: number
  blend?: BlendMode
  transform?: Partial<LayerTransform>
  mediaId?: Id
  text?: string
  style?: Record<string, unknown>
  shape?: 'rect' | 'ellipse'
  width?: number
  height?: number
  fill?: string
  stroke?: string
  strokeWidth?: number
  radius?: number
  effectDefId?: string
  params?: Record<string, unknown>
}

function cleanStyle(style: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(style)) {
    const r = checkParam(paramDef('text_style', k) ?? fail(`text_style has no ${k}`), v)
    if (!r.ok) fail(r.reason)
    out[k] = r.value
  }
  return out
}

// applies the given fields to a layer, refusing ones that don't belong to its type
function applyProps(p: Project, l: Layer, a: LayerArgs): Layer {
  const base = {
    ...l,
    name: a.name ?? l.name,
    visible: a.visible ?? l.visible,
    opacity: a.opacity ?? l.opacity,
    blend: a.blend ?? l.blend,
    transform: { ...l.transform, ...a.transform }
  }
  const wrong = (k: string): never => fail(`${k} doesn't apply to a ${l.type} layer`)
  switch (base.type) {
    case 'raster': {
      if (a.text !== undefined) wrong('text')
      if (a.mediaId !== undefined) {
        const m = getItem(p, a.mediaId)
        if (m.kind !== 'media' || !m.info.hasVideo) fail('raster layers show image or video media')
      }
      return { ...base, mediaId: a.mediaId ?? base.mediaId }
    }
    case 'text':
      if (a.mediaId !== undefined) wrong('mediaId')
      return { ...base, text: a.text ?? base.text, style: { ...base.style, ...cleanStyle(a.style ?? {}) } }
    case 'shape': {
      for (const c of [a.fill, a.stroke]) if (c && !COLOR.test(c)) fail(`${c} is not a #RRGGBB colour`)
      return {
        ...base,
        shape: a.shape ?? base.shape,
        width: a.width ?? base.width,
        height: a.height ?? base.height,
        fill: a.fill ?? base.fill,
        stroke: a.stroke === undefined ? base.stroke : a.stroke || null,
        strokeWidth: a.strokeWidth ?? base.strokeWidth,
        radius: a.radius ?? base.radius
      }
    }
    case 'adjustment': {
      const params = { ...base.effect.params }
      for (const [k, v] of Object.entries(a.params ?? {})) {
        const r = checkParam(paramDef(base.effect.defId, k) ?? fail(`${base.effect.defId} has no ${k}`), v)
        if (!r.ok) fail(r.reason)
        params[k] = { value: r.value }
      }
      return { ...base, effect: { ...base.effect, params } }
    }
  }
}

export const imageCommands: CommandSpec[] = [
  defineCommand<{ name?: string; width: number; height: number; background?: string; duration?: TimeInput; binId?: Id }>({
    id: 'image.create',
    label: 'New Image',
    menuPath: ['File', 'New', 'Image'],
    shortcut: null,
    doc: 'Makes an empty layered image document. It can be placed on a timeline like any still. Returns { graphicId }.',
    params: s.object({
      name: s.optional(s.string('Name.')),
      width: s.integer('Canvas width.', { minimum: 1, maximum: 16384 }),
      height: s.integer('Canvas height.', { minimum: 1, maximum: 16384 }),
      background: s.optional(s.string('#RRGGBB fill, transparent when left out.')),
      duration: s.optional(s.time('Default length on a timeline.')),
      binId: s.optional(s.string('Bin.'))
    }),
    run: (p, a, ctx) => {
      if (a.background && !COLOR.test(a.background)) fail('background must be #RRGGBB')
      const id = ctx.newId('graphic')
      const g = createGraphic({
        id,
        name: a.name ?? 'Image',
        binId: a.binId && p.bins[a.binId] ? a.binId : p.rootBinId,
        doc: createImageDoc(a.width, a.height, a.background ?? null),
        defaultDuration: a.duration === undefined ? undefined : seqTime(a.duration, p.settings.fps)
      })
      return { state: setItem(p, g), result: { graphicId: id } }
    }
  }),
  defineCommand<{ graphicId: Id; width?: number; height?: number; background?: string | null }>({
    id: 'image.set_canvas',
    label: 'Canvas Size',
    menuPath: ['Image', 'Canvas Size'],
    shortcut: null,
    doc: 'Resizes the canvas (layers keep their pixel positions) or changes the background.',
    params: s.object({
      graphicId: s.string('Image id.'),
      width: s.optional(s.integer('Width.', { minimum: 1, maximum: 16384 })),
      height: s.optional(s.integer('Height.', { minimum: 1, maximum: 16384 })),
      background: s.optional({ description: '#RRGGBB, or empty string for transparent.', type: 'string' })
    }),
    run: (p, a) => {
      const g = graphic(p, a.graphicId)
      if (a.background && !COLOR.test(a.background)) fail('background must be #RRGGBB')
      return withDoc(p, g, {
        ...g.doc,
        width: a.width ?? g.doc.width,
        height: a.height ?? g.doc.height,
        background: a.background === undefined ? g.doc.background : a.background || null
      })
    }
  }),
  defineCommand<LayerArgs & { graphicId: Id; type: Layer['type']; index?: number }>({
    id: 'image.layer_add',
    label: 'New Layer',
    menuPath: ['Image', 'New Layer'],
    shortcut: 'CmdOrCtrl+Shift+N',
    doc: 'Adds a raster (needs mediaId), text (needs text), shape or adjustment (needs effectDefId) layer, on top unless index is given. Returns { layerId }.',
    params: s.object({ graphicId: s.string('Image id.'), type: s.enum(['raster', 'text', 'shape', 'adjustment'], 'Layer type.'), index: s.optional(s.integer('Stack position, 0 is bottom.', { minimum: 0 })), ...layerProps }),
    run: (p, a, ctx) => {
      const g = graphic(p, a.graphicId)
      const id = ctx.newId('layer')
      const common = { id, name: a.name ?? a.type, visible: true, opacity: 100, blend: 'normal' as BlendMode, transform: centeredTransform(g.doc) }
      let layer: Layer
      switch (a.type) {
        case 'raster': {
          if (!a.mediaId) fail('raster layers need mediaId')
          const m = getItem(p, a.mediaId)
          if (m.kind !== 'media' || !m.info.hasVideo) fail('raster layers show image or video media')
          layer = { ...common, type: 'raster', mediaId: a.mediaId, name: a.name ?? m.name }
          break
        }
        case 'text':
          layer = createTextLayer(id, g.doc, a.text ?? fail('text layers need text'))
          break
        case 'shape':
          layer = { ...common, type: 'shape', shape: 'rect', width: g.doc.width / 2, height: g.doc.height / 2, fill: '#FFFFFF', stroke: null, strokeWidth: 0, radius: 0 }
          break
        case 'adjustment': {
          const def = effectDef(a.effectDefId ?? fail('adjustment layers need effectDefId')) ?? fail(`no effect ${a.effectDefId}`)
          if (!def.targets.includes('video')) fail(`${def.id} is not a picture effect`)
          layer = { ...common, type: 'adjustment', effect: { id: ctx.newId('fx'), defId: def.id, enabled: true, params: defaultParams(def) } }
          break
        }
      }
      layer = applyProps(p, layer, { ...a, mediaId: undefined })
      const layers = [...g.doc.layers]
      layers.splice(Math.min(a.index ?? layers.length, layers.length), 0, layer)
      return { state: withDoc(p, g, { ...g.doc, layers }), result: { layerId: id } }
    }
  }),
  defineCommand<LayerArgs & { graphicId: Id; layerId: Id }>({
    id: 'image.layer_update',
    label: 'Layer Properties',
    menuPath: null,
    shortcut: null,
    doc: 'Changes any layer fields: name, visible, opacity, blend, transform, and the type-specific ones.',
    params: s.object({ graphicId: s.string('Image id.'), layerId: s.string('Layer id.'), ...layerProps }),
    run: (p, a) => {
      const g = graphic(p, a.graphicId)
      const l = g.doc.layers.find((x) => x.id === a.layerId) ?? fail(`no layer ${a.layerId}`)
      if (a.effectDefId !== undefined) fail('effectDefId is fixed once a layer exists')
      const next = applyProps(p, l, a)
      return withDoc(p, g, { ...g.doc, layers: g.doc.layers.map((x) => (x === l ? next : x)) })
    }
  }),
  defineCommand<{ graphicId: Id; layerId: Id }>({
    id: 'image.layer_remove',
    label: 'Delete Layer',
    menuPath: ['Image', 'Delete Layer'],
    shortcut: null,
    doc: 'Deletes a layer.',
    params: s.object({ graphicId: s.string('Image id.'), layerId: s.string('Layer id.') }),
    run: (p, a) => {
      const g = graphic(p, a.graphicId)
      const layers = g.doc.layers.filter((l) => l.id !== a.layerId)
      if (layers.length === g.doc.layers.length) fail(`no layer ${a.layerId}`)
      return withDoc(p, g, { ...g.doc, layers })
    }
  }),
  defineCommand<{ graphicId: Id; layerId: Id; index: number }>({
    id: 'image.layer_reorder',
    label: 'Arrange Layer',
    menuPath: null,
    shortcut: null,
    doc: 'Moves a layer in the stack. 0 is the bottom.',
    params: s.object({ graphicId: s.string('Image id.'), layerId: s.string('Layer id.'), index: s.integer('New position.', { minimum: 0 }) }),
    run: (p, a) => {
      const g = graphic(p, a.graphicId)
      const l = g.doc.layers.find((x) => x.id === a.layerId) ?? fail(`no layer ${a.layerId}`)
      const layers = g.doc.layers.filter((x) => x !== l)
      layers.splice(Math.min(a.index, layers.length), 0, l)
      return withDoc(p, g, { ...g.doc, layers })
    }
  })
]
