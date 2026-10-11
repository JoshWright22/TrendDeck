import type { ReactNode } from 'react'

// a speech bubble with a small wave in it
export const VoiceIcon = (): ReactNode => (
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
    <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
    <path d="M8 12h1l1.5-3 3 6 1.5-3h1" />
  </svg>
)
