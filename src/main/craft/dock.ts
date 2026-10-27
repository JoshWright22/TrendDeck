import { screen, type BrowserWindow } from 'electron'
import type { CraftDock, CraftDockState } from '@shared/craft'

type Fn = (...args: unknown[]) => unknown

interface User32 {
  EnumWindows: Fn
  GetWindowThreadProcessId: Fn
  IsWindowVisible: Fn
  IsWindow: Fn
  GetWindow: Fn
  GetParent: Fn
  SetParent: Fn
  ClientToScreen: Fn
  GetWindowLongPtrW: Fn
  SetWindowLongPtrW: Fn
  SetWindowPos: Fn
  ShowWindowAsync: Fn
  PostMessageW: Fn
  GetWindowRect: Fn
  GetWindowTextLengthW: Fn
  SetWinEventHook: Fn
  UnhookWinEvent: Fn
  SetWindowRgn: Fn
  CreateRectRgn: Fn
}

const EVENT_OBJECT_SHOW = 0x8002
const WINEVENT_OUTOFCONTEXT = 0
// the hook's callback, kept so koffi doesn't free it
let showCallback: unknown = null
const hooks = new Map<string, unknown>()

const GW_OWNER = 4
const GWL_STYLE = -16
const GWL_EXSTYLE = -20
const WS_CAPTION = 0x00c00000
const WS_THICKFRAME = 0x00040000
const WS_SYSMENU = 0x00080000
const WS_MINIMIZEBOX = 0x00020000
const WS_MAXIMIZEBOX = 0x00010000
const WS_EX_APPWINDOW = 0x00040000
const WS_MAXIMIZE = 0x01000000
const WS_MINIMIZE = 0x20000000
const WS_CHILD = 0x40000000
const WS_POPUP = 0x80000000
const WS_EX_TOOLWINDOW = 0x00000080
const WS_EX_NOACTIVATE = 0x08000000
const SWP_NOSIZE = 0x1
const SWP_NOMOVE = 0x2
const SWP_NOZORDER = 0x4
const SWP_NOACTIVATE = 0x10
const SWP_FRAMECHANGED = 0x20
const SWP_NOOWNERZORDER = 0x200
// the app's ui thread could be busy, never wait on it
const SWP_ASYNCWINDOWPOS = 0x4000
const SW_HIDE = 0
const SW_SHOWNOACTIVATE = 4
const SW_RESTORE = 9
const WM_CLOSE = 0x0010

let u32: User32 | null | undefined

function user32(): User32 | null {
  if (u32 !== undefined) return u32
  u32 = null
  if (process.platform !== 'win32') return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof import('koffi')
    const lib = koffi.load('user32.dll')
    // named types, the signatures below refer to them by name
    koffi.struct('CRAFT_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
    koffi.struct('CRAFT_POINT', { x: 'long', y: 'long' })
    koffi.proto('bool __stdcall CraftEnumProc(intptr_t hwnd, intptr_t lParam)')
    const showProto = koffi.proto('void __stdcall CraftWinEventProc(intptr_t hook, uint32_t event, intptr_t hwnd, int32_t idObject, int32_t idChild, uint32_t thread, uint32_t time)')
    u32 = {
      EnumWindows: lib.func('bool __stdcall EnumWindows(CraftEnumProc *cb, intptr_t lParam)'),
      GetWindowThreadProcessId: lib.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)'),
      IsWindowVisible: lib.func('bool __stdcall IsWindowVisible(intptr_t hwnd)'),
      IsWindow: lib.func('bool __stdcall IsWindow(intptr_t hwnd)'),
      GetWindow: lib.func('intptr_t __stdcall GetWindow(intptr_t hwnd, uint32_t cmd)'),
      GetParent: lib.func('intptr_t __stdcall GetParent(intptr_t hwnd)'),
      SetParent: lib.func('intptr_t __stdcall SetParent(intptr_t hwnd, intptr_t parent)'),
      ClientToScreen: lib.func('bool __stdcall ClientToScreen(intptr_t hwnd, _Inout_ CRAFT_POINT *point)'),
      GetWindowLongPtrW: lib.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int index)'),
      SetWindowLongPtrW: lib.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t hwnd, int index, intptr_t value)'),
      SetWindowPos: lib.func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)'),
      ShowWindowAsync: lib.func('bool __stdcall ShowWindowAsync(intptr_t hwnd, int cmd)'),
      PostMessageW: lib.func('bool __stdcall PostMessageW(intptr_t hwnd, uint32_t msg, uintptr_t wp, intptr_t lp)'),
      GetWindowRect: lib.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ CRAFT_RECT *rect)'),
      GetWindowTextLengthW: lib.func('int __stdcall GetWindowTextLengthW(intptr_t hwnd)'),
      SetWinEventHook: lib.func('intptr_t __stdcall SetWinEventHook(uint32_t min, uint32_t max, intptr_t mod, CraftWinEventProc *cb, uint32_t pid, uint32_t thread, uint32_t flags)'),
      UnhookWinEvent: lib.func('bool __stdcall UnhookWinEvent(intptr_t hook)'),
      SetWindowRgn: lib.func('int __stdcall SetWindowRgn(intptr_t hwnd, intptr_t rgn, bool redraw)'),
      CreateRectRgn: koffi.load('gdi32.dll').func('intptr_t __stdcall CreateRectRgn(int l, int t, int r, int b)')
    }
    // a docked app's window is put in place the moment it shows, so it never pops up on its own
    // first. out of context hooks are called on this thread's message loop
    showCallback = koffi.register((_hook: number, _event: number, _hwnd: number, idObject: number) => {
      if (idObject !== 0) return
      for (const e of docked.values()) if (!e.hwnd) place(e)
    }, koffi.pointer(showProto))
  } catch (err) {
    console.error('craft: docking is off, user32 could not be loaded', err)
    u32 = null
  }
  return u32
}

export function dockSupported(): boolean {
  return user32() !== null
}

// the process's main window: visible, top level, titled, a real size. winit apps also have a
// hidden message window ("Winit Thread Event Target", a layered tool window) and d3d and IME
// helpers, none of those count. the biggest one wins
function windowsOf(pid: number): number[] {
  const u = user32()
  if (!u) return []
  const found: { hwnd: number; area: number }[] = []
  u.EnumWindows((hwnd: number) => {
    const out = [0]
    u.GetWindowThreadProcessId(hwnd, out)
    if (out[0] !== pid || !u.IsWindowVisible(hwnd) || u.GetWindow(hwnd, GW_OWNER)) return true
    if (!(u.GetWindowTextLengthW(hwnd) as number)) return true
    if (Number(u.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)) return true
    const r = { left: 0, top: 0, right: 0, bottom: 0 }
    u.GetWindowRect(hwnd, r)
    const w = r.right - r.left
    const h = r.bottom - r.top
    if (w >= 200 && h >= 150) found.push({ hwnd: Number(hwnd), area: w * h })
    return true
  }, 0)
  return found.sort((a, b) => b.area - a.area).map((f) => f.hwnd)
}

// the process's other visible top level windows that are too small to be its main one, like
// FilmCraft's empty 16 by 16 window at 0,0. they'd sit on the desktop on their own
function strayWindows(pid: number, main: number): number[] {
  const u = user32()
  if (!u) return []
  const out: number[] = []
  u.EnumWindows((hwnd: number) => {
    const out1 = [0]
    u.GetWindowThreadProcessId(hwnd, out1)
    if (out1[0] !== pid || Number(hwnd) === main || !u.IsWindowVisible(hwnd) || u.GetWindow(hwnd, GW_OWNER)) return true
    const r = { left: 0, top: 0, right: 0, bottom: 0 }
    u.GetWindowRect(hwnd, r)
    if (r.right - r.left < 200 || r.bottom - r.top < 150) out.push(Number(hwnd))
    return true
  }, 0)
  return out
}

function hwndOf(win: BrowserWindow): number {
  const buf = win.getNativeWindowHandle()
  return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0)
}

interface Docked {
  appId: string
  pid: number
  hwnd: number | null
  style: number
  exStyle: number
  parent: number
  original: { left: number; top: number; right: number; bottom: number } | null
  sweptAt: number
  bounds: CraftDock['bounds']
  visible: boolean
  // the part of bounds that can be seen, the window is cut to it
  clip: CraftDock['bounds']
  // the cut last applied, '' for none
  region: string
  // where it was last put, in screen pixels
  placed: { x: number; y: number; w: number; h: number } | null
  hidden: boolean
  // small windows of the app hidden while it's docked
  strays: number[]
}

const docked = new Map<string, Docked>()
const failed = new Set<string>()
let host: BrowserWindow | null = null
let timer: NodeJS.Timeout | null = null

// the TrendDeck window everything docks to. its moves, resizes and minimizes move the apps
export function setHost(win: BrowserWindow): void {
  if (host === win) return
  host = win
  const follow = (): void => placeAll()
  for (const ev of ['move', 'moved', 'resize', 'resized', 'maximize', 'unmaximize', 'restore', 'show', 'enter-full-screen', 'leave-full-screen'] as const) {
    win.on(ev as 'move', follow)
  }
  win.on('minimize', () => placeAll())
  win.on('hide', () => placeAll())
  win.webContents.on('zoom-changed', follow)
  // an owner going away takes its owned windows with it, so they're let go first
  win.on('close', () => releaseAll())
}

// starts docking an app that was just launched. the window is looked for until it shows up
export function attach(appId: string, pid: number): void {
  failed.delete(appId)
  if (!user32()) return
  docked.set(appId, { appId, pid, hwnd: null, style: 0, exStyle: 0, parent: 0, original: null, sweptAt: 0, bounds: null, visible: false, clip: null, region: '', placed: null, hidden: false, strays: [] })
  unhook(appId)
  try {
    const h = user32()!.SetWinEventHook(EVENT_OBJECT_SHOW, EVENT_OBJECT_SHOW, 0, showCallback, pid, 0, WINEVENT_OUTOFCONTEXT)
    if (h) hooks.set(appId, h)
  } catch (err) {
    console.error('craft: no show hook, the 500 ms check finds the window instead', err)
  }
  ensureTimer()
}

function unhook(appId: string): void {
  const h = hooks.get(appId)
  hooks.delete(appId)
  if (h) {
    try {
      user32()?.UnhookWinEvent(h)
    } catch {
      // gone with the process
    }
  }
}

export function setDock(d: CraftDock): void {
  const e = docked.get(d.appId)
  if (!e) return
  e.bounds = d.bounds
  e.visible = d.visible
  e.clip = d.clip ?? null
  place(e)
}

function ensureTimer(): void {
  if (timer) return
  // finds windows that just appeared and puts back ones the app moved itself
  timer = setInterval(() => {
    if (!docked.size) {
      clearInterval(timer!)
      timer = null
      return
    }
    placeAll()
  }, 500)
}

function placeAll(): void {
  for (const e of docked.values()) place(e)
}

function grab(e: Docked): boolean {
  const u = user32()
  if (!u || !host || host.isDestroyed()) return false
  if (e.hwnd && u.IsWindow(e.hwnd)) return true
  const hwnd = windowsOf(e.pid)[0]
  if (!hwnd) return false
  e.hwnd = hwnd
  e.placed = null
  e.style = Number(u.GetWindowLongPtrW(hwnd, GWL_STYLE))
  e.exStyle = Number(u.GetWindowLongPtrW(hwnd, GWL_EXSTYLE))
  e.parent = Number(u.GetParent(hwnd))
  e.original = { left: 0, top: 0, right: 0, bottom: 0 }
  u.GetWindowRect(hwnd, e.original)
  try {
    u.SetWindowLongPtrW(hwnd, GWL_STYLE, ((e.style & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_MAXIMIZE | WS_MINIMIZE)) | WS_CHILD) >>> 0)
    u.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, e.exStyle & ~WS_EX_APPWINDOW)
    u.SetParent(hwnd, hwndOf(host))
    if (Number(u.GetParent(hwnd)) !== hwndOf(host)) throw new Error('The editor rejected native child hosting')
    u.SetWindowPos(hwnd, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_ASYNCWINDOWPOS)
  } catch (err) {
    u.SetParent(hwnd, e.parent)
    u.SetWindowLongPtrW(hwnd, GWL_STYLE, e.style)
    u.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, e.exStyle)
    e.hwnd = null
    console.error('craft: docking failed, the app stays a normal window', err)
    failed.add(e.appId)
    docked.delete(e.appId)
    return false
  }
  return true
}

// a css rect of the content area to screen pixels: zoom, the window's content origin, then the display's scale
function toScreen(b: NonNullable<CraftDock['bounds']>): { x: number; y: number; w: number; h: number } | null {
  if (!host || host.isDestroyed()) return null
  const zoom = host.webContents.getZoomFactor()
  const c = host.getContentBounds()
  const dip = {
    x: Math.round(c.x + b.x * zoom),
    y: Math.round(c.y + b.y * zoom),
    width: Math.max(1, Math.round(b.width * zoom)),
    height: Math.max(1, Math.round(b.height * zoom))
  }
  const r = process.platform === 'win32' ? screen.dipToScreenRect(host, dip) : dip
  return { x: r.x, y: r.y, w: r.width, h: r.height }
}

function target(e: Docked): { x: number; y: number; w: number; h: number } | null {
  return e.bounds ? toScreen(e.bounds) : null
}

// cuts the window to the part of the box that can be seen, so a box partly scrolled out of view
// keeps its window, just trimmed at the edge of what's around it
function cut(e: Docked, t: { x: number; y: number; w: number; h: number }): void {
  const u = user32()
  if (!u || !e.hwnd) return
  const c = e.clip ? toScreen(e.clip) : null
  const r = c ? { l: Math.max(0, c.x - t.x), t: Math.max(0, c.y - t.y), r: Math.min(t.w, c.x - t.x + c.w), b: Math.min(t.h, c.y - t.y + c.h) } : null
  const full = !r || (r.l <= 0 && r.t <= 0 && r.r >= t.w && r.b >= t.h)
  const key = full ? '' : `${r!.l},${r!.t},${r!.r},${r!.b}`
  if (key === e.region) return
  try {
    // the window owns the region once it's set, nothing to free
    u.SetWindowRgn(e.hwnd, full ? 0 : u.CreateRectRgn(r!.l, r!.t, r!.r, r!.b), true)
    e.region = key
  } catch (err) {
    console.error('craft: the window could not be cut to the visible part', err)
  }
}

function hideStrays(e: Docked): void {
  const u = user32()
  if (!u || !e.hwnd) return
  if (Date.now() - e.sweptAt < 1000) return
  e.sweptAt = Date.now()
  for (const h of strayWindows(e.pid, e.hwnd)) {
    u.ShowWindowAsync(h, SW_HIDE)
    if (!e.strays.includes(h)) e.strays.push(h)
  }
}

function place(e: Docked): void {
  const u = user32()
  if (!u || !grab(e) || !e.hwnd) return
  hideStrays(e)
  const hostShown = !!host && !host.isDestroyed() && host.isVisible() && !host.isMinimized()
  const t = hostShown && e.visible ? target(e) : null
  if (!t) {
    if (!e.hidden) {
      u.ShowWindowAsync(e.hwnd, SW_HIDE)
      e.hidden = true
    }
    return
  }
  const rect = { left: 0, top: 0, right: 0, bottom: 0 }
  u.GetWindowRect(e.hwnd, rect)
  const now = { x: rect.left, y: rect.top, w: rect.right - rect.left, h: rect.bottom - rect.top }
  const same = now.x === t.x && now.y === t.y && now.w === t.w && now.h === t.h
  // moved first, then shown, so it never shows where it was
  if (!same) {
    // a maximized or minimized app (from its own title bar buttons) ignores a move until it's restored
    if (Number(u.GetWindowLongPtrW(e.hwnd, GWL_STYLE)) & (WS_MAXIMIZE | WS_MINIMIZE)) u.ShowWindowAsync(e.hwnd, SW_RESTORE)
    const origin = { x: 0, y: 0 }
    if (!host || !u.ClientToScreen(hwndOf(host), origin)) return
    u.SetWindowPos(e.hwnd, 0, t.x - origin.x, t.y - origin.y, t.w, t.h, SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS)
    e.placed = t
  }
  cut(e, t)
  if (e.hidden) {
    u.ShowWindowAsync(e.hwnd, SW_SHOWNOACTIVATE)
    e.hidden = false
  }
}

// gives the window back as a normal one: title bar, border, no owner, on screen
export function release(appId: string): void {
  const e = docked.get(appId)
  docked.delete(appId)
  unhook(appId)
  const u = user32()
  if (!u || !e?.hwnd || !u.IsWindow(e.hwnd)) return
  try {
    u.SetParent(e.hwnd, e.parent)
    u.SetWindowLongPtrW(e.hwnd, GWL_STYLE, e.style)
    u.SetWindowLongPtrW(e.hwnd, GWL_EXSTYLE, e.exStyle)
    const original = e.original
    u.SetWindowPos(e.hwnd, 0, original?.left ?? 0, original?.top ?? 0, original ? original.right - original.left : 960, original ? original.bottom - original.top : 640, SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_ASYNCWINDOWPOS)
    if (e.region) u.SetWindowRgn(e.hwnd, 0, true)
    u.ShowWindowAsync(e.hwnd, SW_SHOWNOACTIVATE)
    for (const h of e.strays) if (u.IsWindow(h)) u.ShowWindowAsync(h, SW_SHOWNOACTIVATE)
  } catch {
    // it's closing anyway
  }
}

export function releaseAll(): void {
  for (const id of [...docked.keys()]) release(id)
}

export function forget(appId: string): void {
  failed.delete(appId)
  docked.delete(appId)
  unhook(appId)
}

export function isDocked(appId: string): boolean {
  return !!docked.get(appId)?.hwnd
}

export function dockState(appId: string): CraftDockState {
  if (!user32()) return 'unsupported'
  if (failed.has(appId)) return 'failed'
  const entry = docked.get(appId)
  if (!entry?.hwnd) return 'waiting'
  return entry.hidden ? 'hidden' : 'docked'
}

// asks the app to close the way its close button does, so it can ask to save first.
// works whether or not it's docked
export function askClose(pid: number): boolean {
  const u = user32()
  if (!u) return false
  const e = [...docked.values()].find((d) => d.pid === pid && d.hwnd && u.IsWindow(d.hwnd))
  const hwnd = e?.hwnd ?? windowsOf(pid)[0]
  if (!hwnd) return false
  u.PostMessageW(hwnd, WM_CLOSE, 0, 0)
  return true
}

// the app's window is docked and showing right now
export function isShown(appId: string): boolean {
  const e = docked.get(appId)
  return !!e?.hwnd && !e.hidden
}
