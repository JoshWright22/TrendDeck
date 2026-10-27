import { useState, type ReactNode } from 'react'
import { MAX_STAGES, STAGE_KINDS, WORKSPACES, type PipelineStage, type StageKind } from '@shared/pipeline'
import { Dropdown } from '../chat/ui'
import { CloseIcon, PlusIcon } from '../components/Icons'
import { workspaceFor } from './registry'

// the user editing their own pipeline: rename, drag to reorder, add and remove, pick the kind
// and workspace, and which stages the agent may finish without asking. saved in one go

interface Props {
  brandId: string
  stages: PipelineStage[]
  onClose: () => void
}

const KIND_LABELS: Record<StageKind, string> = {
  research: 'Research',
  idea: 'Idea',
  script: 'Script',
  record: 'Record',
  edit: 'Edit',
  thumbnail: 'Thumbnail',
  captions: 'Captions',
  review: 'Review',
  schedule: 'Schedule',
  post: 'Post',
  engage: 'Engage',
  custom: 'Custom'
}

const wsLabel = (key: string): string => (key === 'none' ? 'Nothing' : (workspaceFor(key)?.label ?? key))

// stage ids are lowercase, a new one gets a short suffix so it never clashes
function stageId(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 28) || 'stage'
  let id = base
  while (taken.has(id)) id = `${base}-${Math.random().toString(36).slice(2, 6)}`
  return id
}

const cleanError = (err: unknown): string =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)

export default function PipelineEditor({ brandId, stages: initial, onClose }: Props): ReactNode {
  const [stages, setStages] = useState<PipelineStage[]>(() => initial.map((s) => ({ ...s, config: { ...s.config } })))
  const [drag, setDrag] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const edit = (i: number, patch: Partial<PipelineStage>): void =>
    setStages((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)))

  const move = (from: number, to: number): void =>
    setStages((list) => {
      const next = [...list]
      const [s] = next.splice(from, 1)
      next.splice(to, 0, s)
      return next
    })

  const add = (): void =>
    setStages((list) => {
      const label = 'New stage'
      return [
        ...list,
        { id: stageId(label, new Set(list.map((s) => s.id))), label, kind: 'custom', workspace: 'none', config: {}, auto: false }
      ]
    })

  const changed = JSON.stringify(stages) !== JSON.stringify(initial)
  const valid = stages.length > 0 && stages.every((s) => s.label.trim())

  const save = async (): Promise<void> => {
    if (!valid) return
    setSaving(true)
    setError('')
    try {
      await window.trenddeckPipeline.set(
        brandId,
        stages.map((s) => ({ ...s, label: s.label.trim() }))
      )
      onClose()
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setSaving(false)
    }
  }

  const workspaces = [...WORKSPACES]

  return (
    <div className="pe" role="dialog" aria-label="Edit pipeline">
      <header className="pe-head">
        <span className="pe-title">Edit pipeline</span>
        <span className="muted">
          {stages.length} of {MAX_STAGES} stages
        </span>
        <span className="spacer" />
        <button className="ws-head-btn" onClick={onClose}>
          Cancel
        </button>
        <button className="pill teal" disabled={!changed || !valid || saving} onClick={() => void save()}>
          {saving ? 'Saving' : 'Save'}
        </button>
      </header>
      <p className="pe-hint">
        Drag to reorder. Auto lets the agent finish a stage and move on without asking you.
      </p>
      {error && <p className="cx-error pe-error">{error}</p>}
      <ol className="pe-list">
        {stages.map((s, i) => (
          <li
            key={s.id}
            className={`pe-row${drag === i ? ' dragging' : ''}${over === i && drag !== null && drag !== i ? ' over' : ''}`}
            draggable
            onDragStart={(e) => {
              // only the handle starts a drag, the inputs keep their own text selection
              if (!(e.target as HTMLElement).closest('.pe-row')) return
              setDrag(i)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', s.id)
            }}
            onDragOver={(e) => {
              if (drag === null) return
              e.preventDefault()
              setOver(i)
            }}
            onDragLeave={() => setOver((o) => (o === i ? null : o))}
            onDrop={(e) => {
              e.preventDefault()
              if (drag !== null && drag !== i) move(drag, i)
              setDrag(null)
              setOver(null)
            }}
            onDragEnd={() => {
              setDrag(null)
              setOver(null)
            }}
          >
            <span className="pe-grip" aria-hidden="true" title="Drag to reorder">
              ⋮⋮
            </span>
            <span className="pe-num">{i + 1}</span>
            <input
              className="pe-label"
              value={s.label}
              maxLength={60}
              aria-label={`Stage ${i + 1} name`}
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
              onChange={(e) => edit(i, { label: e.target.value })}
            />
            <Dropdown
              className="pe-dd"
              label="Kind"
              title="What this stage is"
              value={s.kind}
              options={STAGE_KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] }))}
              onChange={(kind) => edit(i, { kind })}
            />
            <Dropdown
              className="pe-dd"
              label="Workspace"
              title="What the pane opens for this stage"
              value={s.workspace}
              options={(workspaces.includes(s.workspace as (typeof WORKSPACES)[number]) ? workspaces : [...workspaces, s.workspace]).map((w) => ({
                value: w,
                label: wsLabel(w)
              }))}
              onChange={(workspace) => edit(i, { workspace })}
            />
            <label className="pe-auto" title="The agent may finish this stage without asking">
              <input type="checkbox" checked={s.auto} onChange={(e) => edit(i, { auto: e.target.checked })} />
              Auto
            </label>
            <span className="pe-moves">
              <button
                className="icon-btn small"
                aria-label={`Move ${s.label} up`}
                title="Move up"
                disabled={i === 0}
                onClick={() => move(i, i - 1)}
              >
                ↑
              </button>
              <button
                className="icon-btn small"
                aria-label={`Move ${s.label} down`}
                title="Move down"
                disabled={i === stages.length - 1}
                onClick={() => move(i, i + 1)}
              >
                ↓
              </button>
            </span>
            <button
              className="icon-btn small"
              aria-label={`Remove ${s.label}`}
              title="Remove"
              disabled={stages.length <= 1}
              onClick={() => setStages((list) => list.filter((_, j) => j !== i))}
            >
              <CloseIcon />
            </button>
          </li>
        ))}
      </ol>
      <button className="tree-add pe-add" disabled={stages.length >= MAX_STAGES} onClick={add}>
        <PlusIcon />
        Add stage
      </button>
    </div>
  )
}
