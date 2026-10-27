import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { CardsChanged, ChatCard } from '@shared/cards'
import { ID_PATTERN } from '@shared/types'
import { broadcast } from '../gateway/wait'

// every brand's chat cards in cards/<brand>.json, newest last. old ones fall off past the cap
const MAX_CARDS = 1500

const cache = new Map<string, ChatCard[]>()
const queues = new Map<string, Promise<unknown>>()

export const cardsDir = (): string => join(app.getPath('userData'), 'cards')
const file = (brandId: string): string => join(cardsDir(), `${brandId}.json`)

function check(brandId: string): void {
  if (!ID_PATTERN.test(brandId)) throw new Error('bad brand id')
}

async function load(brandId: string): Promise<ChatCard[]> {
  check(brandId)
  const hit = cache.get(brandId)
  if (hit) return hit
  let list: ChatCard[] = []
  try {
    const raw = JSON.parse(await fs.readFile(file(brandId), 'utf8')) as { cards?: unknown }
    if (Array.isArray(raw.cards)) {
      list = raw.cards.filter((c): c is ChatCard => !!c && typeof c === 'object' && typeof (c as ChatCard).id === 'string' && typeof (c as ChatCard).type === 'string')
    }
  } catch {
    // no cards yet
  }
  cache.set(brandId, list)
  return list
}

async function persist(brandId: string): Promise<void> {
  const list = cache.get(brandId) ?? []
  await fs.mkdir(cardsDir(), { recursive: true })
  const tmp = `${file(brandId)}.tmp`
  await fs.writeFile(tmp, JSON.stringify({ version: 1, cards: list }), 'utf8')
  await fs.rename(tmp, file(brandId))
}

function serial<T>(brandId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(brandId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(brandId, next.catch(() => {}))
  return next
}

export const newCardId = (): string => randomUUID()

export function addCard(card: ChatCard): Promise<ChatCard> {
  return serial(card.brandId, async () => {
    const list = await load(card.brandId)
    list.push(card)
    if (list.length > MAX_CARDS) list.splice(0, list.length - MAX_CARDS)
    await persist(card.brandId)
    broadcast('cards:changed', { brandId: card.brandId, card } satisfies CardsChanged)
    return card
  })
}

export async function getCard(brandId: string, id: string): Promise<ChatCard | null> {
  return (await load(brandId)).find((c) => c.id === id) ?? null
}

// fn changes the card in place. null when there's no such card
export function changeCard<T extends ChatCard>(brandId: string, id: string, fn: (c: ChatCard) => T | void): Promise<ChatCard | null> {
  return serial(brandId, async () => {
    const list = await load(brandId)
    const i = list.findIndex((c) => c.id === id)
    if (i < 0) return null
    const copy = structuredClone(list[i])
    const out = (fn(copy) as ChatCard | undefined) ?? copy
    out.updatedAt = Date.now()
    list[i] = out
    await persist(brandId)
    broadcast('cards:changed', { brandId, card: out } satisfies CardsChanged)
    return out
  })
}

export async function listCards(brandId: string, threadId: string): Promise<ChatCard[]> {
  return (await load(brandId)).filter((c) => c.threadId === threadId)
}

// every card of the brand, e.g. its takes for the content map
export async function allCards(brandId: string): Promise<ChatCard[]> {
  return [...(await load(brandId))]
}

export async function dropCards(brandId: string): Promise<void> {
  check(brandId)
  await serial(brandId, async () => {
    cache.delete(brandId)
    await fs.rm(file(brandId), { force: true })
    await fs.rm(join(cardsDir(), 'frames', brandId), { recursive: true, force: true })
  })
}
