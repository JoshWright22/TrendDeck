// context the chat agent can read for a brand: a folder of brand docs, transcripts of past
// videos from the project folders, and style rules the user confirmed. main owns the files,
// see main/context

export const STYLE_RULE_MAX = 40
export const STYLE_RULE_CHARS = 280
export const STYLE_WHY_CHARS = 300

export interface StyleRule {
  id: string
  text: string
  createdAt: number
  // agent: saved with remember_style. user: typed in settings
  source: 'agent' | 'user'
  why?: string
}

// names only, the renderer never gets absolute paths of the files
export interface ContextDoc {
  // relative to the docs folder, forward slashes
  file: string
  // characters of text found, 0 when none was found (e.g. a scanned pdf)
  chars: number
  modified: number
}

export interface ContextTranscript {
  project: string
  // relative to the project folder
  file: string
  chars: number
}

export interface ContextState {
  docsFolder: string | null
  docs: ContextDoc[]
  transcripts: ContextTranscript[]
  rules: StyleRule[]
  indexing: boolean
  lastIndexedAt: number | null
  // the last indexing problem in plain words, null when it went fine
  error: string | null
}

export interface ContextApi {
  get(brandId: string): Promise<ContextState>
  // opens a folder picker, saves the folder and starts indexing it
  pickFolder(brandId: string): Promise<ContextState>
  clearFolder(brandId: string): Promise<ContextState>
  reindex(brandId: string): Promise<ContextState>
  // each returns an error in plain words, or null when it saved
  addRule(brandId: string, text: string): Promise<string | null>
  editRule(brandId: string, id: string, text: string): Promise<string | null>
  removeRule(brandId: string, id: string): Promise<void>
  // main -> renderer on 'context:changed' with the brand id
  onChanged(fn: (brandId: string) => void): () => void
}

declare global {
  interface Window {
    trenddeckContext: ContextApi
  }
}
