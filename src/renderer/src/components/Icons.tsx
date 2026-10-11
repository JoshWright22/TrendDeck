import type { ReactNode } from 'react'

function Icon({ children }: { children: ReactNode }): ReactNode {
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
      {children}
    </svg>
  )
}

export const BackIcon = (): ReactNode => (
  <Icon>
    <path d="M15 18l-6-6 6-6" />
  </Icon>
)

export const ForwardIcon = (): ReactNode => (
  <Icon>
    <path d="M9 18l6-6-6-6" />
  </Icon>
)

export const ReloadIcon = (): ReactNode => (
  <Icon>
    <path d="M21 12a9 9 0 1 1-3-6.7" />
    <path d="M21 4v5h-5" />
  </Icon>
)

export const CloseIcon = (): ReactNode => (
  <Icon>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
)

export const HomeIcon = (): ReactNode => (
  <Icon>
    <path d="M4 11l8-7 8 7" />
    <path d="M6 10v10h12V10" />
  </Icon>
)

export const PinIcon = (): ReactNode => (
  <Icon>
    <path d="M9 4h6l-1 6 4 4H6l4-4-1-6z" />
    <path d="M12 14v6" />
  </Icon>
)

export const PlusIcon = (): ReactNode => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
)

export const EditIcon = (): ReactNode => (
  <Icon>
    <path d="M4 20h4L19 9l-4-4L4 16v4z" />
  </Icon>
)

export const ChatIcon = (): ReactNode => (
  <Icon>
    <path d="M4 5h16v11H9l-5 4V5z" />
  </Icon>
)

export const ChevronIcon = (): ReactNode => (
  <Icon>
    <path d="M7 10l5 5 5-5" />
  </Icon>
)

export const TrendsIcon = (): ReactNode => (
  <Icon>
    <path d="M3 17l6-6 4 4 8-8" />
    <path d="M15 7h6v6" />
  </Icon>
)

export const IdeasIcon = (): ReactNode => (
  <Icon>
    <path d="M9 18h6M10 21h4" />
    <path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z" />
  </Icon>
)

export const ScheduleIcon = (): ReactNode => (
  <Icon>
    <rect x="4" y="5" width="16" height="15" rx="2" />
    <path d="M4 10h16M9 3v4M15 3v4" />
  </Icon>
)

export const WriterIcon = (): ReactNode => (
  <Icon>
    <path d="M4 20h16" />
    <path d="M14 4l4 4-9 9H5v-4l9-9z" />
  </Icon>
)

export const AnalyticsIcon = (): ReactNode => (
  <Icon>
    <path d="M5 20V11M12 20V4M19 20v-6" />
  </Icon>
)

export const PanelIcon = (): ReactNode => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M15 4v16" />
  </Icon>
)

export const SendIcon = (): ReactNode => (
  <Icon>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Icon>
)

export const TrashIcon = (): ReactNode => (
  <Icon>
    <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />
  </Icon>
)

// the rising line from the logo's card corners, a tiny trend line ending in a dot
export const RisingMark = ({ className }: { className?: string }): ReactNode => (
  <svg className={className} viewBox="-9 -6 18 13" aria-hidden="true">
    <path
      d="M-7 5 L-2 0 L1 3 L6 -3"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="6" cy="-3" r="1.9" fill="currentColor" />
  </svg>
)

// the rounded diamond for floating accents
export const Diamond = ({ className }: { className?: string }): ReactNode => (
  <svg className={className} viewBox="-6 -6 12 12" aria-hidden="true">
    <rect x="-3.5" y="-3.5" width="7" height="7" rx="1.8" transform="rotate(45)" fill="currentColor" />
  </svg>
)

export const SettingsIcon = (): ReactNode => (
  <Icon>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1" />
  </Icon>
)

export const SearchIcon = (): ReactNode => (
  <Icon>
    <circle cx="11" cy="11" r="6" />
    <path d="M20 20l-4.5-4.5" />
  </Icon>
)

export const ExternalIcon = (): ReactNode => (
  <Icon>
    <path d="M14 4h6v6M20 4l-9 9" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Icon>
)

export const SaveIcon = (): ReactNode => (
  <Icon>
    <path d="M6 3h12v18l-6-4-6 4V3z" />
  </Icon>
)
