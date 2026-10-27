import { useSyncExternalStore } from 'react'
import type { ApprovalRequest as GatewayApproval } from '@shared/gateway'
import type { PipelineQuestion } from '@shared/pipeline'
import type { ApprovalRequest as ProviderApproval, UserInputRequest } from '@shared/providers'
import { chat } from './api'

// everything an agent is waiting on the user for, across every chat: tool approvals from the
// agent itself (provider) and from the app's tool gateway, and questions from either side.
// one copy for the whole window so the composer, the sidebar dots and notifications agree

export type PendingItem =
  | { kind: 'provider-approval'; id: string; brandId: string; threadId: string; messageId: string; request: ProviderApproval }
  | { kind: 'gateway-approval'; id: string; brandId: string; threadId: string | null; request: GatewayApproval }
  | { kind: 'provider-input'; id: string; brandId: string; threadId: string; messageId: string; request: UserInputRequest }
  | { kind: 'pipeline-question'; id: string; brandId: string; threadId: string | null; question: PipelineQuestion }

export const isApproval = (p: PendingItem): p is Extract<PendingItem, { kind: 'provider-approval' | 'gateway-approval' }> =>
  p.kind === 'provider-approval' || p.kind === 'gateway-approval'

interface State {
  items: PendingItem[]
  // chats whose reply finished while you were somewhere else, cleared when you open them
  unread: Set<string>
}

let state: State = { items: [], unread: new Set() }
const subs = new Set<() => void>()
let started = false
// the chat on screen, background ones get a dot and a notification
let focus: { brandId: string; threadId: string | null } | null = null
// names for notifications, the shell keeps it current
let names: { brand: (id: string) => string; thread: (brandId: string, id: string) => string } = {
  brand: () => 'TrendDeck',
  thread: () => 'A chat'
}

function set(next: Partial<State>): void {
  state = { ...state, ...next }
  for (const fn of subs) fn()
}

const key = (brandId: string, threadId: string | null): string => `${brandId}:${threadId ?? ''}`

function add(item: PendingItem): void {
  if (state.items.some((p) => p.id === item.id)) return
  set({ items: [...state.items, item] })
  notifyFor(item)
}

function drop(fn: (p: PendingItem) => boolean): void {
  const items = state.items.filter((p) => !fn(p))
  if (items.length !== state.items.length) set({ items })
}

function background(brandId: string, threadId: string | null): boolean {
  if (!document.hasFocus()) return true
  return !focus || focus.brandId !== brandId || (threadId !== null && focus.threadId !== threadId)
}

// a plain html notification, electron shows it as a windows toast. no ipc needed
function toast(title: string, body: string, brandId: string, threadId: string | null): void {
  if (typeof Notification === 'undefined' || Notification.permission === 'denied') return
  try {
    const n = new Notification(title, { body, silent: false })
    n.onclick = () => {
      window.focus()
      window.dispatchEvent(new CustomEvent('trenddeck:open-thread', { detail: { brandId, threadId } }))
    }
  } catch {
    // no notifications on this system, the sidebar dot is still there
  }
}

function notifyFor(item: PendingItem): void {
  if (!background(item.brandId, item.threadId)) return
  const where = item.threadId ? names.thread(item.brandId, item.threadId) : names.brand(item.brandId)
  const what =
    item.kind === 'gateway-approval'
      ? `Wants to ${item.request.title.toLowerCase()}`
      : item.kind === 'provider-approval'
        ? item.request.title
        : 'Has a question for you'
  toast(where, what, item.brandId, item.threadId)
}

function start(): void {
  if (started) return
  started = true
  const gw = window.trenddeckGateway
  const pl = window.trenddeckPipeline

  void gw.pendingApprovals().then((list) => {
    for (const r of list) add({ kind: 'gateway-approval', id: `gw:${r.id}`, brandId: r.brandId, threadId: r.threadId, request: r })
  })
  gw.onApprovalRequest((r) =>
    add({ kind: 'gateway-approval', id: `gw:${r.id}`, brandId: r.brandId, threadId: r.threadId, request: r })
  )
  gw.onApprovalClosed((c) => drop((p) => p.id === `gw:${c.id}`))

  void pl.pendingQuestions().then((list) => {
    for (const q of list) add({ kind: 'pipeline-question', id: `pq:${q.id}`, brandId: q.brandId, threadId: q.threadId, question: q })
  })
  pl.onQuestion((q) => add({ kind: 'pipeline-question', id: `pq:${q.id}`, brandId: q.brandId, threadId: q.threadId, question: q }))
  pl.onQuestionClosed((c) => drop((p) => p.id === `pq:${c.id}`))

  chat().onProviderEvent((ev) => {
    if (ev.type === 'approval') {
      add({
        kind: 'provider-approval',
        id: `pa:${ev.threadId}:${ev.request.requestId}`,
        brandId: ev.brandId,
        threadId: ev.threadId,
        messageId: ev.messageId,
        request: ev.request
      })
    } else if (ev.type === 'approval-resolved') {
      drop((p) => p.id === `pa:${ev.threadId}:${ev.requestId}`)
    } else if (ev.type === 'user-input') {
      add({
        kind: 'provider-input',
        id: `pi:${ev.threadId}:${ev.request.requestId}`,
        brandId: ev.brandId,
        threadId: ev.threadId,
        messageId: ev.messageId,
        request: ev.request
      })
    } else if (ev.type === 'user-input-resolved') {
      drop((p) => p.id === `pi:${ev.threadId}:${ev.requestId}`)
    }
  })

  chat().onEvent((ev) => {
    if (ev.type !== 'done') return
    // the turn is over, nothing it asked can be answered now
    drop((p) => (p.kind === 'provider-approval' || p.kind === 'provider-input') && p.threadId === ev.threadId)
    if (background(ev.brandId, ev.threadId)) {
      const unread = new Set(state.unread)
      unread.add(key(ev.brandId, ev.threadId))
      set({ unread })
      if (ev.status === 'done' || ev.status === 'error') {
        toast(
          names.thread(ev.brandId, ev.threadId),
          ev.status === 'error' ? 'The reply failed' : 'Reply finished',
          ev.brandId,
          ev.threadId
        )
      }
    }
  })

  // a toast only shows once the user said yes, once
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission()
}

// what main still has waiting for this chat, e.g. after a reload. replaces what we had for it
export async function syncThread(brandId: string, threadId: string): Promise<void> {
  start()
  const { approvals, inputs } = await chat().pending(brandId, threadId)
  const fresh: PendingItem[] = [
    ...approvals.map(
      (a): PendingItem => ({
        kind: 'provider-approval',
        id: `pa:${threadId}:${a.requestId}`,
        brandId,
        threadId,
        messageId: '',
        request: a
      })
    ),
    ...inputs.map(
      (r): PendingItem => ({ kind: 'provider-input', id: `pi:${threadId}:${r.requestId}`, brandId, threadId, messageId: '', request: r })
    )
  ]
  const others = state.items.filter(
    (p) => !((p.kind === 'provider-approval' || p.kind === 'provider-input') && p.threadId === threadId)
  )
  set({ items: [...others, ...fresh] })
}

export function setFocus(brandId: string | null, threadId: string | null): void {
  start()
  focus = brandId ? { brandId, threadId } : null
  if (brandId && threadId && state.unread.has(key(brandId, threadId))) {
    const unread = new Set(state.unread)
    unread.delete(key(brandId, threadId))
    set({ unread })
  }
}

export function setNames(n: typeof names): void {
  names = n
}

// approvals and questions are answered, so they leave right away, the closed event confirms it
export function resolveLocal(id: string): void {
  drop((p) => p.id === id)
}

function subscribe(fn: () => void): () => void {
  start()
  subs.add(fn)
  return () => subs.delete(fn)
}

const snapshot = (): State => state

export function usePendingState(): State {
  return useSyncExternalStore(subscribe, snapshot)
}

// what this chat waits on. an approval with no thread (an agent outside any chat) shows in
// whatever chat of its brand is open
export function pendingFor(s: State, brandId: string, threadId: string | null): PendingItem[] {
  return s.items.filter((p) => p.brandId === brandId && (p.threadId === threadId || (p.threadId === null && threadId !== null)))
}

export function isUnread(s: State, brandId: string, threadId: string): boolean {
  return s.unread.has(key(brandId, threadId))
}

// threads that need the user, for the sidebar
export function waitingThreads(s: State, brandId: string): Set<string> {
  return new Set(s.items.filter((p) => p.brandId === brandId && p.threadId).map((p) => p.threadId as string))
}
