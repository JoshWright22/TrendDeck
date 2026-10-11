import { useState, type ReactNode } from 'react'
import { IDEA_STAGES, isHttpUrl, STAGE_NAMES, type Idea, type IdeaStage, type ScheduleSlot } from '@shared/types'
import Modal from '../../components/Modal'
import { parseTags, stageOf } from './board'

interface Props {
  idea: Idea
  // schedule slots that link this idea
  slots: ScheduleSlot[]
  onSave: (idea: Idea) => void
  onDelete: () => void
  onClose: () => void
}

const when = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})

function normalize(raw: string): string | null {
  const text = raw.trim()
  if (!text) return ''
  const url = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`
  return isHttpUrl(url) ? url : null
}

export default function IdeaEditor({ idea, slots, onSave, onDelete, onClose }: Props): ReactNode {
  const [title, setTitle] = useState(idea.title)
  const [notes, setNotes] = useState(idea.notes ?? '')
  const [url, setUrl] = useState(idea.url)
  const [tags, setTags] = useState((idea.tags ?? []).join(', '))
  const [stage, setStage] = useState<IdeaStage>(stageOf(idea))
  const clean = normalize(url)
  const canSave = title.trim().length > 0 && clean !== null

  return (
    <Modal title="Edit idea" onClose={onClose}>
      <form
        className="pl-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!canSave || clean === null) return
          onSave({
            ...idea,
            title: title.trim(),
            notes: notes.trim(),
            url: clean,
            tags: parseTags(tags),
            stage
          })
        }}
      >
        <label>
          Title
          <input autoFocus value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          Notes
          <textarea
            rows={6}
            value={notes}
            maxLength={5000}
            placeholder="Hook, outline, shots, whatever you need"
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <label>
          Source link
          <input value={url} placeholder="Where the idea came from" onChange={(e) => setUrl(e.target.value)} />
        </label>
        {clean === null && <p className="form-error">That doesn't look like a web address</p>}
        <div className="pl-row">
          <label>
            Tags
            <input value={tags} placeholder="shorts, tutorial" onChange={(e) => setTags(e.target.value)} />
          </label>
          <label>
            Column
            <select value={stage} onChange={(e) => setStage(e.target.value as IdeaStage)}>
              {IDEA_STAGES.map((s) => (
                <option key={s} value={s}>
                  {STAGE_NAMES[s]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {slots.length > 0 && (
          <div className="ib-planned">
            <span className="muted small">On the schedule</span>
            {[...slots]
              .sort((a, b) => a.at - b.at)
              .map((s) => (
                <span key={s.id} className={`small${s.done ? ' muted' : ''}`}>
                  {when.format(s.at)}, {s.platform}
                  {s.done ? ', posted' : ''}
                </span>
              ))}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn danger" onClick={onDelete}>
            Delete
          </button>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!canSave}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  )
}
