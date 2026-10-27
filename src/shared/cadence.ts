import type { SpokenWord } from './speech'
import type { TakeFeedback, TimedNote } from './take'
import { CONTRACTION, endsSentence, FILLER_PHRASES, isFiller, isStopWord, normWord, sentences, tokens } from './words'

// how the creator talks, measured from Whisper's word times: pace, sentence length, pauses,
// fillers, contractions and the phrases they keep using. every dictation and take adds to the
// brand's profile; script drafts and takes get checked against it. advice, never a score. pure

// what one recording says about the speaker
export interface CadenceSample {
  words: number
  // seconds of talking, long pauses taken out
  seconds: number
  wpm: number
  sentenceLengths: number[]
  // gaps between words of 0.3 s and longer
  pauses: number[]
  fillers: number
  contractions: number
  you: number
  // content words and short phrases with how often they came up
  vocab: Record<string, number>
  phrases: Record<string, number>
}

export interface CadenceProfile {
  version: 1
  samples: number
  words: number
  seconds: number
  // newest last, capped
  wpms: number[]
  sentenceLengths: number[]
  pauses: number[]
  fillers: number
  contractions: number
  you: number
  vocab: Record<string, number>
  phrases: Record<string, number>
  updatedAt: number
}

export interface CadenceSummary {
  wpm: { median: number; p10: number; p90: number }
  sentence: { mean: number; p90: number }
  pause: { median: number; p90: number }
  fillerPer100: number
  contractionPer100: number
  youPer100: number
  favoritePhrases: { phrase: string; count: number }[]
  words: number
}

// pauses longer than this are thinking, not pace
const LONG_GAP = 2
const MIN_PAUSE = 0.3
const KEEP_NUMBERS = 600
const KEEP_VOCAB = 3000
const KEEP_PHRASES = 300

export function emptyProfile(): CadenceProfile {
  return { version: 1, samples: 0, words: 0, seconds: 0, wpms: [], sentenceLengths: [], pauses: [], fillers: 0, contractions: 0, you: 0, vocab: {}, phrases: {}, updatedAt: 0 }
}

export function quantile(values: number[], q: number): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const at = (s.length - 1) * q
  const lo = Math.floor(at)
  const hi = Math.ceil(at)
  return s[lo] + (s[hi] - s[lo]) * (at - lo)
}

const round = (n: number, d = 1): number => Math.round(n * 10 ** d) / 10 ** d

function count(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by
}

function top(map: Record<string, number>, n: number): Record<string, number> {
  return Object.fromEntries(
    Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
  )
}

// two to four word phrases that aren't all little words
function phrasesOf(words: string[], into: Record<string, number>): void {
  for (let n = 2; n <= 4; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const gram = words.slice(i, i + n)
      if (gram.every(isStopWord) || gram.some((w) => isFiller(w))) continue
      if (isStopWord(gram[0]) && isStopWord(gram[n - 1]) && n === 2) continue
      count(into, gram.join(' '))
    }
  }
}

export function analyzeWords(words: SpokenWord[]): CadenceSample {
  const clean = words.filter((w) => normWord(w.text))
  const norm = clean.map((w) => normWord(w.text))
  let seconds = 0
  const pauses: number[] = []
  for (let i = 0; i < clean.length; i++) {
    seconds += Math.max(0, clean[i].end - clean[i].start)
    if (i > 0) {
      const gap = clean[i].start - clean[i - 1].end
      if (gap >= MIN_PAUSE) pauses.push(round(gap, 2))
      // a long gap is thinking, it counts as one breath
      if (gap > 0) seconds += gap <= LONG_GAP ? gap : 0.5
    }
  }
  const sentenceLengths: number[] = []
  let run = 0
  for (const w of clean) {
    if (!isFiller(w.text)) run++
    if (endsSentence(w.text)) {
      if (run) sentenceLengths.push(run)
      run = 0
    }
  }
  if (run) sentenceLengths.push(run)
  const joined = ` ${norm.join(' ')} `
  let fillers = norm.filter((w) => isFiller(w)).length
  for (const p of FILLER_PHRASES) fillers += joined.split(` ${p} `).length - 1
  // "like," as a filler
  fillers += clean.filter((w) => /^like,$/i.test(w.text.trim())).length
  const vocab: Record<string, number> = {}
  for (const w of norm) if (w.length > 2 && !isStopWord(w) && !isFiller(w)) count(vocab, w)
  const phrases: Record<string, number> = {}
  phrasesOf(
    norm.filter((w) => !isFiller(w)),
    phrases
  )
  const n = norm.length
  return {
    words: n,
    seconds: round(seconds, 2),
    wpm: seconds > 0 ? round((n / seconds) * 60) : 0,
    sentenceLengths,
    pauses,
    fillers,
    contractions: clean.filter((w) => CONTRACTION.test(w.text)).length,
    you: norm.filter((w) => w === 'you' || w === 'your' || w === "you're" || w === 'yours' || w === "you've" || w === "you'll").length,
    vocab,
    phrases
  }
}

const tail = (list: number[], add: number[], n = KEEP_NUMBERS): number[] => [...list, ...add].slice(-n)

// a sample under 8 words says little about pace, it only adds words and phrases
export function addSample(profile: CadenceProfile, s: CadenceSample, now = Date.now()): CadenceProfile {
  if (!s.words) return profile
  const vocab = { ...profile.vocab }
  for (const [k, v] of Object.entries(s.vocab)) count(vocab, k, v)
  const phrases = { ...profile.phrases }
  for (const [k, v] of Object.entries(s.phrases)) count(phrases, k, v)
  return {
    version: 1,
    samples: profile.samples + 1,
    words: profile.words + s.words,
    seconds: round(profile.seconds + s.seconds, 2),
    wpms: s.words >= 8 && s.wpm > 0 ? tail(profile.wpms, [s.wpm], 200) : profile.wpms,
    sentenceLengths: tail(profile.sentenceLengths, s.sentenceLengths),
    pauses: tail(profile.pauses, s.pauses),
    fillers: profile.fillers + s.fillers,
    contractions: profile.contractions + s.contractions,
    you: profile.you + s.you,
    vocab: top(vocab, KEEP_VOCAB),
    phrases: top(phrases, KEEP_PHRASES),
    updatedAt: now
  }
}

// whatever was on disk, back to a profile
export function cleanProfile(raw: unknown): CadenceProfile {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<CadenceProfile>
  const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).slice(-KEEP_NUMBERS) : [])
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
  const map = (v: unknown, cap: number): Record<string, number> =>
    v && typeof v === 'object'
      ? top(Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k, x]) => k.length <= 80 && typeof x === 'number' && x > 0)) as Record<string, number>, cap)
      : {}
  return {
    version: 1,
    samples: n(p.samples),
    words: n(p.words),
    seconds: n(p.seconds),
    wpms: nums(p.wpms),
    sentenceLengths: nums(p.sentenceLengths),
    pauses: nums(p.pauses),
    fillers: n(p.fillers),
    contractions: n(p.contractions),
    you: n(p.you),
    vocab: map(p.vocab, KEEP_VOCAB),
    phrases: map(p.phrases, KEEP_PHRASES),
    updatedAt: n(p.updatedAt)
  }
}

export function summarize(p: CadenceProfile): CadenceSummary {
  const per100 = (x: number): number => (p.words ? round((x / p.words) * 100) : 0)
  return {
    wpm: { median: round(quantile(p.wpms, 0.5)), p10: round(quantile(p.wpms, 0.1)), p90: round(quantile(p.wpms, 0.9)) },
    sentence: {
      mean: p.sentenceLengths.length ? round(p.sentenceLengths.reduce((a, b) => a + b, 0) / p.sentenceLengths.length) : 0,
      p90: round(quantile(p.sentenceLengths, 0.9))
    },
    pause: { median: round(quantile(p.pauses, 0.5), 2), p90: round(quantile(p.pauses, 0.9), 2) },
    fillerPer100: per100(p.fillers),
    contractionPer100: per100(p.contractions),
    youPer100: per100(p.you),
    favoritePhrases: Object.entries(p.phrases)
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([phrase, c]) => ({ phrase, count: c })),
    words: p.words
  }
}

// one short block for the agent's context
export function profileText(p: CadenceProfile): string {
  if (p.words < 60) return ''
  const s = summarize(p)
  const lines = [
    `## How the creator talks (from ${p.words} spoken words)`,
    `- Pace about ${Math.round(s.wpm.median)} words a minute (${Math.round(s.wpm.p10)} to ${Math.round(s.wpm.p90)}).`,
    `- Sentences average ${s.sentence.mean} words, 90% are ${Math.round(s.sentence.p90)} or shorter. Write lines that short.`,
    `- ${s.contractionPer100 >= 1.5 ? 'Uses contractions a lot (don\'t, it\'s), so write them.' : 'Uses few contractions.'} Says "you" ${s.youPer100} times per 100 words.`
  ]
  if (s.favoritePhrases.length) lines.push(`- Phrases they use: ${s.favoritePhrases.slice(0, 8).map((f) => `"${f.phrase}"`).join(', ')}.`)
  return lines.join('\n')
}

// ---------- checking a draft before recording ----------

// words that read like a model wrote them, not like someone talking
export const AI_TELLS = [
  'delve',
  'delves',
  'moreover',
  'furthermore',
  'additionally',
  'in conclusion',
  'tapestry',
  'testament to',
  "it's important to note",
  'it is important to note',
  'in today\'s fast-paced',
  'navigate the',
  'landscape of',
  'realm of',
  'unlock',
  'unleash',
  'elevate',
  'game-changer',
  'seamless',
  'robust',
  'leverage',
  'utilize',
  'embark',
  'in essence',
  'nevertheless',
  'thus',
  'hence',
  'whilst',
  'myriad',
  'plethora'
]

const FULL_FORMS: [RegExp, string][] = [
  [/\bdo not\b/i, "don't"],
  [/\bdoes not\b/i, "doesn't"],
  [/\bit is\b/i, "it's"],
  [/\bthat is\b/i, "that's"],
  [/\byou are\b/i, "you're"],
  [/\bwe are\b/i, "we're"],
  [/\bi am\b/i, "I'm"],
  [/\bcannot\b/i, "can't"],
  [/\bwill not\b/i, "won't"],
  [/\bis not\b/i, "isn't"],
  [/\bare not\b/i, "aren't"],
  [/\bi have\b/i, "I've"],
  [/\bthere is\b/i, "there's"]
]

export interface DraftFlag {
  lineId: string
  kind: 'long-sentence' | 'ai-word' | 'written' | 'punctuation' | 'off-voice'
  text: string
}

export interface DraftLine {
  id: string
  text: string
  // spoken lines are the creator's own words, only length gets flagged on them
  spoken: boolean
}

export interface DraftCheck {
  flags: DraftFlag[]
  words: number
  // at the creator's own pace, or 150 words a minute before there's a profile
  seconds: number
  wpm: number
  profiled: boolean
}

export function checkDraft(lines: DraftLine[], profile: CadenceProfile | null): DraftCheck {
  const ready = !!profile && profile.words >= 200
  const s = ready ? summarize(profile!) : null
  const usual = s && s.sentence.mean ? s.sentence.mean : 14
  const limit = Math.max(s ? s.sentence.p90 * 1.3 : 24, usual + 8)
  const contracts = s ? s.contractionPer100 >= 1.5 : true
  const flags: DraftFlag[] = []
  let words = 0
  for (const line of lines) {
    const toks = tokens(line.text)
    words += toks.length
    for (const sentence of sentences(line.text)) {
      const n = tokens(sentence).length
      if (n > limit) {
        flags.push({ lineId: line.id, kind: 'long-sentence', text: `This sentence has ${n} words. You usually speak in sentences of about ${Math.round(usual)}. Split it where you'd breathe.` })
        break
      }
    }
    if (line.spoken) continue
    const lower = ` ${line.text.toLowerCase().replace(/[‘’]/g, "'")} `
    const tells = AI_TELLS.filter((t) => new RegExp(`[^a-z]${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^a-z]`).test(lower))
    if (tells.length) flags.push({ lineId: line.id, kind: 'ai-word', text: `"${tells[0]}" reads written, not spoken. Say it the way you would.` })
    if (contracts) {
      const full = FULL_FORMS.find(([re]) => re.test(line.text))
      if (full) flags.push({ lineId: line.id, kind: 'written', text: `"${full[0].exec(line.text)![0]}" sounds stiff out loud. You'd likely say "${full[1]}".` })
    }
    if (/[;()[\]]|—.*—/.test(line.text)) flags.push({ lineId: line.id, kind: 'punctuation', text: "Semicolons, brackets and asides don't read aloud well. Make it two sentences." })
    if (ready && profile!.words >= 500) {
      const content = toks.filter((t) => t.length >= 7 && !isStopWord(t))
      const unknown = content.filter((t) => !profile!.vocab[t])
      if (content.length >= 3 && unknown.length / content.length > 0.6) {
        flags.push({ lineId: line.id, kind: 'off-voice', text: `Words you haven't used when talking: ${unknown.slice(0, 3).map((u) => `"${u}"`).join(', ')}. Use your own words.` })
      }
    }
  }
  const wpm = s && s.wpm.median ? s.wpm.median : 150
  return { flags, words, seconds: Math.round((words / wpm) * 60), wpm, profiled: ready }
}

// ---------- feedback on a take ----------

const clock = (t: number): string => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`

export function takeFeedback(words: SpokenWord[], profile: CadenceProfile | null): TakeFeedback {
  const sample = analyzeWords(words)
  const usual = profile && profile.wpms.length >= 3 ? round(quantile(profile.wpms, 0.5)) : null
  const fillers = words.filter((w) => isFiller(w.text) || /^like,$/i.test(w.text.trim())).map((w) => ({ at: round(w.start, 2), word: normWord(w.text) }))
  const longPauses: TakeFeedback['longPauses'] = []
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end
    if (gap >= 1.5) longPauses.push({ at: round(words[i - 1].end, 2), seconds: round(gap) })
  }
  const notes: TimedNote[] = []
  // pace in 15 second windows against the usual pace, or this take's own when there's no profile
  const base = usual ?? sample.wpm
  if (base > 0 && words.length >= 20) {
    const end = words[words.length - 1].end
    for (let from = words[0].start; from + 10 < end; from += 15) {
      const inWin = words.filter((w) => w.start >= from && w.start < from + 15)
      if (inWin.length < 8) continue
      const span = inWin[inWin.length - 1].end - inWin[0].start
      if (span < 6) continue
      const wpm = (inWin.length / span) * 60
      if (wpm > base * 1.25) notes.push({ at: round(inWin[0].start, 2), text: `You sped up to about ${Math.round(wpm)} words a minute here (you usually talk at ${Math.round(base)}).` })
      else if (wpm < base * 0.7) notes.push({ at: round(inWin[0].start, 2), text: `This part runs slow, about ${Math.round(wpm)} words a minute.` })
    }
  }
  for (const p of longPauses.slice(0, 5)) notes.push({ at: p.at, text: `${p.seconds} s pause at ${clock(p.at)}. Keep it if it lands a point, cut it if you lost your place.` })
  if (fillers.length >= 3) notes.push({ at: fillers[0].at, text: `${fillers.length} filler words (${[...new Set(fillers.map((f) => f.word))].slice(0, 3).join(', ')}). The first is here.` })
  notes.sort((a, b) => a.at - b.at)
  return {
    duration: words.length ? round(words[words.length - 1].end, 2) : 0,
    words: sample.words,
    wpm: sample.wpm,
    usualWpm: usual,
    fillers,
    longPauses,
    notes
  }
}
