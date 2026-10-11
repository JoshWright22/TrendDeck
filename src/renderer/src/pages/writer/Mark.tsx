import type { ReactNode } from 'react'

// the rising line card mark: a tiny trend line ending in a dot
export function RiseMark({ className }: { className?: string }): ReactNode {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <polyline
        points="2,13 6,8.5 9,10.5 12.5,5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="13" cy="4.5" r="2.1" fill="currentColor" />
    </svg>
  )
}

// marks in two corners where a suit would go
export function CardCorners({ tone = 'teal' }: { tone?: 'teal' | 'pink' | 'yellow' }): ReactNode {
  return (
    <>
      <RiseMark className={`rise-mark tl ${tone}`} />
      <RiseMark className={`rise-mark br ${tone}`} />
    </>
  )
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // clipboard api wants focus, fall back to the old way
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  }
}
