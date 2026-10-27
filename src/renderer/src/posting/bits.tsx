import { useEffect, useState, type ReactNode } from 'react'
import type { PostingState, PostStatus } from '@shared/posting'

export function usePosting(): PostingState | null {
  const [state, setState] = useState<PostingState | null>(null)
  useEffect(() => {
    let alive = true
    void window.trenddeck.posting.get().then((s) => alive && setState(s))
    const off = window.trenddeck.posting.onUpdate(setState)
    // an agent queued or changed a post
    const offAgent = window.trenddeckGateway.onDataChanged((c) => {
      if (c.kind === 'posting') void window.trenddeck.posting.get().then((s) => alive && setState(s))
    })
    return () => {
      alive = false
      off()
      offAgent()
    }
  }, [])
  return state
}

// the card mark: a tiny trend line ending in a dot
export function RisingMark({ className }: { className?: string }): ReactNode {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M2 19l6-6 4 3 7-8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="20" cy="7" r="2.8" fill="currentColor" />
    </svg>
  )
}

export function PostingIcon(): ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  )
}

export const STATUS_NAMES: Record<PostStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  queued: 'In line',
  running: 'Filling in',
  review: 'Your turn',
  posted: 'Posted',
  failed: 'Failed',
  closed: 'Not sent',
  missed: 'Missed'
}

export function StatusChip({ status }: { status: PostStatus }): ReactNode {
  return <span className={`post-status ${status}`}>{STATUS_NAMES[status]}</span>
}

export function when(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

export const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path
