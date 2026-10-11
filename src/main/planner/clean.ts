import { ID_PATTERN, IDEA_STAGES, type Idea, type IdeaStage, type ScheduleSlot } from '@shared/types'

const MAX_TAGS = 12
const MAX_SLOTS = 5000

// board fields on an idea, old ideas without them start in the idea column
export function cleanIdeaBoard(raw: Partial<Idea>): Pick<Idea, 'stage' | 'notes' | 'tags' | 'postedAt'> {
  const stage: IdeaStage = (IDEA_STAGES as readonly string[]).includes(raw.stage as string)
    ? (raw.stage as IdeaStage)
    : 'idea'
  const notes = typeof raw.notes === 'string' ? raw.notes.slice(0, 5000) : ''
  const tags = Array.isArray(raw.tags)
    ? [
        ...new Set(
          raw.tags
            .filter((t): t is string => typeof t === 'string')
            .map((t) => t.trim().toLowerCase().slice(0, 30))
            .filter(Boolean)
        )
      ].slice(0, MAX_TAGS)
    : []
  const postedAt = Number(raw.postedAt) || 0
  return postedAt ? { stage, notes, tags, postedAt } : { stage, notes, tags }
}

function cleanSlot(raw: unknown): ScheduleSlot | null {
  const s = raw as Partial<ScheduleSlot> | null
  if (!s || typeof s.id !== 'string' || !ID_PATTERN.test(s.id)) return null
  const at = Number(s.at)
  if (!Number.isFinite(at) || at <= 0) return null
  const ideaId = typeof s.ideaId === 'string' && ID_PATTERN.test(s.ideaId) ? s.ideaId : ''
  return {
    id: s.id,
    at,
    platform: typeof s.platform === 'string' && s.platform.trim() ? s.platform.trim().slice(0, 30) : 'Other',
    title: typeof s.title === 'string' ? s.title.slice(0, 300) : '',
    ideaId,
    draft: typeof s.draft === 'string' ? s.draft.slice(0, 20000) : '',
    done: s.done === true
  }
}

export function cleanSchedule(raw: unknown): ScheduleSlot[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map(cleanSlot)
    .filter((s): s is ScheduleSlot => s !== null)
    .slice(0, MAX_SLOTS)
}
