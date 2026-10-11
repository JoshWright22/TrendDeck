import type { Idea, IdeaStage } from '@shared/types'

export const stageOf = (idea: Idea): IdeaStage => idea.stage ?? 'idea'

export const newId = (): string => crypto.randomUUID()

// "a, b, #c" -> ['a', 'b', 'c']
export function parseTags(text: string): string[] {
  const tags = text
    .split(/[,\n]/)
    .map((t) => t.trim().replace(/^#+/, '').toLowerCase().slice(0, 30))
    .filter(Boolean)
  return [...new Set(tags)].slice(0, 12)
}

export function makeIdea(title: string, stage: IdeaStage = 'idea'): Idea {
  return {
    id: newId(),
    title: title.slice(0, 300),
    url: '',
    source: 'manual',
    savedAt: Date.now(),
    stage,
    notes: '',
    tags: [],
    ...(stage === 'posted' ? { postedAt: Date.now() } : {})
  }
}

function withStage(idea: Idea, stage: IdeaStage): Idea {
  if (stageOf(idea) === stage) return idea
  const next: Idea = { ...idea, stage }
  if (stage === 'posted') next.postedAt = Date.now()
  else delete next.postedAt
  return next
}

// order inside a column is just the order in the brand's ideas array
export function moveIdea(ideas: Idea[], id: string, stage: IdeaStage, beforeId: string | null): Idea[] {
  const from = ideas.findIndex((i) => i.id === id)
  if (from < 0 || beforeId === id) {
    return from < 0 ? ideas : ideas.map((i) => (i.id === id ? withStage(i, stage) : i))
  }
  const rest = [...ideas]
  const [moved] = rest.splice(from, 1)
  const next = withStage(moved, stage)
  let at = beforeId ? rest.findIndex((i) => i.id === beforeId) : -1
  if (at < 0) {
    // end of the column, right after its last card
    let last = -1
    rest.forEach((i, n) => {
      if (stageOf(i) === stage) last = n
    })
    at = last < 0 ? rest.length : last + 1
  }
  rest.splice(at, 0, next)
  return rest
}

// put a new idea at the top of its column
export function addIdea(ideas: Idea[], idea: Idea): Idea[] {
  const stage = stageOf(idea)
  const at = ideas.findIndex((i) => stageOf(i) === stage)
  if (at < 0) return [idea, ...ideas]
  const next = [...ideas]
  next.splice(at, 0, idea)
  return next
}

// plain words match title, notes, link and tags, #word only matches tags
export function matches(idea: Idea, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const tags = idea.tags ?? []
  const text = `${idea.title}\n${idea.notes ?? ''}\n${idea.url}\n${tags.join(' ')}`.toLowerCase()
  return words.every((w) =>
    w.startsWith('#') && w.length > 1 ? tags.some((t) => t.startsWith(w.slice(1))) : text.includes(w)
  )
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}
