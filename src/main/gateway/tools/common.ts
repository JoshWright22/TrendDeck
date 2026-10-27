import type { Brand } from '@shared/types'
import type { DataChanged } from '@shared/gateway'
import { getData } from '../../store'
import { saveDataFromMain } from '../../workspace'
import { broadcast } from '../wait'
import { ToolError, type Turn } from '../types'

export function brandOf(turn: Turn): Brand {
  const brand = getData()?.brands.find((b) => b.id === turn.brandId)
  if (!brand) throw new ToolError('this brand was deleted')
  return brand
}

export function dataChanged(brandId: string, kind: DataChanged['kind']): void {
  broadcast('gateway:data-changed', { brandId, kind } satisfies DataChanged)
}

let queue: Promise<unknown> = Promise.resolve()

// changes one brand in trenddeck.json from main. the ui gets the saved data on data:changed and
// swaps it in, so its next whole-file save has the change in it. gateway:data-changed still goes
// out for views that reload their own data
export function changeBrand<T>(brandId: string, fn: (b: Brand) => T): Promise<T> {
  const run = async (): Promise<T> => {
    const data = getData()
    const i = data?.brands.findIndex((b) => b.id === brandId) ?? -1
    if (!data || i < 0) throw new ToolError('this brand was deleted')
    const brand: Brand = structuredClone(data.brands[i])
    const out = fn(brand)
    const brands = data.brands.slice()
    brands[i] = brand
    await saveDataFromMain({ ...data, brands })
    dataChanged(brandId, 'app')
    return out
  }
  const next = queue.then(run, run)
  queue = next.catch(() => {})
  return next
}

export const iso = (ms: number | null | undefined): string | null => (ms ? new Date(ms).toISOString() : null)

// an ISO date from the agent, in the future unless past is ok
export function parseWhen(raw: string, field: string, allowPast = false): number {
  const at = Date.parse(raw)
  if (Number.isNaN(at)) throw new ToolError(`${field} should be an ISO date like 2026-10-12T18:00:00Z`)
  if (!allowPast && at < Date.now() - 60_000) throw new ToolError(`${field} is in the past`)
  return at
}

export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s)
