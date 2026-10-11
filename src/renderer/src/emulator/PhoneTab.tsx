import type { ReactNode } from 'react'

export const PhoneIcon = (): ReactNode => (
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
    <rect x="6" y="2" width="12" height="20" rx="2.5" />
    <path d="M11 18h2" />
  </svg>
)

// sidebar entry for the brand's phone
export default function PhoneTab({ active, onClick }: { active: boolean; onClick: () => void }): ReactNode {
  return (
    <nav className="side-section" aria-label="Phone">
      <button
        className={`side-item${active ? ' active' : ''}`}
        aria-current={active ? 'page' : undefined}
        onClick={onClick}
        title="Android phone for apps that only run on a phone"
      >
        <PhoneIcon />
        <span className="side-name">Phone</span>
      </button>
    </nav>
  )
}
