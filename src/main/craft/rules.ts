// the pure rules of the craft apps: release files, folder names, what stays inside a project
// folder and how risky each of an app's tools is. no electron, unit tested in __tests__/rules.test.ts
import { isAbsolute, relative, resolve } from 'node:path'
import type { Risk } from '../../shared/gateway'

// ---- releases ----

// SHA256SUMS.txt: "<64 hex>  <name>" per line, "*<name>" for binary mode, # comments
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line)
    if (m) out.set(m[2].trim().replace(/^\.\//, ''), m[1].toLowerCase())
  }
  return out
}

// node's process.arch to the name in the release files
const ARCH: Record<string, string> = { x64: 'x64', arm64: 'arm64', ia32: 'x86' }

// the portable zip for this machine. arm64 windows runs x64 builds too, so that's the fallback
export function pickAsset(names: readonly string[], id: string, version: string, arch: string): string | null {
  const want = (a: string): string => `${id}-${version}-windows-${a}-portable.zip`
  const order = arch === 'arm64' ? ['arm64', 'x64'] : [ARCH[arch] ?? 'x64']
  for (const a of order) if (names.includes(want(a))) return want(a)
  return null
}

export function versionFromTag(tag: string): string | null {
  const m = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(tag.trim())
  return m ? m[1] : null
}

// a is newer than b. numbers compared one by one, a pre-release sorts before its release
export function newer(a: string, b: string): boolean {
  const [ma, pa = ''] = a.split('-', 2)
  const [mb, pb = ''] = b.split('-', 2)
  const na = ma.split('.').map((n) => parseInt(n, 10) || 0)
  const nb = mb.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    if ((na[i] ?? 0) !== (nb[i] ?? 0)) return (na[i] ?? 0) > (nb[i] ?? 0)
  }
  if (pa === pb) return false
  if (!pa) return true
  if (!pb) return false
  return pa > pb
}

// where a zip entry goes: the release's top folder is dropped, anything that would land outside
// the target (.., absolute, drive letters, device names) is refused. null for the top folder itself
export function zipTarget(root: string, entry: string, top: string): string | null {
  const name = entry.replace(/\\/g, '/')
  if (name.includes('\0') || /^[a-zA-Z]:/.test(name) || name.startsWith('/')) throw new Error(`unsafe path in zip: ${entry}`)
  let rest = name
  if (rest === `${top}/` || rest === top) return null
  if (rest.startsWith(`${top}/`)) rest = rest.slice(top.length + 1)
  const parts = rest.split('/').filter((p) => p !== '' && p !== '.')
  if (!parts.length) return null
  for (const p of parts) {
    if (p === '..' || /[<>:"|?*]/.test(p) || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(p)) {
      throw new Error(`unsafe path in zip: ${entry}`)
    }
  }
  const out = resolve(root, ...parts)
  if (!isInside(root, out)) throw new Error(`unsafe path in zip: ${entry}`)
  return out
}

// ---- folders ----

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

// a brand or project name as a windows folder name
export function safeName(name: string, fallback = 'Untitled'): string {
  let s = name
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim()
  if (!s || /^\.+$/.test(s)) s = fallback
  if (RESERVED.test(s.split('.')[0])) s = `${s}_`
  return s
}

// "Name", then "Name (2)", "Name (3)"... the first one not taken, case doesn't matter on windows
export function uniqueName(base: string, taken: Iterable<string>): string {
  const lower = new Set([...taken].map((t) => t.toLowerCase()))
  if (!lower.has(base.toLowerCase())) return base
  for (let i = 2; ; i++) {
    const n = `${base} (${i})`
    if (!lower.has(n.toLowerCase())) return n
  }
}

// p is root or below it. windows paths compare without case
export function isInside(root: string, p: string): boolean {
  const r = relative(resolve(root), resolve(p))
  if (r === '') return true
  const parts = r.split(/[\\/]/)
  return !isAbsolute(r) && parts[0] !== '..' && !/^[a-zA-Z]:/.test(r)
}

export class PathError extends Error {}

// a path from the agent: relative to the project folder, or absolute inside it. anything else is refused
export function resolveInProject(root: string, value: string): string {
  const v = value.trim()
  if (!v) throw new PathError('an empty path')
  if (/^\\\\|^\/\//.test(v)) throw new PathError(`${value} is a network path, use a file in the project folder`)
  if (/^~[\\/]/.test(v)) throw new PathError(`${value} is outside the project folder`)
  const full = isAbsolute(v) || /^[a-zA-Z]:/.test(v) ? resolve(v) : resolve(root, v)
  if (!isInside(root, full)) throw new PathError(`${value} is outside the project folder, only files in it can be used`)
  return full
}

// arg names that hold a file or folder, at any depth (export settings, media_import paths...)
const PATH_KEY = /(^|_)(path|paths|dir|directory|folder|location)$|[a-z](Path|Paths|Dir|Directory|Folder|Location)$|^(file|files|output|input|inputs|dest|destination|target)$/i
// a value that looks like a path whatever its key: drive letter, UNC, unix root, home
const LOOKS_ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|\\\\|\/\/|~[\\/]|\/[^/\s])/

// keys that are paths in some commands and plain words in others (FilmCraft's markers.add takes
// target "program"), so there only a value that looks like a path counts. ".." always does
const LOOSE_PATH_KEY = /^(output|input|inputs|target)$/i
const LOOKS_LIKE_PATH = /[\\/]|\.\.|\.[a-z0-9]{1,8}$/i

// every path in an agent's arguments rewritten to an absolute path inside the project folder.
// relative ones under a path key are taken from the folder, absolute ones anywhere must be in it.
// found collects the rewritten paths
export function rewritePaths(value: unknown, root: string, key = '', found: string[] = []): unknown {
  if (typeof value === 'string') {
    const v = value.trim()
    const isPath = PATH_KEY.test(key) ? v !== '' && (!LOOSE_PATH_KEY.test(key) || LOOKS_LIKE_PATH.test(v) || LOOKS_ABSOLUTE.test(v)) : LOOKS_ABSOLUTE.test(v)
    if (!isPath) return value
    const full = resolveInProject(root, value)
    found.push(full)
    return full
  }
  if (Array.isArray(value)) return value.map((v) => rewritePaths(v, root, key, found))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, rewritePaths(v, root, k, found)]))
  }
  return value
}

// the project folder's path shown to the agent as "." so it never needs the full path
export function hideRoot(text: string, root: string): string {
  if (!root) return text
  const variants = new Set([root, root.replace(/\\/g, '/'), root.replace(/\\/g, '\\\\')])
  let out = text
  for (const v of variants) {
    const re = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\\\/]*', 'gi')
    out = out.replace(re, (m) => (m.endsWith('\\') || m.endsWith('/') ? '' : '.'))
  }
  return out
}

// ---- the apps' own tools ----

export interface McpToolDef {
  name: string
  title?: string
  description?: string
  inputSchema?: Record<string, unknown>
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
}

// <app>_<tool>, the shape the gateway's policy accepts
export function gatewayName(appId: string, tool: string): string {
  return `${appId}_${tool}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 64)
}

// tool names that remove files themselves
const DELETES_TOOL = /(^|_)(delete|remove|trash|unlink|erase|purge)(_|$)/
// commands run through command_run / command_batch that remove files from disk, not clips or layers
const DELETES_COMMAND = /^(file|files|disk|media|project|proxies|proxy|cache|export|render)\.(delete|remove|trash|erase|purge|clean)|deleteFiles?|removeFiles?|trashFiles?|deleteFromDisk|moveToTrash|consolidate|projectManager/i

export function deletesFiles(commandId: string): boolean {
  return DELETES_COMMAND.test(commandId)
}

// the command ids an app tool call runs, for command_run and command_batch
export function commandIds(args: Record<string, unknown>): string[] {
  const out: string[] = []
  if (typeof args.id === 'string') out.push(args.id)
  if (typeof args.command === 'string') out.push(args.command)
  if (Array.isArray(args.steps)) {
    for (const s of args.steps) {
      if (s && typeof s === 'object' && typeof (s as { id?: unknown }).id === 'string') out.push((s as { id: string }).id)
    }
  }
  return out
}

// read-only tools read, everything else edits files in the project folder. ui_ tools move the
// app's own window so they're edits even when they say read only. a tool that deletes asks every time
export function riskFor(tool: McpToolDef): { risk: Risk; alwaysAsk: boolean } {
  const name = tool.name.toLowerCase()
  if (DELETES_TOOL.test(name)) return { risk: 'edit', alwaysAsk: true }
  if (name.startsWith('ui_')) return { risk: 'edit', alwaysAsk: false }
  if (tool.annotations?.readOnlyHint === true) return { risk: 'read', alwaysAsk: false }
  return { risk: 'edit', alwaysAsk: false }
}

// an app's tool schema as the gateway checks it: its own objects say nothing about extra keys,
// which json schema reads as allowed, the gateway's checker as refused. so those get spelled out,
// and "type": ["x", "null"] becomes x, the gateway drops nulls before checking anyway
export function gatewaySchema(schema: unknown, top = true): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return top ? { type: 'object', properties: {} } : {}
  const s = { ...(schema as Record<string, unknown>) }
  if (Array.isArray(s.type)) {
    const t = (s.type as unknown[]).filter((x) => x !== 'null')
    if (t.length === 1) s.type = t[0]
    else delete s.type
  }
  if (s.properties && typeof s.properties === 'object') {
    s.properties = Object.fromEntries(Object.entries(s.properties as Record<string, unknown>).map(([k, v]) => [k, gatewaySchema(v, false)]))
  }
  if (s.items && typeof s.items === 'object' && !Array.isArray(s.items)) s.items = gatewaySchema(s.items, false)
  else if (Array.isArray(s.items)) delete s.items
  if (s.additionalProperties && typeof s.additionalProperties === 'object') {
    s.additionalProperties = gatewaySchema(s.additionalProperties, false)
  }
  if (s.type === 'object' && s.additionalProperties === undefined) s.additionalProperties = !top
  if (top) s.type = 'object'
  return s
}

// the web build in a release: <id>-web-<version>.zip
export const webAssetName = (id: string, version: string): string => `${id}-web-${version}.zip`
