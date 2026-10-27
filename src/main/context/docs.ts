import { promises as fs } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { constants as zc, inflateRawSync, inflateSync } from 'node:zlib'

// brand docs: markdown, text and pdf files in a folder the user picked. no electron here, the
// extract and search parts are pure so the tests can run them on their own

export const DOC_FILE_CAP = 500
export const DOC_TEXT_CAP = 2_000_000
// past this the file isn't read at all, it's listed with no text
const DOC_BYTES_CAP = 64 * 1024 * 1024
// all docs together, so a huge folder can't eat the memory
const TOTAL_TEXT_CAP = 64_000_000
const TEXT_EXTS = new Set(['.md', '.markdown', '.mdx', '.txt'])
const DOC_EXTS = new Set([...TEXT_EXTS, '.pdf'])

export interface DocEntry {
  // relative to the folder, forward slashes
  file: string
  size: number
  mtimeMs: number
  text: string
}

export interface DocsIndex {
  folder: string
  indexedAt: number
  files: DocEntry[]
}

export const isDocFile = (name: string): boolean => DOC_EXTS.has(extname(name).toLowerCase())
export const skipDir = (name: string): boolean => name.startsWith('.') || name === 'node_modules'

// ---------- text ----------

export function tidyText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function textOf(name: string, buf: Buffer): string {
  const ext = extname(name).toLowerCase()
  let text = ''
  if (ext === '.pdf') text = extractPdfText(buf)
  else if (TEXT_EXTS.has(ext)) text = tidyText(buf.toString('utf8').replace(/^﻿/, ''))
  return text.length > DOC_TEXT_CAP ? text.slice(0, DOC_TEXT_CAP) : text
}

// ---------- pdf ----------

interface PdfObj {
  // the dictionary, or the whole object when it has no stream
  body: string
  data: Buffer | null
}

// a best-effort reader: the text operators of each page, with spaces and line breaks guessed
// from where the text sits. scanned pdfs have none and give ''
export function extractPdfText(buf: Buffer): string {
  try {
    const objs = parseObjects(buf)
    const pages = pageList(objs)
    const parts: string[] = []
    const cmapCache = new Map<number, CMap | null>()
    if (pages.length) {
      for (const page of pages) {
        const fonts = fontsOf(objs, page, cmapCache)
        // a page's content can be split over streams, they run as one
        const data = contentRefs(objs.get(page)!.body)
          .map((n) => decodeStream(objs.get(n))?.toString('latin1') ?? '')
          .join('\n')
        parts.push(contentText(data, fonts), '\n\n')
      }
    } else {
      // no page tree found, read every stream that looks like page content
      for (const o of objs.values()) {
        if (/\/(XRef|ObjStm|XObject|Image|FontFile)|\/Length[123]\b/.test(o.body)) continue
        const data = decodeStream(o)
        if (!data) continue
        const s = data.toString('latin1')
        if (/\bBT\b/.test(s) && /\bET\b/.test(s)) parts.push(contentText(s, new Map()), '\n')
      }
    }
    return tidyText(parts.join(''))
  } catch {
    return ''
  }
}

function parseObjects(buf: Buffer): Map<number, PdfObj> {
  const s = buf.toString('latin1')
  const objs = new Map<number, PdfObj>()
  const re = /(\d+)\s+\d+\s+obj\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const num = Number(m[1])
    const start = m.index + m[0].length
    const end = s.indexOf('endobj', start)
    const head = s.slice(start, end < 0 ? s.length : end)
    const sm = />>\s*stream(\r\n|\n|\r)?/.exec(head)
    if (sm) {
      const body = head.slice(0, sm.index + 2)
      const dataStart = start + sm.index + sm[0].length
      let dataEnd = -1
      const len = /\/Length\s+(\d+)(?!\d|\s+\d+\s+R)/.exec(body)
      if (len) {
        const at = dataStart + Number(len[1])
        if (/^\s*endstream/.test(s.slice(at, at + 20))) dataEnd = at
      }
      if (dataEnd < 0) {
        dataEnd = s.indexOf('endstream', dataStart)
        if (dataEnd < 0) break
        if (s[dataEnd - 1] === '\n') dataEnd--
        if (s[dataEnd - 1] === '\r') dataEnd--
      }
      objs.set(num, { body, data: buf.subarray(dataStart, dataEnd) })
      re.lastIndex = Math.max(dataEnd, start)
    } else {
      objs.set(num, { body: s.slice(start, end < 0 ? undefined : end), data: null })
      if (end > 0) re.lastIndex = end
    }
  }
  // objects packed into object streams, pdf 1.5 and later
  for (const o of [...objs.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(o.body)) continue
    const data = decodeStream(o)
    const n = Number(/\/N\s+(\d+)/.exec(o.body)?.[1] ?? 0)
    const first = Number(/\/First\s+(\d+)/.exec(o.body)?.[1] ?? 0)
    if (!data || !n || !first) continue
    const t = data.toString('latin1')
    const nums = t.slice(0, first).trim().split(/\s+/).map(Number)
    for (let i = 0; i < n && i * 2 + 1 < nums.length; i++) {
      const id = nums[i * 2]
      const from = first + nums[i * 2 + 1]
      const to = i + 1 < n && i * 2 + 3 < nums.length ? first + nums[i * 2 + 3] : t.length
      if (!objs.has(id)) objs.set(id, { body: t.slice(from, to), data: null })
    }
  }
  return objs
}

function decodeStream(o: PdfObj | undefined): Buffer | null {
  if (!o?.data) return null
  const filter = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(o.body)?.[1] ?? ''
  const names = filter.match(/\/[A-Za-z0-9]+/g) ?? []
  if (!names.length) return o.data
  if (names.length !== 1 || (names[0] !== '/FlateDecode' && names[0] !== '/Fl')) return null
  // predictors only show up on xref streams and images, neither has text
  if (/\/Predictor\s+([2-9]|1\d)/.test(o.body)) return null
  for (const inflate of [
    () => inflateSync(o.data!),
    () => inflateSync(o.data!, { finishFlush: zc.Z_SYNC_FLUSH }),
    () => inflateRawSync(o.data!, { finishFlush: zc.Z_SYNC_FLUSH })
  ]) {
    try {
      return inflate()
    } catch {
      // try the next way
    }
  }
  return null
}

const refOf = (body: string, key: string): number | null => {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(body)
  return m ? Number(m[1]) : null
}

// the << ... >> right after /key, nested dicts included
function dictAfter(body: string, key: string): string | null {
  const m = new RegExp(`/${key}\\s*<<`).exec(body)
  if (!m) return null
  let depth = 0
  for (let i = m.index + m[0].length - 2; i < body.length - 1; i++) {
    if (body[i] === '<' && body[i + 1] === '<') {
      depth++
      i++
    } else if (body[i] === '>' && body[i + 1] === '>') {
      depth--
      i++
      if (!depth) return body.slice(m.index + m[0].length, i - 1)
    }
  }
  return null
}

// a dict given inline or as a reference
function dictOf(objs: Map<number, PdfObj>, body: string, key: string): string | null {
  const inline = dictAfter(body, key)
  if (inline !== null) return inline
  const ref = refOf(body, key)
  return ref !== null ? (objs.get(ref)?.body ?? null) : null
}

// pages in reading order, walked from the root of the page tree
function pageList(objs: Map<number, PdfObj>): number[] {
  const isType = (body: string, t: string): boolean => new RegExp(`/Type\\s*/${t}(?![A-Za-z])`).test(body)
  const roots = [...objs.entries()].filter(([, o]) => isType(o.body, 'Pages') && !/\/Parent\s/.test(o.body))
  const out: number[] = []
  const seen = new Set<number>()
  const walk = (n: number, depth: number): void => {
    const o = objs.get(n)
    if (!o || seen.has(n) || depth > 50) return
    seen.add(n)
    if (isType(o.body, 'Page')) {
      out.push(n)
      return
    }
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(o.body)?.[1] ?? ''
    for (const k of kids.matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(k[1]), depth + 1)
  }
  for (const [n] of roots) walk(n, 0)
  if (!out.length) {
    for (const [n, o] of objs) if (isType(o.body, 'Page')) out.push(n)
  }
  return out
}

function contentRefs(body: string): number[] {
  const arr = /\/Contents\s*\[([^\]]*)\]/.exec(body)
  if (arr) return [...arr[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]))
  const one = refOf(body, 'Contents')
  return one !== null ? [one] : []
}

interface CMap {
  bytes: number
  map: Map<number, string>
}

export interface Font {
  // codes are this many bytes wide
  bytes: number
  cmap: CMap | null
  // glyph widths in 1/1000 of the font size, null when the font doesn't say
  widths: Map<number, number> | null
  defaultWidth: number
}

// an array given inline or as a reference, as its inside text
function arrayOf(objs: Map<number, PdfObj>, body: string, key: string): string | null {
  const ref = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(body)
  const src = ref ? (objs.get(Number(ref[1]))?.body ?? '') : body
  const at = ref ? src.indexOf('[') : (new RegExp(`/${key}\\s*\\[`).exec(src)?.index ?? -1)
  if (at < 0) return null
  const open = src.indexOf('[', at)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++
    else if (src[i] === ']' && --depth === 0) return src.slice(open + 1, i)
  }
  return null
}

// simple fonts: /FirstChar and /Widths. type0: /W on the descendant, like [1 [500 600] 10 20 250]
function widthsOf(objs: Map<number, PdfObj>, fbody: string, type0: boolean): { widths: Map<number, number> | null; defaultWidth: number } {
  const widths = new Map<number, number>()
  if (!type0) {
    const list = arrayOf(objs, fbody, 'Widths')
    if (list === null) return { widths: null, defaultWidth: 500 }
    const first = Number(/\/FirstChar\s+(\d+)/.exec(fbody)?.[1] ?? 0)
    list.trim().split(/\s+/).forEach((w, i) => w && widths.set(first + i, Number(w)))
    return { widths, defaultWidth: 0 }
  }
  const kids = arrayOf(objs, fbody, 'DescendantFonts') ?? ''
  const kidRef = /(\d+)\s+\d+\s+R/.exec(kids)
  const desc = kidRef ? (objs.get(Number(kidRef[1]))?.body ?? '') : kids
  const dw = Number(/\/DW\s+(\d+)/.exec(desc)?.[1] ?? 1000)
  const w = arrayOf(objs, desc, 'W')
  if (w === null) return { widths: null, defaultWidth: dw }
  const toks = w.match(/\[[^\]]*\]|[-\d.]+/g) ?? []
  let budget = 70_000
  for (let i = 0; i < toks.length && budget > 0; ) {
    const start = Number(toks[i])
    const next = toks[i + 1]
    if (next?.startsWith('[')) {
      next.slice(1, -1).trim().split(/\s+/).forEach((x, k) => x && widths.set(start + k, Number(x)))
      i += 2
    } else {
      const end = Math.min(Number(next), start + 65_535)
      const width = Number(toks[i + 2])
      for (let c = start; c <= end && budget > 0; c++, budget--) widths.set(c, width)
      i += 3
    }
  }
  return { widths, defaultWidth: dw }
}

// the page's fonts by resource name, resources can sit on a parent in the page tree
function fontsOf(objs: Map<number, PdfObj>, page: number, cache: Map<number, CMap | null>): Map<string, Font> {
  const fonts = new Map<string, Font>()
  let node: number | null = page
  for (let depth = 0; node !== null && depth < 50; depth++) {
    const body: string = objs.get(node)?.body ?? ''
    const res = dictOf(objs, body, 'Resources')
    if (res !== null) {
      const fontDict = dictOf(objs, res, 'Font') ?? ''
      for (const m of fontDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
        const fbody = objs.get(Number(m[2]))?.body ?? ''
        const type0 = /\/Subtype\s*\/Type0/.test(fbody)
        const tu = refOf(fbody, 'ToUnicode')
        let cmap: CMap | null = null
        if (tu !== null) {
          if (!cache.has(tu)) {
            const data = decodeStream(objs.get(tu))
            cache.set(tu, data ? parseCMap(data.toString('latin1')) : null)
          }
          cmap = cache.get(tu) ?? null
        }
        fonts.set(m[1], { bytes: type0 ? 2 : (cmap?.bytes ?? 1), cmap, ...widthsOf(objs, fbody, type0) })
      }
      break
    }
    node = refOf(body, 'Parent')
  }
  return fonts
}

const utf16 = (hex: string): string => {
  if (hex.length <= 2) return hex ? String.fromCharCode(parseInt(hex, 16)) : ''
  let s = ''
  for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16))
  return s
}

export function parseCMap(s: string): CMap {
  const map = new Map<number, string>()
  const space = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(s)
  const bytes = space ? Math.max(1, Math.ceil(space[1].length / 2)) : 2
  for (const block of s.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(m[1], 16), utf16(m[2]))
  }
  let budget = 70_000
  for (const block of s.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1], 16)
      const hi = Math.min(parseInt(m[2], 16), lo + 65_535)
      if (m[3].startsWith('[')) {
        const items = [...m[3].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => utf16(x[1]))
        items.forEach((t, i) => lo + i <= hi && map.set(lo + i, t))
      } else {
        const base = utf16(m[3].slice(1, -1))
        if (!base) continue
        const head = base.slice(0, -1)
        const last = base.charCodeAt(base.length - 1)
        for (let c = lo; c <= hi && budget > 0; c++, budget--) map.set(c, head + String.fromCharCode(last + c - lo))
      }
    }
  }
  return { bytes, map }
}

// the few winansi codes that differ from latin1 and matter for reading
const WIN_ANSI: Record<number, string> = {
  0x80: '€', 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”',
  0x95: '•', 0x96: '–', 0x97: '—', 0x99: '™'
}

// the codes in a shown string and the text for each, '' when it can't be read
function decodeShow(bytes: number[], font: Font | undefined): { codes: number[]; text: string[] } {
  const w = font?.bytes ?? 1
  const codes: number[] = []
  const text: string[] = []
  for (let i = 0; i + w <= bytes.length; i += w) {
    let code = 0
    for (let j = 0; j < w; j++) code = code * 256 + bytes[i + j]
    codes.push(code)
    const mapped = font?.cmap?.map.get(code)
    if (mapped !== undefined) text.push(mapped)
    // two byte glyph ids with no map can't be read
    else if (w === 2) text.push('')
    else text.push(WIN_ANSI[code] ?? (code >= 0x20 && code !== 0x7f ? String.fromCharCode(code) : code === 9 ? ' ' : ''))
  }
  return { codes, text }
}

type Token = { t: 'str'; v: number[] } | { t: 'num'; v: number } | { t: 'name'; v: string } | { t: 'arr'; v: Token[] } | { t: 'op'; v: string }

const WS = /[\s\0]/
const DELIM = /[\s\0()<>[\]{}/%]/

function readLiteral(s: string, i: number): [number[], number] {
  // s[i] is '('
  const out: number[] = []
  let depth = 1
  i++
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') {
      const n = s[i + 1]
      i += 2
      if (n === undefined) break
      const esc: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 }
      if (n in esc) out.push(esc[n])
      else if (/[0-7]/.test(n)) {
        let oct = n
        while (oct.length < 3 && /[0-7]/.test(s[i] ?? '')) oct += s[i++]
        out.push(parseInt(oct, 8) & 0xff)
      } else if (n === '\r') {
        if (s[i] === '\n') i++
      } else if (n !== '\n') out.push(n.charCodeAt(0) & 0xff)
      continue
    }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return [out, i + 1]
    out.push(c.charCodeAt(0) & 0xff)
    i++
  }
  return [out, i]
}

function readHex(s: string, i: number): [number[], number] {
  // s[i] is '<'
  const end = s.indexOf('>', i)
  const stop = end < 0 ? s.length : end
  let hex = s.slice(i + 1, stop).replace(/[^0-9a-fA-F]/g, '')
  if (hex.length % 2) hex += '0'
  const out: number[] = []
  for (let k = 0; k < hex.length; k += 2) out.push(parseInt(hex.slice(k, k + 2), 16))
  return [out, stop + 1]
}

type Matrix = [number, number, number, number, number, number]
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

// m1 then m2, the pdf way round
function mul(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5]
  ]
}

const shift = (tx: number, ty: number, m: Matrix): Matrix => mul([1, 0, 0, 1, tx, ty], m)

// runs the text operators of a content stream and returns what they show. spaces and line
// breaks come from where each piece of text lands compared to where the last one ended
export function contentText(s: string, fonts: Map<string, Font>): string {
  const out: string[] = []
  const stack: Token[] = []
  const arrays: Token[][] = []
  const saved: Matrix[] = []
  let ctm: Matrix = IDENTITY
  let tm: Matrix = IDENTITY
  let tlm: Matrix = IDENTITY
  let font: Font | undefined
  let size = 12
  let charSpace = 0
  let wordSpace = 0
  let scale = 1
  let leading = 0
  // where the last shown text ended, on the page
  let last: { y: number; endX: number; size: number } | null = null
  let spaceNext = false

  const push = (tok: Token): void => {
    if (arrays.length) arrays[arrays.length - 1].push(tok)
    else stack.push(tok)
  }
  const nums = (): number[] => stack.filter((x) => x.t === 'num').map((x) => x.v as number)
  const ends = (): string => out[out.length - 1]?.slice(-1) ?? '\n'

  const show = (bytes: number[]): void => {
    const { codes, text } = decodeShow(bytes, font)
    const m = mul(tm, ctm)
    const x = m[4]
    const y = m[5]
    const em = Math.abs(size) * (Math.hypot(m[2], m[3]) || 1)
    const joined = text.join('')
    if (last && joined) {
      const lineGap = Math.abs(y - last.y)
      const tall = Math.max(em, last.size)
      const gap = x - last.endX
      const end = ends()
      if (lineGap > tall * 1.8) out.push('\n\n')
      else if (lineGap > tall * 0.5) out.push('\n')
      else if (end !== ' ' && end !== '\n' && !/^\s/.test(joined)) {
        // without real widths the end is a guess, so it takes a bigger gap
        const need = font?.widths ? 0.15 : 0.3
        if (spaceNext || gap > em * need || gap < -em * 2) out.push(' ')
      }
    }
    spaceNext = false
    if (joined) out.push(joined)
    let advance = 0
    codes.forEach((code, k) => {
      const w = font?.widths ? (font.widths.get(code) ?? font.defaultWidth) : text[k] === ' ' ? 250 : 500
      advance += ((w / 1000) * size + charSpace + (code === 32 && (font?.bytes ?? 1) === 1 ? wordSpace : 0)) * scale
    })
    tm = shift(advance, 0, tm)
    if (joined) last = { y, endX: mul(tm, ctm)[4], size: em }
  }

  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (WS.test(c)) {
      i++
      continue
    }
    if (c === '%') {
      while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++
      continue
    }
    if (c === '(') {
      const [v, next] = readLiteral(s, i)
      push({ t: 'str', v })
      i = next
      continue
    }
    if (c === '<' && s[i + 1] === '<') {
      i += 2
      continue
    }
    if (c === '>' && s[i + 1] === '>') {
      i += 2
      continue
    }
    if (c === '<') {
      const [v, next] = readHex(s, i)
      push({ t: 'str', v })
      i = next
      continue
    }
    if (c === '[') {
      arrays.push([])
      i++
      continue
    }
    if (c === ']') {
      const arr = arrays.pop()
      i++
      if (arr) push({ t: 'arr', v: arr })
      continue
    }
    if (c === '{' || c === '}' || c === ')' || c === '>') {
      i++
      continue
    }
    let j = i + 1
    while (j < s.length && !DELIM.test(s[j])) j++
    const word = s.slice(i, j)
    i = j
    if (c === '/') {
      push({ t: 'name', v: word.slice(1) })
      continue
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      push({ t: 'num', v: Number(word) })
      continue
    }
    if (arrays.length) continue
    // an operator, with its operands on the stack
    const top = stack[stack.length - 1]
    const n = nums()
    switch (word) {
      case 'q':
        if (saved.length < 64) saved.push(ctm)
        break
      case 'Q':
        ctm = saved.pop() ?? ctm
        break
      case 'cm':
        if (n.length >= 6) ctm = mul(n.slice(-6) as Matrix, ctm)
        break
      case 'BT':
        tm = tlm = IDENTITY
        break
      case 'Tf': {
        const name = stack.find((x) => x.t === 'name')
        if (name) font = fonts.get(name.v as string)
        if (n.length) size = n[n.length - 1]
        break
      }
      case 'Tc':
        if (n.length) charSpace = n[0]
        break
      case 'Tw':
        if (n.length) wordSpace = n[0]
        break
      case 'Tz':
        if (n.length) scale = n[0] / 100
        break
      case 'TL':
        if (n.length) leading = n[0]
        break
      case 'Tm':
        if (n.length >= 6) tm = tlm = n.slice(-6) as Matrix
        break
      case 'Td':
      case 'TD':
        if (n.length >= 2) {
          if (word === 'TD') leading = -n[1]
          tm = tlm = shift(n[0], n[1], tlm)
        }
        break
      case 'T*':
        tm = tlm = shift(0, -leading, tlm)
        break
      case 'Tj':
        if (top?.t === 'str') show(top.v)
        break
      case "'":
      case '"':
        if (word === '"' && n.length >= 2) {
          wordSpace = n[0]
          charSpace = n[1]
        }
        tm = tlm = shift(0, -leading, tlm)
        if (top?.t === 'str') show(top.v)
        break
      case 'TJ':
        if (top?.t === 'arr') {
          for (const part of top.v) {
            if (part.t === 'str') show(part.v)
            else if (part.t === 'num') {
              tm = shift((-part.v / 1000) * size * scale, 0, tm)
              if (part.v < -180) spaceNext = true
            }
          }
        }
        break
      case 'ID': {
        // inline image data, skip to its end
        const end = s.slice(i).search(/\sEI(?=[\s\0]|$)/)
        i = end < 0 ? s.length : i + end + 3
        break
      }
    }
    stack.length = 0
  }
  return out.join('')
}

// ---------- folder ----------

const relName = (root: string, full: string): string => relative(root, full).split(sep).join('/')

// files in the folder that could be docs, hidden folders and node_modules left out, links not followed
export async function listDocFiles(root: string, cap = DOC_FILE_CAP): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= cap || depth > 12) return
    let entries: import('node:fs').Dirent[]
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
        if (!skipDir(e.name)) await walk(full, depth + 1)
      } else if (e.isFile() && isDocFile(e.name)) out.push(full)
    }
  }
  await walk(root, 0)
  return out
}

const pause = (): Promise<void> => new Promise((r) => setImmediate(r))

// reads the folder again, files that didn't change since last time keep their text
export async function scanDocs(root: string, prev: DocsIndex | null, now = Date.now()): Promise<DocsIndex> {
  const old = new Map((prev?.folder === root ? prev.files : []).map((f) => [f.file, f]))
  const files: DocEntry[] = []
  let total = 0
  for (const full of await listDocFiles(root)) {
    const file = relName(root, full)
    let st: import('node:fs').Stats
    try {
      st = await fs.stat(full)
    } catch {
      continue
    }
    const had = old.get(file)
    let text = ''
    if (had && had.mtimeMs === st.mtimeMs && had.size === st.size) text = had.text
    else if (st.size <= DOC_BYTES_CAP && total < TOTAL_TEXT_CAP) {
      try {
        text = textOf(file, await fs.readFile(full))
      } catch {
        text = ''
      }
      await pause()
    }
    if (total + text.length > TOTAL_TEXT_CAP) text = text.slice(0, Math.max(0, TOTAL_TEXT_CAP - total))
    total += text.length
    files.push({ file, size: st.size, mtimeMs: st.mtimeMs, text })
  }
  return { folder: root, indexedAt: now, files }
}

export function cleanDocsIndex(raw: unknown): DocsIndex | null {
  if (!raw || typeof raw !== 'object') return null
  const x = raw as Partial<DocsIndex>
  if (typeof x.folder !== 'string' || !Array.isArray(x.files)) return null
  const files = x.files.filter(
    (f): f is DocEntry =>
      !!f && typeof f.file === 'string' && typeof f.text === 'string' && typeof f.size === 'number' && typeof f.mtimeMs === 'number'
  )
  return { folder: x.folder, indexedAt: typeof x.indexedAt === 'number' ? x.indexedAt : 0, files }
}

// ---------- search ----------

export interface Searchable {
  name: string
  text: string
}

export interface SearchHit<T extends Searchable> {
  item: T
  score: number
  snippet: string
}

export function tokenize(q: string): string[] {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return [...new Set(words.filter((w) => w.length >= 2 || /\p{N}/u.test(w)))].slice(0, 20)
}

const PER_TERM_CAP = 25
// a term in the file name counts like this many hits
const NAME_BOOST = 3
const SNIPPET = 400

function hits(lower: string, term: string, cap: number): number[] {
  const at: number[] = []
  let i = lower.indexOf(term)
  while (i >= 0 && at.length < cap) {
    at.push(i)
    i = lower.indexOf(term, i + term.length)
  }
  return at
}

// a window of about SNIPPET chars around the spot where the most different terms are close together
export function snippetAround(text: string, terms: string[], size = SNIPPET): string {
  const lower = text.toLowerCase()
  const spots = terms.flatMap((t) => hits(lower, t, 50).map((p) => ({ p, t })))
  if (!spots.length) return clean(text.slice(0, size), false, text.length > size)
  spots.sort((a, b) => a.p - b.p)
  let best = spots[0].p
  let bestCount = 0
  for (const s of spots) {
    const near = new Set(spots.filter((o) => o.p >= s.p && o.p < s.p + size * 0.6).map((o) => o.t)).size
    if (near > bestCount) {
      bestCount = near
      best = s.p
    }
  }
  let start = Math.max(0, best - Math.floor(size * 0.25))
  let end = Math.min(text.length, start + size)
  start = Math.max(0, end - size)
  // whole words at the edges
  if (start > 0) {
    const sp = text.slice(start, start + 30).search(/\s/)
    if (sp >= 0) start += sp + 1
  }
  if (end < text.length) {
    const sp = text.slice(Math.max(start, end - 30), end).search(/\s\S*$/)
    if (sp >= 0) end = Math.max(start, end - 30) + sp
  }
  return clean(text.slice(start, end), start > 0, end < text.length)
}

const clean = (s: string, before: boolean, after: boolean): string =>
  `${before ? '...' : ''}${s.replace(/\s+/g, ' ').trim()}${after ? '...' : ''}`

export function scoreText(name: string, lower: string, terms: string[], phrase: string): number {
  const lowerName = name.toLowerCase()
  let score = 0
  let matched = 0
  for (const t of terms) {
    const n = hits(lower, t, PER_TERM_CAP).length
    const inName = lowerName.includes(t)
    if (n || inName) matched++
    score += n + (inName ? NAME_BOOST : 0)
  }
  if (!score) return 0
  // more of the terms counts for more than many hits of one
  score *= matched / terms.length
  if (terms.length > 1 && phrase && lower.includes(phrase)) score += 5
  return Math.round(score * 100) / 100
}

// simple term scoring: hits per term, capped, with a boost when the file name has the term
export function searchTexts<T extends Searchable>(items: T[], query: string, limit = 5): SearchHit<T>[] {
  const terms = tokenize(query)
  if (!terms.length) return []
  const phrase = query.toLowerCase().replace(/\s+/g, ' ').trim()
  const out: SearchHit<T>[] = []
  for (const item of items) {
    const score = scoreText(item.name, item.text.toLowerCase(), terms, phrase)
    if (score > 0) out.push({ item, score, snippet: '' })
  }
  out.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
  const top = out.slice(0, Math.max(1, limit))
  for (const h of top) h.snippet = snippetAround(h.item.text, terms)
  return top
}
