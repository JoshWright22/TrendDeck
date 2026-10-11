import type { ChatApi } from '@shared/chat'

declare global {
  interface Window {
    trenddeckChat: ChatApi
  }
}

export const chat = (): ChatApi => window.trenddeckChat

export const newId = (): string => crypto.randomUUID()

export function when(at: number): string {
  const d = new Date(at)
  const today = new Date().toDateString() === d.toDateString()
  return today
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

// only http links leave the app, through the normal browser
export function safeHref(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}
