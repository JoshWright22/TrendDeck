import type { ScriptLine } from './script'
import type { SpokenWord } from './speech'
import type { LineMatch, LineStatus, Pickup, TakeDiff } from './take'
import { isFiller, normWord, tokens } from './words'

// a take against its script: which lines were said, said differently, flubbed or skipped, and
// the pickup list of lines to record again with where they went wrong. word level alignment of
// the script's words to the take's words (filler words left out of both). pure, unit tested

interface Tok {
  t: string
  // index of the script line, or of the take word
  i: number
}

// longest common subsequence of the two word lists, as pairs of positions
function lcs(a: string[], b: string[]): [number, number][] {
  const n = a.length
  const m = b.length
  // a take can be long, keep the table to what fits
  if (n * m > 4_000_000) return greedy(a, b)
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return out
}

// for very long takes: walk forward, matching each script word to the next time it's said nearby
function greedy(a: string[], b: string[]): [number, number][] {
  const out: [number, number][] = []
  let j = 0
  for (let i = 0; i < a.length && j < b.length; i++) {
    const k = b.indexOf(a[i], j)
    if (k >= 0 && k - j < 40) {
      out.push([i, k])
      j = k + 1
    }
  }
  return out
}

const round = (n: number): number => Math.round(n * 100) / 100

// a line said twice in a row (a restart) or with a long stumble in the middle is flubbed
function restarted(words: SpokenWord[], from: number, to: number): boolean {
  const said = words.slice(from, to + 1).map((w) => normWord(w.text)).filter((t) => t && !isFiller(t))
  for (let len = 2; len <= 4; len++) {
    for (let i = 0; i + 2 * len <= said.length; i++) {
      if (said.slice(i, i + len).join(' ') === said.slice(i + len, i + 2 * len).join(' ')) return true
    }
  }
  return false
}

export function diffTake(lines: ScriptLine[], words: SpokenWord[], scriptFile = ''): TakeDiff {
  const script: Tok[] = []
  lines.forEach((l, i) => tokens(l.text).filter((t) => !isFiller(t)).forEach((t) => script.push({ t, i })))
  const take: Tok[] = []
  words.forEach((w, i) => {
    for (const t of tokens(w.text)) if (!isFiller(t)) take.push({ t, i })
  })
  const pairs = lcs(
    script.map((s) => s.t),
    take.map((s) => s.t)
  )
  // per line: matched take word indexes
  const hits = lines.map(() => [] as number[])
  for (const [si, ti] of pairs) hits[script[si].i].push(take[ti].i)
  const totals = lines.map((_, i) => script.filter((s) => s.i === i).length)

  const matches: LineMatch[] = lines.map((l, i) => {
    const got = hits[i]
    const coverage = totals[i] ? got.length / totals[i] : 1
    if (!got.length || coverage < 0.34) {
      return { lineId: l.id, text: l.text, status: 'missed', coverage: Math.round(coverage * 100) / 100, from: null, to: null, said: '' }
    }
    const first = Math.min(...got)
    const last = Math.max(...got)
    const said = words
      .slice(first, last + 1)
      .map((w) => w.text.trim())
      .join(' ')
    // extra words said inside the line's span that the script doesn't have
    const spanWords = words.slice(first, last + 1).filter((w) => !isFiller(w.text) && normWord(w.text)).length
    const extra = spanWords - got.length
    let status: LineStatus = 'said'
    if (restarted(words, first, last)) status = 'flubbed'
    else if (coverage < 0.85 || extra > Math.max(2, totals[i] * 0.3)) status = 'paraphrased'
    return { lineId: l.id, text: l.text, status, coverage: Math.round(coverage * 100) / 100, from: round(words[first].start), to: round(words[last].end), said }
  })

  const pickups: Pickup[] = []
  for (const m of matches) {
    if (m.status === 'missed') pickups.push({ lineId: m.lineId, text: m.text, reason: 'Not in this take.', at: null })
    else if (m.status === 'flubbed') pickups.push({ lineId: m.lineId, text: m.text, reason: 'Restarted partway through.', at: m.from })
    else if (m.status === 'paraphrased' && m.coverage < 0.6) pickups.push({ lineId: m.lineId, text: m.text, reason: 'Said quite differently. Keep your version or record the line again.', at: m.from })
  }
  return { scriptFile, lines: matches, pickups }
}

// the paraphrases worth learning from: what the script said and what the creator said instead
export function paraphrases(diff: TakeDiff): { lineId: string; script: string; said: string }[] {
  return diff.lines.filter((l) => l.status === 'paraphrased' && l.said).map((l) => ({ lineId: l.lineId, script: l.text, said: l.said }))
}
