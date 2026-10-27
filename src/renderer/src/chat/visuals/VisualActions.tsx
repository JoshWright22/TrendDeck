import { useRef, useState, type ReactNode } from 'react'
import { cleanError, type CardActions } from '../cards/useCards'
import {
  filmcraftOpen,
  insertText,
  openSketch,
  photocraftDocs,
  photoText,
  pictureOf,
  sendToAgent,
  targetName,
  toProject,
  type VisualTarget
} from './actions'

type Confirm = { app: 'filmcraft' } | { app: 'photocraft'; doc: string }

// the buttons under a visual: send it to your agent, add it to the video files, insert it at the
// FilmCraft playhead, open it in PhotoCraft, draw on it. `get` makes the target when it's needed,
// e.g. the sketch pad saves the drawing first
export default function VisualActions({
  a,
  get,
  kind,
  note = '',
  draw = true,
  primary = false,
  onDone
}: {
  a: CardActions
  get: () => Promise<VisualTarget>
  kind: 'image' | 'video' | 'gif' | 'audio'
  // the user's note, goes to the agent with the action
  note?: string
  draw?: boolean
  // the light button, only where this is the view's main action
  primary?: boolean
  // after an action that leaves this view, e.g. the sketch pad closes
  onDone?: (what: 'send' | 'project' | 'insert' | 'photocraft' | 'draw', message: string) => void
}): ReactNode {
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const pending = useRef(false)
  const noProject = !a.project
  const image = kind === 'image' || kind === 'gif'

  const run = async (label: string, fn: () => Promise<string | null>): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(label)
    setError('')
    setMsg('')
    try {
      const out = await fn()
      if (out) setMsg(out)
    } catch (err) {
      setError(cleanError(err))
    } finally {
      pending.current = false
      setBusy('')
    }
  }

  const send = (): Promise<void> =>
    run('send', async () => {
      const out = await sendToAgent(a, await get(), note)
      onDone?.('send', out)
      return out
    })

  const add = (): Promise<void> =>
    run('project', async () => {
      const out = await toProject(a, await get())
      const text = `${out.note}${out.credit ? ` Credit: ${out.credit}` : ''}`
      onDone?.('project', text)
      return text
    })

  const insert = (sure = false): Promise<void> =>
    run('insert', async () => {
      if (!a.hasAgent) throw new Error('Set up an agent first, it places the file with the FilmCraft tools.')
      if (!sure && !(await filmcraftOpen(a))) {
        setConfirm({ app: 'filmcraft' })
        return null
      }
      setConfirm(null)
      const t = await get()
      const out = await toProject(a, t)
      await a.sendToAgent(insertText(out.file, t, note))
      const text = `Added ${out.file} to the video files and asked your agent to insert it at the playhead.`
      onDone?.('insert', text)
      return text
    })

  const photo = (how: 'new' | 'layer' | null): Promise<void> =>
    run('photocraft', async () => {
      if (!a.hasAgent) throw new Error('Set up an agent first, it opens the file with the PhotoCraft tools.')
      const docs = await photocraftDocs(a)
      // the project already has a PhotoCraft file: a new file or a layer in that one?
      if (docs.length && how === null) {
        setConfirm({ app: 'photocraft', doc: docs[0] })
        return null
      }
      setConfirm(null)
      const t = await get()
      const out = await toProject(a, t)
      await a.sendToAgent(photoText(out.file, t, how ?? 'new', docs[0] ?? null, note))
      const text = how === 'layer' ? `Asked your agent to add ${out.file} as a layer in ${docs[0]}.` : `Asked your agent to open ${out.file} in PhotoCraft.`
      onDone?.('photocraft', text)
      return text
    })

  const drawOn = (): Promise<void> =>
    run('draw', async () => {
      const t = await get()
      const { src, asset } = await pictureOf(a, t)
      openSketch({ src, name: targetName(t) || asset.name, note })
      onDone?.('draw', '')
      return null
    })

  return (
    <div className="vs-actions">
      <div className="cx-card2-actions">
        <button type="button" className={primary ? 'primary' : undefined} disabled={!!busy} onClick={() => void send()} title="Goes out with your next message">
          {busy === 'send' ? 'Sending...' : 'Send to agent'}
        </button>
        <button type="button" disabled={!!busy || noProject} onClick={() => void add()} title={noProject ? 'Open a project to add files to it' : 'Saved in the project folder with its credit'}>
          {busy === 'project' ? 'Adding...' : 'Add to video files'}
        </button>
        <button type="button" disabled={!!busy || noProject || !a.hasAgent} onClick={() => void insert()} title="Your agent places it in FilmCraft with its tools">
          {busy === 'insert' ? 'Working...' : 'Insert at playhead'}
        </button>
        {image && (
          <button type="button" disabled={!!busy || noProject || !a.hasAgent} onClick={() => void photo(null)}>
            {busy === 'photocraft' ? 'Working...' : 'Open in PhotoCraft'}
          </button>
        )}
        {image && draw && (
          <button type="button" disabled={!!busy} onClick={() => void drawOn()}>
            {busy === 'draw' ? 'Loading...' : 'Draw on it'}
          </button>
        )}
      </div>
      {confirm?.app === 'filmcraft' && (
        <div className="cx-card2-actions" role="alertdialog" aria-label="Open FilmCraft">
          <span>FilmCraft isn't open on {a.project?.name}. Have your agent open it and insert there?</span>
          <button type="button" className="primary" disabled={!!busy} onClick={() => void insert(true)}>
            Open and insert
          </button>
          <button type="button" onClick={() => setConfirm(null)}>
            Cancel
          </button>
        </div>
      )}
      {confirm?.app === 'photocraft' && (
        <div className="cx-card2-actions" role="alertdialog" aria-label="Open in PhotoCraft">
          <span>This project has {confirm.doc}. Where should it go?</span>
          <button type="button" disabled={!!busy} onClick={() => void photo('layer')}>
            Add as a layer in {confirm.doc}
          </button>
          <button type="button" disabled={!!busy} onClick={() => void photo('new')}>
            New PhotoCraft file
          </button>
          <button type="button" onClick={() => setConfirm(null)}>
            Cancel
          </button>
        </div>
      )}
      {noProject && <p className="cx-card2-note">Open a project to add this to its files or the edit.</p>}
      {msg && (
        <p className="cx-card2-note" role="status">
          {msg}
        </p>
      )}
      {error && (
        <p className="cx-card2-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

