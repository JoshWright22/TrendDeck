// words as the cadence check, the script's quote check and the take diff see them:
// lowercase, curly quotes made straight, punctuation off the ends. pure

export function normWord(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/^[^a-z0-9À-ɏЀ-ӿ]+|[^a-z0-9À-ɏЀ-ӿ]+$/g, '')
}

// the words of a piece of text, normalized, empty ones dropped
export function tokens(text: string): string[] {
  return text
    .split(/[\s—]+|(?<=[a-z0-9])[,;:!?.]+(?=[a-z])/i)
    .map(normWord)
    .filter(Boolean)
}

// words people say while thinking. "like" only counts as one when a comma follows it
export const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'erm', 'er', 'ah', 'hmm', 'mm', 'mhm'])
export const FILLER_PHRASES = ['you know', 'i mean', 'kind of', 'sort of']

export function isFiller(word: string): boolean {
  return FILLERS.has(normWord(word))
}

// a raw word from Whisper or a script ends a sentence
export function endsSentence(raw: string): boolean {
  return /[.!?]["')\]]?$/.test(raw.trim())
}

// sentences of a line of script, split at . ! ?
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])["')\]]?\s+(?=["'(\[]?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => tokens(s).length > 0)
}

export const CONTRACTION = /\b[a-z]+'(s|re|ve|ll|d|m|t)\b|\b(can't|won't|ain't)\b/i

const STOP = new Set(
  'a an the and or but so to of in on at for with is are was were be been it its this that i you we they he she my your our me us them as if then than just do did does not no yes oh'.split(' ')
)

export function isStopWord(w: string): boolean {
  return STOP.has(w)
}
