import { BrowserWindow, type WebContents } from 'electron'
import { partitionFor } from '@shared/types'
import { PLATFORM_NAMES, type PostItem, type StepReport } from '@shared/posting'
import type { Adapter, Selectors, Step } from './adapters/types'

const POLL_MS = 400
const DEFAULT_TIMEOUT = 30000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// runs in the page, finds the first visible match for a list of selectors
// see adapters/types.ts for the selector forms
const FINDER = String(function find(sels: string[], anyVis: boolean): Element | null {
  const visible = (el: Element): boolean => {
    if (anyVis || (el as HTMLInputElement).type === 'file') return true
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const deep = (root: ParentNode, sel: string): Element[] => {
    const out = Array.from(root.querySelectorAll(sel))
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (el.shadowRoot) out.push(...deep(el.shadowRoot, sel))
    }
    return out
  }
  const byText = (root: ParentNode, part: string): Element[] => {
    const at = part.indexOf('text=')
    const scope = part.slice(0, at).trim()
    const label = part.slice(at + 5).trim().toLowerCase()
    const bases: ParentNode[] = scope ? Array.from(root.querySelectorAll(scope)) : [root]
    const out: Element[] = []
    for (const b of bases) {
      for (const el of Array.from(
        b.querySelectorAll('button,[role="button"],a,[role="menuitem"],[role="tab"],div[tabindex]')
      )) {
        const t = ((el as HTMLElement).innerText || el.textContent || '').trim().toLowerCase()
        if (t === label) out.push(el)
      }
    }
    return out
  }
  const query = (sel: string): Element[] => {
    if (sel.startsWith('deep:')) return deep(document, sel.slice(5))
    let roots: ParentNode[] = [document]
    const parts = sel.split(' >>> ')
    let found: Element[] = []
    parts.forEach((part, i) => {
      found = []
      for (const r of roots) found.push(...(part.includes('text=') ? byText(r, part) : Array.from(r.querySelectorAll(part))))
      if (i < parts.length - 1) roots = found.map((e) => e.shadowRoot).filter((s): s is ShadowRoot => !!s)
    })
    return found
  }
  for (const s of sels) {
    try {
      const el = query(s).find(visible)
      if (el) return el
    } catch {
      // a bad selector shouldn't stop the others
    }
  }
  return null
})

function call(action: string, sels: Selectors, extra = 'null'): string {
  return `(() => { const find = ${FINDER}; const el = find(${JSON.stringify(sels)}, false); const arg = ${extra}; ${action} })()`
}

export class StepError extends Error {
  constructor(
    public step: string,
    message: string
  ) {
    super(message)
  }
}

export class Closed extends Error {
  constructor() {
    super('the window was closed')
  }
}

export interface Session {
  win: BrowserWindow
  closed: () => boolean
}

export function openWindow(brandId: string, title: string, show: boolean): Session {
  const win = new BrowserWindow({
    width: 1200,
    height: 860,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0E0E10',
    title,
    webPreferences: {
      partition: partitionFor(brandId),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // the site keeps working while the window is behind the app
      backgroundThrottling: false
    }
  })
  let closed = false
  win.on('closed', () => (closed = true))
  // keep the title ours so the user knows which window is posting
  win.on('page-title-updated', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  if (show) win.showInactive()
  return { win, closed: () => closed || win.isDestroyed() }
}

async function exec<T>(s: Session, code: string): Promise<T> {
  if (s.closed()) throw new Closed()
  return (await s.win.webContents.executeJavaScript(code, true)) as T
}

async function waitFor(
  s: Session,
  step: string,
  sels: Selectors,
  timeout: number,
  test = 'return !!el'
): Promise<void> {
  const end = Date.now() + timeout
  for (;;) {
    let ok = false
    try {
      ok = await exec<boolean>(s, call(test, sels))
    } catch (err) {
      if (err instanceof Closed) throw err
      // page in the middle of navigating, try again
    }
    if (ok) return
    if (Date.now() > end) throw new StepError(step, `couldn't find ${sels[0]}`)
    await sleep(POLL_MS)
  }
}

async function goto(s: Session, url: string): Promise<void> {
  try {
    await s.win.webContents.loadURL(url)
  } catch {
    // redirects reject the load promise, the page still opens
  }
  if (s.closed()) throw new Closed()
}

// files go in through the devtools protocol, the page can't set them from js
async function attachFile(s: Session, step: string, sels: Selectors, path: string): Promise<void> {
  const wc: WebContents = s.win.webContents
  const dbg = wc.debugger
  if (!dbg.isAttached()) dbg.attach('1.3')
  const res = (await dbg.sendCommand('Runtime.evaluate', {
    expression: `(() => { const find = ${FINDER}; return find(${JSON.stringify(sels)}, true) })()`
  })) as { result?: { objectId?: string } }
  const objectId = res.result?.objectId
  if (!objectId) throw new StepError(step, 'no file input on the page')
  await dbg.sendCommand('DOM.setFileInputFiles', { files: [path], objectId })
}

// focus the field, select what's in it, then type over it like a person would
async function typeInto(s: Session, step: string, sels: Selectors, text: string): Promise<void> {
  const ok = await exec<boolean>(
    s,
    call(
      `if (!el) return false
      el.scrollIntoView({ block: 'center' })
      el.focus()
      if ('select' in el && typeof el.select === 'function') { el.select() }
      else {
        const r = document.createRange(); r.selectNodeContents(el)
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r)
      }
      return true`,
      sels
    )
  )
  if (!ok) throw new StepError(step, 'field went away before typing')
  if (text) await s.win.webContents.insertText(text)
  else await exec(s, `document.execCommand('delete')`)
}

async function click(s: Session, step: string, sels: Selectors): Promise<void> {
  const ok = await exec<boolean>(
    s,
    call(`if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true`, sels)
  )
  if (!ok) throw new StepError(step, 'button went away before the click')
}

export interface RunOptions {
  post: PostItem
  adapter: Adapter
  // only look for each step, don't fill or press anything
  check?: boolean
  onStep?: (name: string) => void
}

const ENABLED =
  "return !!el && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !el.hasAttribute('disabled')"

// walks the adapter up to the final button, returns a report per step
export async function runSteps(s: Session, opts: RunOptions): Promise<StepReport[]> {
  const { post, adapter, check } = opts
  const report: StepReport[] = []
  let stopAfter = false
  for (const step of adapter.steps) {
    if (stopAfter || (step.when && !step.when(post))) {
      report.push({
        name: step.name,
        state: 'skipped',
        detail: stopAfter ? 'needs a real file to go further' : ''
      })
      continue
    }
    opts.onStep?.(step.name)
    try {
      await runStep(s, step, post, !!check)
      report.push({ name: step.name, state: 'ok', detail: '' })
    } catch (err) {
      if (err instanceof Closed) throw err
      if (step.optional) {
        report.push({ name: step.name, state: 'skipped', detail: 'not shown this time' })
        continue
      }
      const detail = err instanceof Error ? err.message : String(err)
      report.push({ name: step.name, state: 'broke', detail })
      throw Object.assign(new StepError(step.name, detail), { report })
    }
    // past the upload input the media sites only show the rest once a file is in
    if (check && step.kind === 'file' && adapter.steps.some((x) => x.kind === 'file' && !x.when)) {
      stopAfter = true
    }
  }
  if (stopAfter) {
    report.push({ name: 'find Post button', state: 'skipped', detail: 'needs a real file to go further' })
    return report
  }
  opts.onStep?.('find Post button')
  try {
    if (check) await waitFor(s, 'find Post button', adapter.post.find, DEFAULT_TIMEOUT)
    else await waitFor(s, 'find Post button', adapter.post.find, adapter.post.timeout ?? DEFAULT_TIMEOUT, ENABLED)
    report.push({ name: 'find Post button', state: 'ok', detail: '' })
  } catch (err) {
    if (err instanceof Closed) throw err
    const detail = err instanceof Error ? err.message : String(err)
    report.push({ name: 'find Post button', state: 'broke', detail })
    throw Object.assign(new StepError('find Post button', detail), { report })
  }
  return report
}

async function runStep(s: Session, step: Step, post: PostItem, check: boolean): Promise<void> {
  const timeout = step.timeout ?? DEFAULT_TIMEOUT
  switch (step.kind) {
    case 'goto':
      return goto(s, step.url(post))
    case 'pause':
      return sleep(step.ms)
    case 'wait':
      return waitFor(s, step.name, step.find, timeout)
    case 'click':
      await waitFor(s, step.name, step.find, timeout, check ? 'return !!el' : ENABLED)
      // in a check, only clicks that open things get pressed, the rest are just found
      if (!check || !step.name.startsWith('next')) await click(s, step.name, step.find)
      return
    case 'type':
      await waitFor(s, step.name, step.find, timeout)
      if (!check) await typeInto(s, step.name, step.find, step.text(post))
      return
    case 'file':
      await waitFor(s, step.name, step.find, timeout, 'return !!find(' + JSON.stringify(step.find) + ', true)')
      if (!check) await attachFile(s, step.name, step.find, post.mediaPath)
      return
  }
}

// a teal ring round the Post button so it's easy to spot
export async function markPostButton(s: Session, adapter: Adapter): Promise<void> {
  await exec(
    s,
    call(
      `if (!el) return; el.scrollIntoView({ block: 'center' }); el.style.outline = '3px solid #00BF9C'; el.style.outlineOffset = '3px'`,
      adapter.post.find
    )
  ).catch(() => {})
}

export async function pressPost(s: Session, adapter: Adapter): Promise<void> {
  await click(s, 'press Post', adapter.post.find)
}

// true once the site shows the post went out
export async function isDone(s: Session, adapter: Adapter): Promise<boolean> {
  const { texts = [], find = [], url } = adapter.done
  if (url && url.test(s.win.webContents.getURL())) return true
  return exec<boolean>(
    s,
    `(() => {
      const find = ${FINDER}
      if (${JSON.stringify(find)}.length && find(${JSON.stringify(find)}, false)) return true
      const text = document.body ? document.body.innerText : ''
      return ${JSON.stringify(texts)}.some((t) => text.includes(t))
    })()`
  ).catch((err) => {
    if (err instanceof Closed) throw err
    return false
  })
}

export function windowTitle(post: PostItem, check: boolean): string {
  const name = PLATFORM_NAMES[post.platform]
  return check ? `TrendDeck self-check: ${name}` : `TrendDeck posting to ${name}`
}
