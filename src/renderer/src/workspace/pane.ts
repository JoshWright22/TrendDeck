import { createContext, useContext } from 'react'

// what a workspace may need to know about the pane it's in. a hidden pane stays mounted
// (moved off screen), so things drawn outside the page, like a docked app window, check this
export const PaneContext = createContext<{ collapsed: boolean }>({ collapsed: false })

export const usePane = (): { collapsed: boolean } => useContext(PaneContext)
