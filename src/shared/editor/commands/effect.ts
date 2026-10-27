import { defineCommand, rawTime, seqTime, type CommandContext, type CommandSpec } from '../command'
import { checkParam, defaultParams, effectDef, evalParam, paramDef, type ParamDef } from '../effects'
import { itemEnd, sourceOut, type Ease, type EffectInstance, type Id, type Keyframe, type Project, type TrackItem } from '../model'
import { s } from '../schema'
import { secondsToTicks, toTicks, type Rational, type Tick, type TimeInput } from '../time'
import { fail, getClip, mapTracks, replaceClip, setItem, sourceLength } from '../timeline'

const EASES: Ease[] = ['linear', 'hold', 'ease_in', 'ease_out', 'ease_in_out']

function editClip(p: Project, clipId: Id, fn: (c: TrackItem, fps: Rational) => TrackItem): Project {
  const loc = getClip(p, clipId)
  if (loc.track.locked) fail(`track ${loc.track.name} is locked`)
  const next = fn(loc.clip, loc.seq.fps)
  if (next === loc.clip) return p
  return setItem(p, mapTracks(loc.seq, (t) => (t.id === loc.track.id ? replaceClip(t, next) : t)))
}

// finds the effect by instance id, or the first instance of a def id
function findFx(c: TrackItem, ref: { effectId?: Id; defId?: string }): EffectInstance | null {
  if (ref.effectId) return c.effects.find((f) => f.id === ref.effectId) ?? null
  if (ref.defId) return c.effects.find((f) => f.defId === ref.defId) ?? null
  return fail('give effectId or defId')
}

function targetFor(p: Project, c: TrackItem, trackKind: 'video' | 'audio'): string[] {
  if (trackKind === 'audio') return ['audio']
  return p.items[c.itemRef]?.kind === 'graphic' ? ['video', 'text'] : ['video']
}

function newEffect(p: Project, c: TrackItem, trackKind: 'video' | 'audio', defId: string, ctx: CommandContext): EffectInstance {
  const def = effectDef(defId) ?? fail(`no effect ${defId}`)
  if (def.targets.includes('clip')) fail(`${defId} is a clip property, use clip.set_speed`)
  if (def.targets.includes('transition')) fail(`${defId} is a transition, use transition.add`)
  const allowed = targetFor(p, c, trackKind)
  if (!def.targets.some((t) => allowed.includes(t))) fail(`${defId} can't go on a ${trackKind} clip`)
  return { id: ctx.newId('fx'), defId, enabled: true, params: defaultParams(def) }
}

function cleanValue(pd: ParamDef, v: unknown, fps: Rational): string | number | boolean {
  // durations take any time input
  const input = pd.type === 'duration' && v !== null && typeof v !== 'boolean' ? toTicks(v as TimeInput, fps) : v
  const r = checkParam(pd, input)
  if (!r.ok) fail(r.reason)
  return r.value
}

// maps a keyframe time given on the timeline, the clip, or the source into source time
function keyTime(c: TrackItem, at: TimeInput, base: 'sequence' | 'clip' | 'source', fps: Rational): Tick {
  const t = rawTime(at, fps)
  if (base === 'source') return t
  const local = base === 'clip' ? t : t - c.start
  return c.sourceIn + Math.round(local * c.speed)
}

const fxRef = {
  effectId: s.optional(s.string('Effect instance id.')),
  defId: s.optional(s.string('Effect def id, picks the first instance of it.'))
}

const timeBase = s.optional(
  s.enum(['sequence', 'clip', 'source'], 'What `at` is measured from: sequence timeline (default), clip start, or the source item. Keys are stored in source time either way.')
)

export const effectCommands: CommandSpec[] = [
  defineCommand<{ clipId: Id; defId: string; params?: Record<string, unknown>; index?: number }>({
    id: 'effect.add',
    label: 'Add Effect',
    menuPath: ['Clip', 'Add Effect'],
    shortcut: null,
    doc: 'Adds an effect from the effect list (see command_list docs or effectDefs) to a clip, optionally with starting param values. Returns { effectId }.',
    params: s.object({
      clipId: s.string('Clip id.'),
      defId: s.string('Effect def id, e.g. transform, color, gaussian_blur, volume, fade.'),
      params: s.optional({ type: 'object', description: 'Starting values by param key.' }),
      index: s.optional(s.integer('Position in the effect stack, last when left out.', { minimum: 0 }))
    }),
    run: (p, a, ctx) => {
      const loc = getClip(p, a.clipId)
      let id = ''
      const next = editClip(p, a.clipId, (c, fps) => {
        const fx = newEffect(p, c, loc.track.kind, a.defId, ctx)
        for (const [k, v] of Object.entries(a.params ?? {})) {
          const pd = paramDef(a.defId, k) ?? fail(`${a.defId} has no param ${k}`)
          fx.params[k] = { value: cleanValue(pd, v, fps) }
        }
        id = fx.id
        const effects = [...c.effects]
        effects.splice(Math.min(a.index ?? effects.length, effects.length), 0, fx)
        return { ...c, effects }
      })
      return { state: next, result: { effectId: id } }
    }
  }),
  defineCommand<{ clipId: Id; effectId: Id }>({
    id: 'effect.remove',
    label: 'Remove Effect',
    menuPath: null,
    shortcut: null,
    doc: 'Removes an effect from a clip.',
    params: s.object({ clipId: s.string('Clip id.'), effectId: s.string('Effect id.') }),
    run: (p, a) =>
      editClip(p, a.clipId, (c) => {
        const effects = c.effects.filter((f) => f.id !== a.effectId)
        if (effects.length === c.effects.length) fail(`no effect ${a.effectId} on the clip`)
        return { ...c, effects }
      })
  }),
  defineCommand<{ clipId: Id; effectId: Id; enabled: boolean }>({
    id: 'effect.set_enabled',
    label: 'Toggle Effect',
    menuPath: null,
    shortcut: null,
    doc: 'Bypasses or restores an effect.',
    params: s.object({ clipId: s.string('Clip id.'), effectId: s.string('Effect id.'), enabled: s.boolean('On or off.') }),
    run: (p, a) =>
      editClip(p, a.clipId, (c) => {
        const fx = findFx(c, a) ?? fail(`no effect ${a.effectId}`)
        return { ...c, effects: c.effects.map((f) => (f === fx ? { ...f, enabled: a.enabled } : f)) }
      })
  }),
  defineCommand<{ clipId: Id; effectId: Id; index: number }>({
    id: 'effect.reorder',
    label: 'Reorder Effect',
    menuPath: null,
    shortcut: null,
    doc: 'Moves an effect within the clip effect stack. Stack order is the order effects apply.',
    params: s.object({ clipId: s.string('Clip id.'), effectId: s.string('Effect id.'), index: s.integer('New position.', { minimum: 0 }) }),
    run: (p, a) =>
      editClip(p, a.clipId, (c) => {
        const fx = findFx(c, a) ?? fail(`no effect ${a.effectId}`)
        const effects = c.effects.filter((f) => f !== fx)
        effects.splice(Math.min(a.index, effects.length), 0, fx)
        return { ...c, effects }
      })
  }),
  defineCommand<{ clipId: Id; effectId?: Id; defId?: string; key: string; value: unknown }>({
    id: 'effect.set_param',
    label: 'Set Effect Param',
    menuPath: null,
    shortcut: null,
    doc: 'Sets a param to one constant value, dropping any keyframes on it. With defId and no matching effect on the clip, the effect is added first.',
    params: s.object({ clipId: s.string('Clip id.'), ...fxRef, key: s.string('Param key.'), value: s.any('New value; durations take any time input.') }),
    run: (p, a, ctx) => {
      const loc = getClip(p, a.clipId)
      return editClip(p, a.clipId, (c, fps) => {
        let fx = findFx(c, a)
        let effects = c.effects
        if (!fx) {
          if (!a.defId) fail(`no effect ${a.effectId}`)
          fx = newEffect(p, c, loc.track.kind, a.defId, ctx)
          effects = [...effects, fx]
        }
        const pd = paramDef(fx.defId, a.key) ?? fail(`${fx.defId} has no param ${a.key}`)
        const value = cleanValue(pd, a.value, fps)
        const target = fx
        return { ...c, effects: effects.map((f) => (f === target ? { ...f, params: { ...f.params, [a.key]: { value } } } : f)) }
      })
    }
  }),
  defineCommand<{ clipId: Id; effectId?: Id; defId?: string; key: string; at: TimeInput; value: number; ease?: Ease; timeBase?: 'sequence' | 'clip' | 'source' }>({
    id: 'keyframe.add',
    label: 'Add Keyframe',
    menuPath: null,
    shortcut: null,
    doc: 'Sets a keyframe on a number param at a time, replacing a key already there. The first key turns a constant param into an animated one. Keys live in source time so trims and splits never move them. With defId and no matching effect, the effect is added first.',
    params: s.object({
      clipId: s.string('Clip id.'),
      ...fxRef,
      key: s.string('Param key.'),
      at: s.time('Key time.'),
      value: s.number('Value at that time.'),
      ease: s.optional(s.enum(EASES, 'Curve into the next key, default linear.')),
      timeBase
    }),
    run: (p, a, ctx) => {
      const loc = getClip(p, a.clipId)
      return editClip(p, a.clipId, (c, fps) => {
        let fx = findFx(c, a)
        let effects = c.effects
        if (!fx) {
          if (!a.defId) fail(`no effect ${a.effectId}`)
          fx = newEffect(p, c, loc.track.kind, a.defId, ctx)
          effects = [...effects, fx]
        }
        const pd = paramDef(fx.defId, a.key) ?? fail(`${fx.defId} has no param ${a.key}`)
        if (!pd.keyframeable) fail(`${a.key} can't be keyframed`)
        const value = cleanValue(pd, a.value, fps) as number
        const t = keyTime(c, a.at, a.timeBase ?? 'sequence', fps)
        const cur = fx.params[a.key]
        const keys: Keyframe[] = cur && 'keyframes' in cur ? cur.keyframes.filter((k) => k.t !== t) : []
        keys.push({ t, value, ease: a.ease ?? 'linear' })
        keys.sort((x, y) => x.t - y.t)
        const target = fx
        return { ...c, effects: effects.map((f) => (f === target ? { ...f, params: { ...f.params, [a.key]: { keyframes: keys } } } : f)) }
      })
    }
  }),
  defineCommand<{ clipId: Id; effectId?: Id; defId?: string; key: string; at?: TimeInput; all?: boolean; timeBase?: 'sequence' | 'clip' | 'source' }>({
    id: 'keyframe.remove',
    label: 'Remove Keyframe',
    menuPath: null,
    shortcut: null,
    doc: 'Removes the keyframe at a time, or all of them. With one or no keys left the param goes back to a constant holding the value it had there.',
    params: s.object({
      clipId: s.string('Clip id.'),
      ...fxRef,
      key: s.string('Param key.'),
      at: s.optional(s.time('Key time.')),
      all: s.optional(s.boolean('Remove every key on the param.')),
      timeBase
    }),
    run: (p, a) =>
      editClip(p, a.clipId, (c, fps) => {
        const fx = findFx(c, a) ?? fail('no such effect on the clip')
        const cur = fx.params[a.key]
        if (!cur || !('keyframes' in cur)) fail(`${a.key} has no keyframes`)
        let keys: Keyframe[]
        if (a.all) keys = []
        else {
          if (a.at === undefined) fail('give at or all')
          const t = keyTime(c, a.at, a.timeBase ?? 'sequence', fps)
          // forgiving by half a frame, since callers often pass rounded times
          const slack = Math.round(secondsToTicks(0.5) / (fps.num / fps.den))
          const hit = cur.keyframes.find((k) => Math.abs(k.t - t) <= slack) ?? fail('no keyframe at that time')
          keys = cur.keyframes.filter((k) => k !== hit)
        }
        const pd = paramDef(fx.defId, a.key)
        const value =
          keys.length === 0 ? evalParam(cur, pd?.default ?? 0, c.sourceIn) : keys.length === 1 ? keys[0].value : null
        const pv = value === null ? { keyframes: keys } : { value }
        return { ...c, effects: c.effects.map((f) => (f === fx ? { ...f, params: { ...f.params, [a.key]: pv } } : f)) }
      })
  }),
  defineCommand<{ clipId: Id; defId?: string; duration?: TimeInput; alignment?: 'center' | 'start' | 'end'; params?: Record<string, unknown> }>({
    id: 'transition.add',
    label: 'Add Transition',
    menuPath: ['Sequence', 'Apply Default Transition'],
    shortcut: 'CmdOrCtrl+D',
    doc: 'Puts a transition on the cut at the start of a clip. center straddles the cut, start begins at it, end finishes at it. Both clips need enough unused source (handles) past the cut. Without a clip right before it, it fades in from what is underneath.',
    params: s.object({
      clipId: s.string('The incoming clip.'),
      defId: s.optional(s.string('Transition def id, cross_dissolve when left out.')),
      duration: s.optional(s.time('Length, 1 s when left out.')),
      alignment: s.optional(s.enum(['center', 'start', 'end'], 'Placement relative to the cut.')),
      params: s.optional({ type: 'object', description: 'Transition param values.' })
    }),
    run: (p, a, ctx) => {
      const loc = getClip(p, a.clipId)
      const defId = a.defId ?? 'cross_dissolve'
      const def = effectDef(defId) ?? fail(`no transition ${defId}`)
      if (!def.targets.includes('transition')) fail(`${defId} is not a transition`)
      const fps = loc.seq.fps
      const duration = a.duration === undefined ? seqTime(1, fps) : seqTime(a.duration, fps)
      if (duration <= 0) fail('transition needs a length')
      const alignment = a.alignment ?? 'center'
      const { before, after } = transitionSpan(duration, alignment)
      const c = loc.clip
      const prev = loc.track.items[loc.index - 1]
      const adjacent = prev && itemEnd(prev) === c.start ? prev : null
      if (after > c.duration) fail('transition is longer than the incoming clip')
      if (adjacent) {
        if (before > adjacent.duration) fail('transition is longer than the outgoing clip')
        if (sourceOut(adjacent) + Math.round(after * adjacent.speed) > sourceLength(p, adjacent.itemRef)) fail('outgoing clip has no source left past the cut for this transition')
      }
      // stills and graphics have no source edges, any handle works
      if (sourceLength(p, c.itemRef) !== Infinity && c.sourceIn - Math.round(before * c.speed) < 0) fail('incoming clip has no source before the cut for this transition')
      const params: Record<string, string | number | boolean> = {}
      for (const pd of def.params) params[pd.key] = pd.default
      for (const [k, v] of Object.entries(a.params ?? {})) params[k] = cleanValue(paramDef(defId, k) ?? fail(`${defId} has no param ${k}`), v, fps)
      const id = ctx.newId('tr')
      return { state: editClip(p, a.clipId, (x) => ({ ...x, transitionIn: { id, defId, duration, alignment, params } })), result: { transitionId: id } }
    }
  }),
  defineCommand<{ clipId: Id }>({
    id: 'transition.remove',
    label: 'Remove Transition',
    menuPath: null,
    shortcut: null,
    doc: 'Removes the transition at the start of a clip.',
    params: s.object({ clipId: s.string('Clip id.') }),
    run: (p, a) =>
      editClip(p, a.clipId, (c) => {
        if (!c.transitionIn) fail('clip has no transition')
        return { ...c, transitionIn: null }
      })
  })
]

// how far a transition reaches before and after its cut
export function transitionSpan(duration: Tick, alignment: 'center' | 'start' | 'end'): { before: Tick; after: Tick } {
  if (alignment === 'start') return { before: 0, after: duration }
  if (alignment === 'end') return { before: duration, after: 0 }
  const before = Math.floor(duration / 2)
  return { before, after: duration - before }
}

