import { isAbsolute, join, relative, resolve } from 'node:path'
import { DEFAULT_RECORDING_SETTINGS, type ObsRecordingSettings } from '@shared/obs'

// pure rules for the per-brand recording settings: what's allowed, where a recording goes and
// what OBS's file name format becomes. no electron, unit tested

const BAD_NAME = /[<>:"/\\|?*\u0000-\u001f]/
const VIDEO = /\.(mkv|mp4|mov|flv|ts|m4v|webm|fragmented\.mp4|fragmented\.mov)$/i

export class SettingsError extends Error {}

function name(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new SettingsError(`${what} should be text`)
  const s = v.trim()
  if (s.length > 100 || /[\u0000-\u001f]/.test(s)) throw new SettingsError(`${what} is too long or has odd characters`)
  return s
}

// a folder rule: relative, inside the project folder, plain folder names, {project} and {brand}
export function cleanFolder(v: unknown): string {
  if (typeof v !== 'string') throw new SettingsError('The folder should be text')
  const s = v.trim().replace(/\//g, '\\').replace(/^\\+|\\+$/g, '')
  if (!s) return DEFAULT_RECORDING_SETTINGS.folder
  if (s.length > 200 || isAbsolute(s) || /^[a-zA-Z]:/.test(s)) throw new SettingsError('The folder has to be inside the project folder, like footage')
  for (const part of s.split(/\\+/)) {
    if (part === '.' || part === '..' || BAD_NAME.test(part) || /[. ]$/.test(part)) {
      throw new SettingsError('The folder has to be inside the project folder, with plain folder names')
    }
  }
  return s.split(/\\+/).join('\\')
}

// OBS's own % specifiers pass through. no path separators, OBS would make folders out of them
export function cleanFilename(v: unknown): string {
  if (typeof v !== 'string') throw new SettingsError('The file name should be text')
  const s = v.trim()
  if (!s) return ''
  if (s.length > 150 || BAD_NAME.test(s) || /[. ]$/.test(s)) {
    throw new SettingsError('The file name can\'t have \\ / : * ? " < > | in it or end in a dot')
  }
  return s
}

export function cleanSettings(previous: ObsRecordingSettings, patch: unknown): ObsRecordingSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new SettingsError('Bad OBS settings')
  const p = patch as Record<string, unknown>
  const keys = Object.keys(DEFAULT_RECORDING_SETTINGS)
  if (Object.keys(p).some((k) => !keys.includes(k))) throw new SettingsError('Bad OBS settings')
  const out = { ...previous }
  if (p.profile !== undefined) out.profile = name(p.profile, 'The profile')
  if (p.sceneCollection !== undefined) out.sceneCollection = name(p.sceneCollection, 'The scene collection')
  if (p.folder !== undefined) out.folder = cleanFolder(p.folder)
  if (p.filename !== undefined) out.filename = cleanFilename(p.filename)
  if (p.autoImport !== undefined) {
    if (typeof p.autoImport !== 'boolean') throw new SettingsError('Bad OBS settings')
    out.autoImport = p.autoImport
  }
  return out
}

// saved settings from disk, anything broken falls back to the default
export function loadSettings(raw: unknown): ObsRecordingSettings {
  const out = { ...DEFAULT_RECORDING_SETTINGS }
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    try {
      Object.assign(out, cleanSettings(out, { [k]: v }))
    } catch {
      // keep the default for that one
    }
  }
  return out
}

// {project} and {brand} as safe file name parts
function token(s: string): string {
  return s.replace(/[<>:"/\\|?*%\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 60) || 'untitled'
}

export function fill(pattern: string, names: { project: string; brand: string }): string {
  return pattern.replace(/\{project\}/gi, token(names.project)).replace(/\{brand\}/gi, token(names.brand))
}

// the folder OBS records into. throws when the rule would land outside the project folder
export function recordingFolder(projectDir: string, rule: string, names: { project: string; brand: string }): string {
  const dir = resolve(join(projectDir, fill(cleanFolder(rule), names)))
  if (!isInsideDir(projectDir, dir)) throw new SettingsError('The folder has to be inside the project folder')
  return dir
}

export function isInsideDir(root: string, p: string): boolean {
  const r = relative(resolve(root), resolve(p))
  if (r === '') return true
  return !isAbsolute(r) && r.split(/[\\/]/)[0] !== '..' && !/^[a-zA-Z]:/.test(r)
}

export const isRecordingFile = (file: string): boolean => VIDEO.test(file)

// OBS paths come back with forward slashes on Windows, compare them the way the disk does
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => resolve(p).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b)
}
