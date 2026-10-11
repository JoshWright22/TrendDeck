import type { Idea, ScheduleSlot } from '@shared/types'

export const DAY_MS = 86400000

export function startOfDay(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// weeks start on sunday
export function startOfWeek(t: number): number {
  const d = new Date(startOfDay(t))
  d.setDate(d.getDate() - d.getDay())
  return d.getTime()
}

export function startOfMonth(t: number): number {
  const d = new Date(startOfDay(t))
  d.setDate(1)
  return d.getTime()
}

// calendar days, safe across daylight saving changes
export function addDays(t: number, days: number): number {
  const d = new Date(t)
  d.setDate(d.getDate() + days)
  return d.getTime()
}

export function addMonths(t: number, months: number): number {
  const d = new Date(startOfMonth(t))
  d.setMonth(d.getMonth() + months)
  return d.getTime()
}

export function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b)
}

// six rows of seven days so the grid never jumps in height
export function monthGrid(month: number): number[] {
  const first = startOfWeek(startOfMonth(month))
  return Array.from({ length: 42 }, (_, i) => addDays(first, i))
}

export function weekDays(t: number): number[] {
  const first = startOfWeek(t)
  return Array.from({ length: 7 }, (_, i) => addDays(first, i))
}

// same clock time, different day
export function moveToDay(at: number, day: number): number {
  const from = new Date(at)
  const d = new Date(day)
  d.setHours(from.getHours(), from.getMinutes(), 0, 0)
  return d.getTime()
}

export function atTime(day: number, minutes: number): number {
  const d = new Date(startOfDay(day))
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  return d.getTime()
}

export function minutesOf(at: number): number {
  const d = new Date(at)
  return d.getHours() * 60 + d.getMinutes()
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
const longDayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })
const shortMonthFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const hourFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric' })

export const fmtTime = (t: number): string => timeFmt.format(t)
export const fmtDay = (t: number): string => dayFmt.format(t)
export const fmtLongDay = (t: number): string => longDayFmt.format(t)
export const fmtMonth = (t: number): string => monthFmt.format(t)
export const fmtShort = (t: number): string => shortMonthFmt.format(t)
export const fmtWeekday = (t: number): string => weekdayFmt.format(t)
export const fmtHour = (h: number): string => hourFmt.format(new Date(2000, 0, 1, h))

// yyyy-mm-dd and hh:mm for the date and time inputs, in local time
export function toDateInput(t: number): string {
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function toTimeInput(t: number): string {
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

export function fromInputs(date: string, time: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const t = /^(\d{2}):(\d{2})$/.exec(time)
  if (!m || !t) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(t[1]), Number(t[2]))
  return Number.isNaN(d.getTime()) ? null : d.getTime()
}

export function slotTitle(slot: ScheduleSlot, idea: Idea | undefined): string {
  return slot.title.trim() || idea?.title || 'Untitled post'
}

export function platformClass(platform: string): string {
  return `pf-${platform.toLowerCase().replace(/[^a-z0-9]/g, '') || 'other'}`
}
