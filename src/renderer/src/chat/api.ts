import type { ChatApi } from '@shared/chat'
import type { ProviderChatApi } from '@shared/providers'

declare global {
  interface Window {
    trenddeckChat: ChatApi & ProviderChatApi
  }
}

export const chat = (): ChatApi & ProviderChatApi => window.trenddeckChat

export const newId = (): string => crypto.randomUUID()

export function when(at: number): string {
  const d = new Date(at)
  const today = new Date().toDateString() === d.toDateString()
  return today
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

// only http links open, in a tab inside the app
export function safeHref(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}
