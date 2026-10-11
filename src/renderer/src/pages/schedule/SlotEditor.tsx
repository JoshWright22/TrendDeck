import { useMemo, useState, type ReactNode } from 'react'
import { PLATFORMS, STAGE_NAMES, type Idea, type ScheduleSlot } from '@shared/types'
import Modal from '../../components/Modal'
import { stageOf } from '../ideas/board'
import { fromInputs, toDateInput, toTimeInput } from './dates'

interface Props {
  slot: ScheduleSlot
  isNew: boolean
  ideas: Idea[]
  onSave: (slot: ScheduleSlot) => void
  onDelete: () => void
  onClose: () => void
}

export default function SlotEditor({ slot, isNew, ideas, onSave, onDelete, onClose }: Props): ReactNode {
  const [date, setDate] = useState(toDateInput(slot.at))
  const [time, setTime] = useState(toTimeInput(slot.at))
  const [platform, setPlatform] = useState(slot.platform)
  const [title, setTitle] = useState(slot.title)
  const [ideaId, setIdeaId] = useState(slot.ideaId)
  const [draft, setDraft] = useState(slot.draft)
  const [done, setDone] = useState(slot.done)
  const at = fromInputs(date, time)
  const idea = ideas.find((i) => i.id === ideaId)

  // ideas still in progress first, posted ones last
  const options = useMemo(
    () =>
      [...ideas].sort(
        (a, b) => Number(stageOf(a) === 'posted') - Number(stageOf(b) === 'posted')
      ),
    [ideas]
  )
  const platforms = (PLATFORMS as readonly string[]).includes(platform)
    ? PLATFORMS
    : [...PLATFORMS, platform]

  return (
    <Modal title={isNew ? 'Plan a post' : 'Edit post'} onClose={onClose}>
      <form
        className="pl-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (at === null) return
          onSave({ ...slot, at, platform, title: title.trim(), ideaId, draft: draft.trim(), done })
        }}
      >
        <div className="pl-row">
          <label>
            Day
            <input type="date" value={date} required onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            Time
            <input type="time" value={time} required onChange={(e) => setTime(e.target.value)} />
          </label>
          <label>
            Platform
            <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
              {platforms.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Idea
          <select value={ideaId} onChange={(e) => setIdeaId(e.target.value)}>
            <option value="">No idea linked</option>
            {options.map((i) => (
              <option key={i.id} value={i.id}>
                {i.title.length > 60 ? `${i.title.slice(0, 60)}...` : i.title} ({STAGE_NAMES[stageOf(i)]})
              </option>
            ))}
            {ideaId && !idea && <option value={ideaId}>Deleted idea</option>}
          </select>
        </label>
        <label>
          Title
          <input
            autoFocus={isNew}
            value={title}
            maxLength={300}
            placeholder={idea ? idea.title : 'What goes out'}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          Draft
          <textarea
            rows={7}
            value={draft}
            maxLength={20000}
            placeholder="Caption, description or the post itself"
            onChange={(e) => setDraft(e.target.value)}
          />
        </label>
        <label className="sc-check">
          <input type="checkbox" checked={done} onChange={(e) => setDone(e.target.checked)} />
          Posted
        </label>
        {at === null && <p className="form-error">Pick a day and a time</p>}
        <div className="modal-actions">
          {!isNew && (
            <button type="button" className="btn danger" onClick={onDelete}>
              Delete
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={at === null}>
            {isNew ? 'Add to schedule' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
