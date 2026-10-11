import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ChatThread } from '@shared/types'
import { CloseIcon, PlusIcon, SendIcon, TrashIcon } from './Icons'

interface Props {
  brandName: string
  threads: ChatThread[]
  onChange: (fn: (threads: ChatThread[]) => ChatThread[]) => void
  onClose: () => void
}

const newId = (): string => crypto.randomUUID()

function when(at: number): string {
  const d = new Date(at)
  const today = new Date().toDateString() === d.toDateString()
  return today
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export default function ChatPane({ brandName, threads, onChange, onClose }: Props): ReactNode {
  const sorted = [...threads].sort((a, b) => b.updatedAt - a.updatedAt)
  const [openId, setOpenId] = useState<string | null>(sorted[0]?.id ?? null)
  const [draft, setDraft] = useState('')
  const listEnd = useRef<HTMLDivElement>(null)
  const thread = threads.find((t) => t.id === openId) ?? null

  useEffect(() => {
    listEnd.current?.scrollIntoView({ block: 'end' })
  }, [thread?.messages.length, openId])

  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    const now = Date.now()
    const message = { id: newId(), role: 'user' as const, text, at: now }
    if (thread) {
      onChange((all) =>
        all.map((t) =>
          t.id === thread.id ? { ...t, updatedAt: now, messages: [...t.messages, message] } : t
        )
      )
    } else {
      const id = newId()
      const title = text.length > 48 ? `${text.slice(0, 48)}...` : text
      onChange((all) => [...all, { id, title, updatedAt: now, messages: [message] }])
      setOpenId(id)
    }
    setDraft('')
  }

  const remove = (id: string): void => {
    onChange((all) => all.filter((t) => t.id !== id))
    if (openId === id) setOpenId(null)
  }

  return (
    <aside className="chat" aria-label="Chat">
      <header className="chat-head">
        <h3>Chat</h3>
        <span className="spacer" />
        <button
          className="icon-btn"
          title="New chat"
          aria-label="New chat"
          onClick={() => setOpenId(null)}
        >
          <PlusIcon />
        </button>
        <button className="icon-btn" title="Hide chat" aria-label="Hide chat" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>

      {sorted.length > 0 && (
        <div className="threads" role="list" aria-label="Chats">
          {sorted.map((t) => (
            <div
              key={t.id}
              role="listitem"
              tabIndex={0}
              className={`thread${t.id === openId ? ' active' : ''}`}
              onClick={() => setOpenId(t.id)}
              onKeyDown={(e) => e.key === 'Enter' && setOpenId(t.id)}
            >
              <span className="thread-title">{t.title}</span>
              <span className="thread-when">{when(t.updatedAt)}</span>
              <button
                className="row-close"
                title="Delete chat"
                aria-label="Delete chat"
                onClick={(e) => {
                  e.stopPropagation()
                  remove(t.id)
                }}
              >
                <TrashIcon />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="messages">
        {thread ? (
          thread.messages.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              {m.text}
            </div>
          ))
        ) : (
          <div className="chat-empty">
            <p className="chat-hello">What are we posting for {brandName}?</p>
            <p>Ask for ideas, titles and posts built from your trends.</p>
          </div>
        )}
        <div ref={listEnd} />
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <p className="composer-note">No agent connected yet. Your chats are saved for when one is.</p>
        <div className="composer-box">
          <textarea
            value={draft}
            rows={2}
            placeholder="Message"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          <button
            type="submit"
            className="send-btn"
            title="Send"
            aria-label="Send"
            disabled={!draft.trim()}
          >
            <SendIcon />
          </button>
        </div>
      </form>
    </aside>
  )
}
