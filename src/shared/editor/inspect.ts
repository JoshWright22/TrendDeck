import { itemEnd, sequenceDuration, type Id, type Project, type ProjectItem, type TrackItem } from './model'
import { getSequence } from './timeline'
import { describeTime, ticksToSeconds, ticksToTimecode, type Rational, type Tick } from './time'

// readable views of a project for agents and debugging. times come out in seconds with
// timecode alongside; ticks are included where an agent may want to pass them back exactly

export interface InspectOptions {
  // leave file paths out. agents never see paths, only names and ids
  redactPaths?: boolean
}

const sec = (t: Tick): number => Math.round(ticksToSeconds(t) * 1000) / 1000

function itemSummary(it: ProjectItem, opts: InspectOptions): Record<string, unknown> {
  const base = { id: it.id, name: it.name, kind: it.kind, binId: it.binId }
  switch (it.kind) {
    case 'media':
      return {
        ...base,
        ...(opts.redactPaths ? {} : { path: it.path, proxyPath: it.proxyPath }),
        libraryId: it.libraryId,
        seconds: it.info.isStill ? null : sec(it.info.duration),
        still: it.info.isStill,
        video: it.info.hasVideo ? { width: it.info.width, height: it.info.height, fps: it.info.fps ? `${it.info.fps.num}/${it.info.fps.den}` : null } : null,
        audio: it.info.hasAudio ? { sampleRate: it.info.sampleRate, channels: it.info.channels } : null,
        transcriptWords: it.transcript?.words.length ?? 0
      }
    case 'sequence':
      return {
        ...base,
        fps: `${it.fps.num}/${it.fps.den}`,
        width: it.width,
        height: it.height,
        seconds: sec(sequenceDuration(it)),
        videoTracks: it.videoTracks.length,
        audioTracks: it.audioTracks.length,
        captionTracks: it.captionTracks.length
      }
    case 'subclip':
      return { ...base, sourceId: it.sourceId, in: sec(it.in), out: sec(it.out) }
    case 'graphic':
      return {
        ...base,
        width: it.doc.width,
        height: it.doc.height,
        defaultSeconds: sec(it.defaultDuration),
        layers: it.doc.layers.map((l) => ({ id: l.id, type: l.type, name: l.name, ...(l.type === 'text' ? { text: l.text } : {}) }))
      }
  }
}

export function inspectProject(p: Project, opts: InspectOptions = { redactPaths: true }): Record<string, unknown> {
  const binTree = (binId: Id): Record<string, unknown> => ({
    id: binId,
    name: p.bins[binId].name,
    bins: Object.values(p.bins)
      .filter((b) => b.parentId === binId)
      .map((b) => binTree(b.id)),
    items: Object.values(p.items)
      .filter((it) => it.binId === binId)
      .map((it) => itemSummary(it, opts))
  })
  return {
    id: p.id,
    name: p.name,
    settings: { ...p.settings, fps: `${p.settings.fps.num}/${p.settings.fps.den}` },
    root: binTree(p.rootBinId)
  }
}

// one item in full, including transcript words with ids for transcript.cut_words
export function inspectItem(p: Project, id: Id, opts: InspectOptions = { redactPaths: true }): Record<string, unknown> | null {
  const it = p.items[id]
  if (!it) return null
  const out = itemSummary(it, opts)
  if (it.kind === 'media' && it.transcript) {
    out.transcript = {
      language: it.transcript.language,
      words: it.transcript.words.map((w) => ({ id: w.id, text: w.text, start: sec(w.start), end: sec(w.end), ...(w.speaker ? { speaker: w.speaker } : {}) }))
    }
  }
  if (it.kind === 'graphic') out.doc = it.doc
  return out
}

function clipView(p: Project, c: TrackItem, fps: Rational): Record<string, unknown> {
  const it = p.items[c.itemRef]
  // keyframes shown on the timeline, where an agent would think about them
  const toSeq = (src: Tick): number => sec(c.start + Math.round((src - c.sourceIn) / c.speed))
  return {
    id: c.id,
    item: it ? { id: it.id, name: it.name, kind: it.kind } : { id: c.itemRef, missing: true },
    start: describeTime(c.start, fps),
    end: describeTime(itemEnd(c), fps),
    seconds: sec(c.duration),
    sourceIn: sec(c.sourceIn),
    speed: c.speed,
    ...(c.enabled ? {} : { enabled: false }),
    ...(c.linkId ? { linkId: c.linkId } : {}),
    ...(c.transitionIn
      ? { transitionIn: { id: c.transitionIn.id, defId: c.transitionIn.defId, seconds: sec(c.transitionIn.duration), alignment: c.transitionIn.alignment } }
      : {}),
    effects: c.effects.map((fx) => ({
      id: fx.id,
      defId: fx.defId,
      ...(fx.enabled ? {} : { enabled: false }),
      params: Object.fromEntries(
        Object.entries(fx.params).map(([k, v]) => [
          k,
          'value' in v
            ? v.value
            : v.keyframes.length > 1
              ? { keyframes: v.keyframes.map((kf) => ({ at: toSeq(kf.t), value: kf.value, ease: kf.ease })) }
              : v.keyframes[0]?.value
        ])
      )
    }))
  }
}

export function inspectSequence(p: Project, sequenceId: Id, range?: { from?: Tick; to?: Tick }): Record<string, unknown> {
  const seq = getSequence(p, sequenceId)
  const from = range?.from ?? 0
  const to = range?.to ?? Infinity
  const inRange = (s: Tick, e: Tick): boolean => e > from && s < to
  const track = (t: (typeof seq.videoTracks)[number]): Record<string, unknown> => ({
    id: t.id,
    name: t.name,
    ...(t.locked ? { locked: true } : {}),
    ...(t.muted ? { muted: true } : {}),
    ...(t.hidden ? { hidden: true } : {}),
    clips: t.items.filter((c) => inRange(c.start, itemEnd(c))).map((c) => clipView(p, c, seq.fps))
  })
  const dur = sequenceDuration(seq)
  return {
    id: seq.id,
    name: seq.name,
    fps: `${seq.fps.num}/${seq.fps.den}`,
    width: seq.width,
    height: seq.height,
    duration: describeTime(dur, seq.fps),
    videoTracks: seq.videoTracks.map(track).reverse(),
    audioTracks: seq.audioTracks.map(track),
    captionTracks: seq.captionTracks.map((ct) => ({
      id: ct.id,
      name: ct.name,
      style: ct.style,
      cues: ct.cues
        .filter((c) => inRange(c.start, c.start + c.duration))
        .map((c) => ({ id: c.id, start: sec(c.start), end: sec(c.start + c.duration), text: c.text }))
    })),
    markers: seq.markers.map((m) => ({ id: m.id, at: sec(m.at), timecode: ticksToTimecode(m.at, seq.fps), label: m.label })),
    note: 'videoTracks are listed top layer first'
  }
}
