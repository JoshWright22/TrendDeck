import type { CraftAppStatus } from '@shared/craft'

// how the agent hears about its connection to a craft app. pure, unit tested

// how the agent reaches the app on this project now, in words. a connection that failed earlier
// doesn't stop the next call, that one connects again
export function connectionFor(s: Pick<CraftAppStatus, 'agent' | 'brandId' | 'projectId'>, inChat: boolean, brandId: string, projectId: string | null): string {
  if (inChat) return 'the editor in the chat, its tools work there'
  if (s.agent === 'bridge') return s.brandId === brandId && s.projectId === projectId ? 'the full app window' : 'the full app window, on another project'
  if (s.agent === 'headless') return 'without a window, on the project file'
  if (s.agent === 'error') return 'the last connection failed, the next tool call connects again'
  return 'not connected yet, the next tool call connects'
}

// what went wrong connecting, said plainly with what to do next
export function connectError(name: string, why: string): string {
  if (/agent connection|couldn't start|ECONNREFUSED|ENOENT|spawn/i.test(why)) {
    return `${name} couldn't connect on this project (${why}). Try the call again, it reconnects. If it keeps failing, reinstall ${name} in Settings, Craft apps.`
  }
  return `${name}: ${why}`
}
