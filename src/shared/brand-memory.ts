// the brand memory that grows with each video: a friction log of what the creator changed,
// rules proposed from it at the end of a session, and readable brand files under git in
// Documents\TrendDeck\<brand>\brand\. main owns the files, see main/brand-memory

export const BRAND_FILES = ['positioning.md', 'voice.md', 'rules.md', 'learnings.md'] as const
export type BrandFileName = (typeof BRAND_FILES)[number]

export const BRAND_FILE_TITLES: Record<BrandFileName, string> = {
  'positioning.md': 'Positioning',
  'voice.md': 'Voice guide',
  'rules.md': 'Rules',
  'learnings.md': 'Learnings'
}

// one thing the creator did to an agent's work, logged per brand as a line of JSONL
export const FRICTION_KINDS = [
  'undo',
  'rejected-suggestion',
  'respoken-line',
  'edited-agent-line',
  'removed-agent-line',
  'take-paraphrase',
  'dropped-rule',
  'edited-rule'
] as const
export type FrictionKind = (typeof FRICTION_KINDS)[number]

export interface FrictionEvent {
  id: string
  at: number
  kind: FrictionKind
  projectId: string | null
  // the text before and after, when there is one
  before: string
  after: string
  // a card or script line id it came from
  ref: string
  note: string
}

export const RULE_KINDS = ['voice', 'structure', 'packaging', 'edit'] as const
export type RuleKind = (typeof RULE_KINDS)[number]

export interface ProposedRule {
  id: string
  text: string
  kind: RuleKind
  why: string
  // friction event ids it came from
  evidence: string[]
  // short quotes of what changed, for the card
  examples: string[]
}

// at most this many rule cards per wrap-up, so the creator isn't asked about every small thing
export const MAX_RULES_PER_SESSION = 3
export const RULE_TEXT_MAX = 280

export interface BrandMemoryState {
  // friction events since the last wrap-up
  pending: number
  lastWrapUpAt: number | null
  files: { file: BrandFileName; chars: number; modified: number }[]
  // the brand folder, shown in Settings only
  folder: string
  hasCadence: boolean
  // set once intake ran or voice.md exists
  intakeDone: boolean
}

// window.trenddeckBrandMemory
export interface BrandMemoryApi {
  state(brandId: string): Promise<BrandMemoryState>
  // starts a new session and returns the wrap-up message for the agent
  wrapUp(brandId: string): Promise<string>
  keepRule(brandId: string, cardId: string, text: string): Promise<unknown>
  dropRule(brandId: string, cardId: string): Promise<unknown>
  keepFile(brandId: string, cardId: string, content: string): Promise<unknown>
  dropFile(brandId: string, cardId: string): Promise<unknown>
  readFile(brandId: string, file: BrandFileName): Promise<string>
  intakePrompt(): Promise<string>
  onChanged(fn: (brandId: string) => void): () => void
}

declare global {
  interface Window {
    trenddeckBrandMemory: BrandMemoryApi
  }
}
