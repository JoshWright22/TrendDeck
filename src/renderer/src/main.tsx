import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { applyPlaybackSpeed } from './playback-speed'
import App from './App'
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import './styles.css'
import './shell/shell.css'

applyPlaybackSpeed()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
