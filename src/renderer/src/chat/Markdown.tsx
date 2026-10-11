import { memo, useState, type ReactNode } from 'react'
import { EMBED_LANG } from '@shared/chat'
import { safeHref } from './api'

// a small markdown renderer that builds react elements, never raw html.
// covers what agents write: headings, lists, quotes, tables, code and links

type Block =
  | { kind: 'code'; lang: string; text: string; closed: boolean }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: { text: string; depth: number }[] }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'hr' }
  | { kind: 'para'; text: string }

const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = FENCE.exec(line)
    if (fence) {
      const close = fence[1]
      const body: string[] = []
      i++
      let closed = false
      while (i < lines.length) {
        if (lines[i].trim().startsWith(close) && lines[i].trim().replace(/[`~]/g, '') === '') {
          closed = true
          i++
          break
        }
        body.push(lines[i])
        i++
      }
      blocks.push({ kind: 'code', lang: fence[2].toLowerCase(), text: body.join('\n'), closed })
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      blocks.push({ kind: 'heading', level: h[1].length, text: h[2].replace(/\s#+$/, '') })
      i++
      continue
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: 'hr' })
      i++
      continue
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      blocks.push({ kind: 'quote', text: body.join('\n') })
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = splitRow(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]))
      blocks.push({ kind: 'table', head, rows })
      continue
    }
    const li = LIST_ITEM.exec(line)
    if (li) {
      const ordered = /\d/.test(li[2])
      const items: { text: string; depth: number }[] = []
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i])
        if (m) {
          items.push({ text: m[3], depth: Math.min(3, Math.floor(m[1].replace(/\t/g, '  ').length / 2)) })
          i++
        } else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
          // a wrapped line that belongs to the item above
          items[items.length - 1].text += `\n${lines[i].trim()}`
          i++
        } else break
      }
      blocks.push({ kind: 'list', ordered, start: ordered ? parseInt(li[2], 10) || 1 : 1, items })
      continue
    }
    const body: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !(body.length && LIST_ITEM.test(lines[i]))
    ) {
      body.push(lines[i++])
    }
    blocks.push({ kind: 'para', text: body.join('\n') })
  }
  return blocks
}

// inline bits, matched left to right, the earliest match wins
const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|\n/g

export function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const k = `${key}-${n++}`
    if (m[1]) out.push(<code key={k}>{m[2]}</code>)
    else if (m[3] !== undefined) out.push(<strong key={k}>{inline(m[3], k)}</strong>)
    else if (m[4] !== undefined) out.push(<strong key={k}>{inline(m[4], k)}</strong>)
    else if (m[5] !== undefined) out.push(<s key={k}>{inline(m[5], k)}</s>)
    else if (m[6] !== undefined) out.push(<em key={k}>{inline(m[6], k)}</em>)
    else if (m[7] !== undefined) out.push(<em key={k}>{inline(m[7], k)}</em>)
    else if (m[8] !== undefined) {
      const href = safeHref(m[9])
      out.push(
        href ? (
          <a key={k} href={href} target="_blank" rel="noreferrer" title={href}>
            {inline(m[8], k)}
          </a>
        ) : (
          <span key={k}>{m[8]}</span>
        )
      )
    } else if (m[10]) {
      const href = safeHref(m[10])
      out.push(
        href ? (
          <a key={k} href={href} target="_blank" rel="noreferrer">
            {m[10]}
          </a>
        ) : (
          m[10]
        )
      )
    } else out.push(<br key={k} />)
    last = at + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function CodeBlock({ lang, text }: { lang: string; text: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  return (
    <div className="cx-code">
      <div className="cx-code-head">
        <span>{lang || 'text'}</span>
        <button
          className="cx-code-copy"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            })
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  )
}

interface Props {
  text: string
  // renders a trenddeck block, closed is false while it's still streaming in
  embed?: (raw: string, closed: boolean, key: string) => ReactNode
}

function Markdown({ text, embed }: Props): ReactNode {
  const blocks = parseBlocks(text)
  const isEmbed = (b: Block | undefined): boolean => !!embed && b?.kind === 'code' && b.lang === EMBED_LANG
  const out: ReactNode[] = []
  for (let i = 0; i < blocks.length; i++) {
    // cards next to each other get dealt into one row, like a hand
    if (isEmbed(blocks[i]) && embed) {
      const hand: ReactNode[] = []
      const first = i
      while (isEmbed(blocks[i])) {
        const b = blocks[i] as Extract<Block, { kind: 'code' }>
        hand.push(embed(b.text, b.closed, `e${i}`))
        i++
      }
      i--
      out.push(
        <div key={`h${first}`} className="cx-hand">
          {hand}
        </div>
      )
      continue
    }
    out.push(renderBlock(blocks[i], `b${i}`))
  }
  return <div className="cx-md">{out}</div>
}

function renderBlock(b: Block, key: string): ReactNode {
  switch (b.kind) {
    case 'code':
      return <CodeBlock key={key} lang={b.lang} text={b.text} />
    case 'heading': {
      const Tag = `h${Math.min(6, b.level + 2)}` as 'h3'
      return <Tag key={key}>{inline(b.text, key)}</Tag>
    }
    case 'hr':
      return <hr key={key} />
    case 'quote':
      return <blockquote key={key}>{inline(b.text, key)}</blockquote>
    case 'table':
      return (
        <div key={key} className="cx-table">
          <table>
            <thead>
              <tr>
                {b.head.map((c, j) => (
                  <th key={j}>{inline(c, `${key}h${j}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, j) => (
                <tr key={j}>
                  {r.map((c, k) => (
                    <td key={k}>{inline(c, `${key}r${j}${k}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'list': {
      const Tag = b.ordered ? 'ol' : 'ul'
      return (
        <Tag key={key} start={b.ordered ? b.start : undefined}>
          {b.items.map((it, j) => (
            <li key={j} className={it.depth ? `d${it.depth}` : undefined}>
              {inline(it.text, `${key}l${j}`)}
            </li>
          ))}
        </Tag>
      )
    }
    default:
      return <p key={key}>{inline(b.text, key)}</p>
  }
}

export default memo(Markdown)
