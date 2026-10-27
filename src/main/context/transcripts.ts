import { promises as fs, type Dirent } from 'node:fs'
import { basename, extname, join, relative, sep } from 'node:path'
import { skipDir, tidyText } from './docs'

// captions and transcripts of past videos, from the brand's project folders. no electron here

export const TRANSCRIPT_FILE_CAP = 300
const TEXT_CAP = 2_000_000
const BYTES_CAP = 16 * 1024 * 1024

export interface TranscriptEntry {
  project: string
  // relative to the project folder, forward slashes
  file: string
  text: string
}

export interface ProjectDir {
  name: string
  dir: string
}

export function isTranscriptFile(name: string): boolean {
  const ext = extname(name).toLowerCase()
  if (ext === '.srt' || ext === '.vtt') return true
  return ext === '.txt' && /transcript|caption/i.test(basename(name))
}

const TIMING = /^\s*(\d+:)?\d{1,2}:\d{2}([.,]\d{1,3})?\s*-->\s*(\d+:)?\d{1,2}:\d{2}([.,]\d{1,3})?/

// srt or vtt to plain text: no header, cue numbers, timestamps, styling or repeated lines
export function stripCaptions(raw: string): string {
  const lines = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let skipBlock = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) {
      skipBlock = false
      continue
    }
    if (skipBlock) continue
    if (i === 0 && /^WEBVTT/.test(line)) {
      skipBlock = true
      continue
    }
    if (/^(NOTE|STYLE|REGION)(\s|$)/.test(line)) {
      skipBlock = true
      continue
    }
    if (TIMING.test(line)) continue
    // a cue number or id, the line right before a timing line
    if (i + 1 < lines.length && TIMING.test(lines[i + 1])) continue
    const text = line
      .replace(/<\d+:\d{2}(:\d{2})?[.,]\d+>/g, '')
      .replace(/<\/?[^>]+>/g, '')
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim()
    // auto captions roll up and say each line twice
    if (text && text !== out[out.length - 1]) out.push(text)
  }
  return out.join('\n')
}

export function transcriptText(name: string, raw: string): string {
  const ext = extname(name).toLowerCase()
  const text = ext === '.srt' || ext === '.vtt' ? stripCaptions(raw) : tidyText(raw.replace(/^﻿/, ''))
  return text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) : text
}

interface Cached {
  mtimeMs: number
  size: number
  text: string
}

// by absolute path, so a scan only reads files that changed
const cache = new Map<string, Cached>()

async function walk(dir: string, depth: number, out: string[], cap: number): Promise<void> {
  if (out.length >= cap || depth > 4) return
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    if (out.length >= cap) return
    if (e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (!skipDir(e.name)) await walk(full, depth + 1, out, cap)
    } else if (e.isFile() && isTranscriptFile(e.name)) out.push(full)
  }
}

// every transcript in these folders. a folder listed twice is read once
export async function scanTranscripts(projects: ProjectDir[]): Promise<TranscriptEntry[]> {
  const seen = new Set<string>()
  const out: TranscriptEntry[] = []
  const live = new Set<string>()
  for (const p of projects) {
    const key = p.dir.toLowerCase()
    if (seen.has(key) || out.length >= TRANSCRIPT_FILE_CAP) continue
    seen.add(key)
    const files: string[] = []
    await walk(p.dir, 0, files, TRANSCRIPT_FILE_CAP - out.length)
    for (const full of files) {
      let st: import('node:fs').Stats
      try {
        st = await fs.stat(full)
      } catch {
        continue
      }
      if (st.size > BYTES_CAP) continue
      live.add(full)
      let hit = cache.get(full)
      if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
        let text = ''
        try {
          text = transcriptText(full, await fs.readFile(full, 'utf8'))
        } catch {
          continue
        }
        hit = { mtimeMs: st.mtimeMs, size: st.size, text }
        cache.set(full, hit)
      }
      out.push({ project: p.name, file: relative(p.dir, full).split(sep).join('/'), text: hit.text })
    }
  }
  // files that are gone or belong to folders no longer scanned drop out of the cache
  for (const k of [...cache.keys()]) {
    if (!live.has(k) && projects.some((p) => k.toLowerCase().startsWith(p.dir.toLowerCase()))) cache.delete(k)
  }
  return out
}
