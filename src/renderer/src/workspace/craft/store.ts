import { useEffect, useSyncExternalStore } from 'react'
import type { CraftApi, CraftAppStatus } from '@shared/craft'
import { craftMock } from './mock'

// one copy of every app's state for the whole window, from list() and kept current by
// onChanged. the workspace, settings and the Tools menu all read it

let api: CraftApi | null | undefined

export function craftApi(): CraftApi | null {
  if (api !== undefined) return api
  const real = (window as Partial<Window>).trenddeckCraft
  api = real ?? (import.meta.env.DEV || import.meta.env.VITE_CRAFT_MOCK === '1' ? craftMock() : null)
  return api
}

let apps: CraftAppStatus[] | null = null
const subs = new Set<() => void>()
let started = false

function emit(): void {
  for (const fn of subs) fn()
}

function put(s: CraftAppStatus): void {
  const list = apps ?? []
  const i = list.findIndex((a) => a.app.id === s.app.id)
  apps = i < 0 ? [...list, s] : list.map((a, j) => (j === i ? s : a))
  emit()
}

export function reloadCraft(): void {
  const a = craftApi()
  if (!a) return
  void a.list().then(
    (list) => {
      apps = list
      emit()
    },
    (err: unknown) => console.error('craft: list failed', err)
  )
}

function start(): void {
  if (started) return
  started = true
  const a = craftApi()
  if (!a) return
  a.onChanged(put)
  reloadCraft()
}

// takes a status main sent back from a call, same as an onChanged one
export function putCraft(s: CraftAppStatus | null | undefined): void {
  if (s?.app) put(s)
}

export function putCraftList(list: CraftAppStatus[]): void {
  apps = list
  emit()
}

const subscribe = (fn: () => void): (() => void) => {
  subs.add(fn)
  return () => subs.delete(fn)
}

// null until the first list() answers
export function useCraftApps(): CraftAppStatus[] | null {
  useEffect(start, [])
  return useSyncExternalStore(subscribe, () => apps)
}

export function useCraftApp(appId: string): CraftAppStatus | null | undefined {
  const list = useCraftApps()
  // undefined while loading, null when main doesn't know the app
  return list === null ? undefined : (list.find((a) => a.app.id === appId) ?? null)
}

export const errorText = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
