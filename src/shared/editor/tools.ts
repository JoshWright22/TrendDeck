import { effectDocs } from './effects'
import { inspectItem, inspectProject, inspectSequence } from './inspect'
import { commands, getCommand } from './registry'
import { s, type JsonSchema } from './schema'
import type { BatchStep, EditorSession } from './session'
import { toTicks, type TimeInput } from './time'
import { getSequence } from './timeline'

// the editor as MCP-style tools. the gateway registers these descriptors and routes calls to
// the handler; the same registry drives the UI, so agents can do exactly what a person can

export interface ToolDescriptor {
  name: string
  description: string
  inputSchema: JsonSchema
}

const projectId = s.optional(s.string('Open project id. The active project when left out.'))

export function editorToolDescriptors(): ToolDescriptor[] {
  return [
    {
      name: 'command_list',
      description:
        'Lists the video/image editor commands. Without ids it returns every command id with a one line doc; pass ids (or a prefix like "clip.") to get their full JSON schema params. Set effects to true for the effect and param reference used by effect.* and keyframe.* commands.',
      inputSchema: s.object({
        ids: s.optional(s.array(s.string('Command id.'), 'Commands to describe in full.')),
        prefix: s.optional(s.string('Only commands starting with this, described in full.')),
        effects: s.optional(s.boolean('Include the effect reference.'))
      })
    },
    {
      name: 'command_run',
      description:
        'Runs one editor command, e.g. {"id":"clip.split","args":{"clipId":"clip_ab12","at":"00:00:04:10"}}. Times accept seconds, "1.5s", "90f", timecode or {ticks}. Returns the command result (new ids etc.) or the reason it was refused. Every run is one undo step.',
      inputSchema: s.object({ projectId, id: s.string('Command id.'), args: s.optional({ type: 'object', description: 'Command arguments.' }) })
    },
    {
      name: 'command_batch',
      description:
        'Runs several commands as one undo step. A string arg "$N.path" is replaced by step N\'s result at that path, e.g. "$0.sequenceId" or "$1.clipIds.0". With stopOnError (default) it is all or nothing.',
      inputSchema: s.object({
        projectId,
        steps: s.array(s.object({ id: s.string('Command id.'), args: s.optional({ type: 'object', description: 'Arguments.' }) }), 'Commands in order.', { minItems: 1 }),
        stopOnError: s.optional(s.boolean('Abort and keep nothing on the first failure, default true.')),
        label: s.optional(s.string('Undo history label.'))
      })
    },
    {
      name: 'project_inspect',
      description:
        'Shows the open editor project: bins and items (media, sequences, subclips, graphics) with ids. Pass itemId for one item in full, including transcript words with their ids.',
      inputSchema: s.object({ projectId, itemId: s.optional(s.string('Item to show in full.')) })
    },
    {
      name: 'sequence_inspect',
      description: 'Shows a timeline: tracks, clips with times, effects, keyframes, transitions, captions and markers. from/to limit it to a range.',
      inputSchema: s.object({
        projectId,
        sequenceId: s.string('Sequence id.'),
        from: s.optional(s.time('Range start.')),
        to: s.optional(s.time('Range end.'))
      })
    }
  ]
}

export interface EditorToolHost {
  // the session for a project id, or the active one when id is undefined
  getSession(projectId: string | undefined): EditorSession | null
  // chance to fill args the pure core can't, e.g. probing a file for media.import
  prepare?(session: EditorSession, commandId: string, args: Record<string, unknown>): Promise<Record<string, unknown>>
  // false only for trusted callers; agents get names and ids, never file paths
  redactPaths?: boolean
}

export type ToolOutput = { ok: true; data: unknown } | { ok: false; error: string; data?: unknown }

export function createEditorToolHandler(host: EditorToolHost): (name: string, input: unknown) => Promise<ToolOutput> {
  const redact = host.redactPaths ?? true
  return async (name, input) => {
    const a = (input ?? {}) as Record<string, unknown>
    const desc = editorToolDescriptors().find((d) => d.name === name)
    if (!desc) return { ok: false, error: `unknown editor tool ${name}` }
    if (name === 'command_list') {
      const ids = a.ids as string[] | undefined
      const prefix = a.prefix as string | undefined
      const full = commands().filter((c) => ids?.includes(c.id) || (prefix && c.id.startsWith(prefix)))
      return {
        ok: true,
        data: {
          commands: full.length
            ? full.map((c) => ({ id: c.id, label: c.label, doc: c.doc, params: c.params, shortcut: c.shortcut }))
            : commands().map((c) => ({ id: c.id, doc: c.doc })),
          ...(a.effects ? { effects: effectDocs() } : {})
        }
      }
    }
    const session = host.getSession(a.projectId as string | undefined)
    if (!session) return { ok: false, error: 'no editor project is open' }
    const prep = async (id: string, args: unknown): Promise<Record<string, unknown>> => {
      const obj = (args ?? {}) as Record<string, unknown>
      return host.prepare && getCommand(id) ? host.prepare(session, id, obj) : obj
    }
    try {
      switch (name) {
        case 'command_run': {
          const id = String(a.id)
          const r = session.execute(id, await prep(id, a.args))
          return r.ok ? { ok: true, data: { result: r.result, version: r.version } } : { ok: false, error: r.reason }
        }
        case 'command_batch': {
          const steps: BatchStep[] = []
          for (const st of a.steps as BatchStep[]) steps.push({ id: st.id, args: await prep(st.id, st.args) })
          const r = session.batch(steps, { stopOnError: a.stopOnError as boolean | undefined, label: a.label as string | undefined })
          if (r.ok) return { ok: true, data: r }
          const i = r.steps.findIndex((x) => !x.ok)
          const failed = r.steps[i]
          return { ok: false, error: `step ${i} (${steps[i].id}): ${failed && !failed.ok ? failed.reason : 'failed'}`, data: r }
        }
        case 'project_inspect': {
          if (a.itemId) {
            const it = inspectItem(session.project, String(a.itemId), { redactPaths: redact })
            return it ? { ok: true, data: it } : { ok: false, error: `no item ${a.itemId}` }
          }
          return { ok: true, data: inspectProject(session.project, { redactPaths: redact }) }
        }
        case 'sequence_inspect': {
          const seq = getSequence(session.project, String(a.sequenceId))
          const range = {
            from: a.from === undefined ? undefined : toTicks(a.from as TimeInput, seq.fps),
            to: a.to === undefined ? undefined : toTicks(a.to as TimeInput, seq.fps)
          }
          return { ok: true, data: inspectSequence(session.project, seq.id, range) }
        }
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    return { ok: false, error: `unhandled tool ${name}` }
  }
}
