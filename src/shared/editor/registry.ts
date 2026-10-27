import type { CommandSpec } from './command'
import { captionCommands } from './commands/caption'
import { clipCommands } from './commands/clip'
import { effectCommands } from './commands/effect'
import { imageCommands } from './commands/image'
import { projectCommands } from './commands/project'

const ALL: CommandSpec[] = [...projectCommands, ...clipCommands, ...effectCommands, ...captionCommands, ...imageCommands]
const BY_ID = new Map(ALL.map((c) => [c.id, c]))
if (BY_ID.size !== ALL.length) throw new Error('duplicate editor command id')

export function commands(): readonly CommandSpec[] {
  return ALL
}

export function getCommand(id: string): CommandSpec | undefined {
  return BY_ID.get(id)
}

// shortcut -> command id, for the renderer's key handler and the app menu
export function shortcutMap(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of ALL) if (c.shortcut) out[c.shortcut] = c.id
  return out
}

export interface MenuNode {
  label: string
  commandId?: string
  shortcut?: string | null
  children?: MenuNode[]
}

// the menu tree the app menu or a context menu can render
export function menuTree(): MenuNode[] {
  const root: MenuNode = { label: '', children: [] }
  for (const c of ALL) {
    if (!c.menuPath) continue
    let node = root
    for (const part of c.menuPath.slice(0, -1)) {
      let child = node.children!.find((n) => n.label === part && n.children)
      if (!child) {
        child = { label: part, children: [] }
        node.children!.push(child)
      }
      node = child
    }
    node.children!.push({ label: c.menuPath[c.menuPath.length - 1], commandId: c.id, shortcut: c.shortcut })
  }
  return root.children!
}
