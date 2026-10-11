import { useState, type ReactNode } from 'react'
import type { Brand } from '@shared/types'
import Modal from './Modal'
import { CloseIcon } from './Icons'

interface Props {
  // null means we are making a new brand
  brand: Brand | null
  onSave: (name: string, keywords: string[], subreddits: string[]) => void
  onDelete: () => void
  onClose: () => void
}

interface ChipList {
  values: string[]
  draft: string
}

function merge(list: ChipList, clean: (s: string) => string): string[] {
  const all = [...list.values]
  for (const raw of list.draft.split(',')) {
    const k = clean(raw)
    if (k && !all.some((x) => x.toLowerCase() === k.toLowerCase())) all.push(k)
  }
  return all
}

const cleanKeyword = (s: string): string => s.trim()
// people paste "r/buildapc" or the whole url
const cleanSub = (s: string): string =>
  s
    .trim()
    .replace(/^(https?:\/\/)?(www\.|old\.)?reddit\.com\//i, '')
    .replace(/^\/?r\//i, '')
    .replace(/\/.*$/, '')
    .replace(/[^A-Za-z0-9_]/g, '')
    .slice(0, 21)

function Chips(props: {
  label: string
  placeholder: string
  list: ChipList
  prefix?: string
  clean: (s: string) => string
  onChange: (list: ChipList) => void
}): ReactNode {
  const { label, placeholder, list, prefix = '', clean, onChange } = props
  const commit = (): void => onChange({ values: merge(list, clean), draft: '' })
  return (
    <>
      <label>
        {label}
        <input
          value={list.draft}
          placeholder={placeholder}
          onChange={(e) => onChange({ ...list, draft: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              commit()
            }
          }}
          onBlur={commit}
        />
      </label>
      {list.values.length > 0 && (
        <div className="chips">
          {list.values.map((k) => (
            <span key={k} className="chip">
              {prefix}
              {k}
              <button
                type="button"
                aria-label={`Remove ${k}`}
                onClick={() => onChange({ ...list, values: list.values.filter((x) => x !== k) })}
              >
                <CloseIcon />
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  )
}

export default function BrandModal({ brand, onSave, onDelete, onClose }: Props): ReactNode {
  const [name, setName] = useState(brand?.name ?? '')
  const [keywords, setKeywords] = useState<ChipList>({ values: brand?.keywords ?? [], draft: '' })
  const [subs, setSubs] = useState<ChipList>({ values: brand?.subreddits ?? [], draft: '' })
  const [confirmDelete, setConfirmDelete] = useState(false)

  const canSave = name.trim().length > 0

  return (
    <Modal title={brand ? 'Edit brand' : 'New brand'} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (canSave) onSave(name.trim(), merge(keywords, cleanKeyword), merge(subs, cleanSub))
        }}
      >
        <label>
          Name
          <input
            autoFocus
            value={name}
            maxLength={60}
            placeholder="Brand name"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <Chips
          label="Niche keywords"
          placeholder="Type one and press Enter"
          list={keywords}
          clean={cleanKeyword}
          onChange={setKeywords}
        />
        <p className="form-hint">Trends searches YouTube, Google Trends and Reddit for these.</p>

        <Chips
          label="Subreddits"
          placeholder="buildapc"
          prefix="r/"
          list={subs}
          clean={cleanSub}
          onChange={setSubs}
        />

        <div className="modal-actions">
          {brand &&
            (confirmDelete ? (
              <button type="button" className="btn danger" onClick={onDelete}>
                Delete and log out of its sites
              </button>
            ) : (
              <button type="button" className="btn ghost" onClick={() => setConfirmDelete(true)}>
                Delete brand
              </button>
            ))}
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!canSave}>
            {brand ? 'Save' : 'Add brand'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
