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
