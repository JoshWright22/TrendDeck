import type { Id, Project } from './model'
import type { JsonSchema } from './schema'
import { snapToFrame, toTicks, type Rational, type Tick, type TimeInput } from './time'

// every edit, from a menu, a shortcut or an agent, is one of these

export interface CommandContext {
  // a fresh id, unique within the project
  newId(prefix: string): Id
  // ms since epoch, injectable so tests are deterministic
  now(): number
}

export type Enabled = true | { reason: string }

export type CommandOutput = Project | { state: Project; result?: unknown }

// args arrive as plain JSON and are checked against `params` before enabled or run see them
export interface CommandSpec<A = any> {
  id: string
  label: string
  // where it lives in the app menu, e.g. ['Clip', 'Split'], null to keep it out of menus
  menuPath: string[] | null
  // electron accelerator style, e.g. 'CmdOrCtrl+K'
  shortcut: string | null
  doc: string
  params: JsonSchema
  // cheap check for menus and buttons. when left out the dispatcher dry-runs `run`, which is
  // exact because run is pure
  enabled?(state: Project, args: A, ctx: CommandContext): Enabled
  // throws EditError with a human reason when the edit can't happen
  run(state: Project, args: A, ctx: CommandContext): CommandOutput
}

export function defineCommand<A>(spec: CommandSpec<A>): CommandSpec<A> {
  return spec
}

// a time argument on the timeline of a sequence, snapped to its frames
export function seqTime(input: TimeInput, fps: Rational): Tick {
  return snapToFrame(toTicks(input, fps), fps)
}

export function rawTime(input: TimeInput, fps: Rational): Tick {
  return toTicks(input, fps)
}
