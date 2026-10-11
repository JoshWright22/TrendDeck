import { useState, type ReactNode } from 'react'
import { formatDuration, mediaUrl, type MediaInfo, type MediaItem } from '@shared/media'
import { AudioIcon, FileIcon, WarnIcon } from './MediaIcons'

// poster frame or image preview, a plain icon until the probe has run
export function Thumb({ item }: { item: MediaInfo | MediaItem }): ReactNode {
  const [broken, setBroken] = useState(false)
  const has = 'hasThumb' in item ? item.hasThumb : true
  const Fallback = item.kind === 'audio' ? AudioIcon : FileIcon
  return (
    <div className={`media-thumb kind-${item.kind}`}>
      {has && !broken && item.kind !== 'file' && item.kind !== 'audio' ? (
        <img
          src={mediaUrl(item.brandId, item.id, true)}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setBroken(true)}
        />
      ) : (
        <span className="media-thumb-icon">
          <Fallback />
          <span>{item.ext.toUpperCase() || 'FILE'}</span>
        </span>
      )}
      {item.duration !== null && <span className="media-len">{formatDuration(item.duration)}</span>}
      {item.missing && (
        <span className="media-missing" title="File not found">
          <WarnIcon />
        </span>
      )}
    </div>
  )
}

export function resolution(m: MediaInfo): string {
  return m.width && m.height ? `${m.width}x${m.height}` : ''
}

export function addedWhen(at: number): string {
  const d = new Date(at)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  }
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric'
  })
}

export function postedLine(m: MediaInfo): string {
  if (!m.posts.length) return 'Not posted yet'
  const names = [...new Set(m.posts.map((p) => p.platform))]
  return `Posted to ${names.join(', ')}`
}
