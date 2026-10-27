import { useEffect, useState, type ReactNode } from 'react'
import type { Brand } from '@shared/types'
import type { ChannelState } from '@shared/content-map'
import ContentMap, { ago, useContentMap } from './ContentMap'
import './content-map.css'

// settings section: connect the brand's channel for the content map. YouTube with the creator's
// own Google sign-in (read only), or a public channel without one. the client secret and the
// tokens stay in main, this view only learns whether they're saved

const MODE: Record<ChannelState['mode'], string> = {
  oauth: 'Connected with Google: views, watch time, retention and subscribers.',
  'api-key': 'Public data with your YouTube API key: views, likes and comments for every upload.',
  rss: "Public feed: the channel's 15 newest videos with views and likes.",
  none: 'Not connected. The map still shows your TrendDeck projects.'
}

export default function ChannelsSection({ brand }: { brand: Brand }): ReactNode {
  const api = window.trenddeckContentMap
  const { view } = useContentMap(brand.id)
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [editClient, setEditClient] = useState(false)
  const [channel, setChannel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const ch = view?.channel

  useEffect(() => {
    if (ch) {
      setChannel(ch.publicChannel)
      setClientId(ch.clientId)
    }
  }, [ch?.publicChannel, ch?.clientId])

  if (!ch) return <p className="form-hint">Loading...</p>

  const act = async (fn: () => Promise<unknown>, done = ''): Promise<void> => {
    setBusy(true)
    setError('')
    setNote('')
    try {
      await fn()
      if (done) setNote(done)
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
    } finally {
      setBusy(false)
    }
  }

  const showClientForm = !ch.hasClient || editClient
  return (
    <div className="cm-settings">
      <p className="form-hint">
        Your past videos and how each did against your own usual numbers. Your agent reads this map when you plan a new
        video, and checks each new upload at 1 hour, 6 hours, 1, 2, 7 and 28 days.
      </p>
      <p className="ctx-status">
        {MODE[ch.mode]}
        {ch.channelTitle ? ` Channel: ${ch.channelTitle}.` : ''} {ch.syncing ? 'Syncing now.' : `Last synced ${ago(ch.lastSync)}.`}
      </p>
      {ch.lastSyncNote && !ch.lastSyncOk && <p className="form-error">{ch.lastSyncNote}</p>}

      <h4>YouTube with Google</h4>
      {showClientForm ? (
        <>
          <p className="form-hint">TrendDeck uses your own Google Cloud OAuth client, so the sign-in and the quota are yours. Once:</p>
          <ol>
            <li>In Google Cloud Console, make a project and enable YouTube Data API v3 and YouTube Analytics API.</li>
            <li>Set up the OAuth consent screen as External and add your Google account as a test user.</li>
            <li>Create an OAuth client ID of type Desktop app and paste its ID and secret here.</li>
          </ol>
          <label>
            OAuth client ID
            <input value={clientId} autoComplete="off" spellCheck={false} placeholder="....apps.googleusercontent.com" onChange={(e) => setClientId(e.target.value)} />
          </label>
          <label>
            Client secret
            <input
              value={secret}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={ch.hasClient ? 'Saved, leave empty to keep it' : ''}
              onChange={(e) => setSecret(e.target.value)}
            />
          </label>
          <div className="row-actions">
            <button
              type="button"
              className="btn primary"
              disabled={busy || !clientId.trim()}
              onClick={() =>
                void act(async () => {
                  await api.setClient(clientId, secret)
                  setSecret('')
                  setEditClient(false)
                }, 'Saved. The secret is encrypted on this computer.')
              }
            >
              Save client
            </button>
            {ch.hasClient && (
              <>
                <button type="button" className="btn ghost" disabled={busy} onClick={() => setEditClient(false)}>
                  Cancel
                </button>
                <button type="button" className="btn ghost" disabled={busy} onClick={() => void act(async () => (await api.clearClient(), setEditClient(false)))}>
                  Remove client
                </button>
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="form-hint">
            {ch.mode === 'oauth'
              ? 'Read only: TrendDeck can see your videos and analytics, it can\'t change or post anything with this sign-in.'
              : 'Opens Google in your browser. TrendDeck asks for read-only access to your videos and analytics.'}
          </p>
          <div className="row-actions">
            {ch.mode === 'oauth' ? (
              <>
                <button type="button" className="btn primary" disabled={busy || ch.syncing} onClick={() => void act(() => api.sync(brand.id))}>
                  Sync now
                </button>
                <button type="button" className="btn ghost" disabled={busy} onClick={() => void act(() => api.disconnect(brand.id), 'Disconnected. TrendDeck removed the sign-in.')}>
                  Disconnect
                </button>
              </>
            ) : (
              <button type="button" className="btn primary" disabled={busy || ch.connecting} onClick={() => void act(() => api.connect(brand.id), 'Connected.')}>
                {ch.connecting ? 'Waiting for Google...' : 'Connect YouTube'}
              </button>
            )}
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setEditClient(true)}>
              Change OAuth client
            </button>
          </div>
        </>
      )}

      <h4>Public channel</h4>
      <p className="form-hint">
        Without the Google sign-in, TrendDeck reads the channel's public numbers.{' '}
        {ch.hasApiKey ? 'Your YouTube API key from Settings, Trends covers every upload.' : 'Add a YouTube API key in Settings, Trends for every upload, otherwise the public feed gives the 15 newest.'}
      </p>
      <div className="allow-add">
        <input value={channel} spellCheck={false} placeholder="@yourchannel or UC..." aria-label="Public channel" onChange={(e) => setChannel(e.target.value)} />
        <button type="button" className="btn ghost" disabled={busy || channel.trim() === ch.publicChannel} onClick={() => void act(() => api.setPublicChannel(brand.id, channel))}>
          {channel.trim() || !ch.publicChannel ? 'Use this channel' : 'Clear'}
        </button>
        {ch.mode !== 'oauth' && ch.publicChannel && (
          <button type="button" className="btn ghost" disabled={busy || ch.syncing} onClick={() => void act(() => api.sync(brand.id))}>
            Sync now
          </button>
        )}
      </div>

      <h4>Impressions and click-through rate</h4>
      <p className="form-hint">
        YouTube's API doesn't give these per video. In YouTube Studio, open Analytics, Advanced mode, Content, and export
        the table as CSV, then import it here.{ch.csvImportedAt ? ` Last imported ${ago(ch.csvImportedAt)}.` : ''}
      </p>
      <div className="row-actions">
        <button
          type="button"
          className="btn ghost"
          disabled={busy || !ch.videos}
          onClick={() =>
            void act(async () => {
              const r = await api.importCsv(brand.id)
              if (r) setNote(`Matched ${r.matched} of ${r.rows} videos in the export.`)
            })
          }
        >
          Import Studio export
        </button>
      </div>

      {view.pillars.some((p) => p.id) && (
        <>
          <h4>Pillars</h4>
          <ul className="cm-pillars">
            {view.pillars
              .filter((p) => p.id)
              .map((p) => (
                <li key={p.id}>
                  <span>
                    {p.label}
                    <span className="cm-sub">{p.keywords.join(', ')}</span>
                  </span>
                  <button type="button" className="btn ghost small" disabled={busy} onClick={() => void act(() => api.removePillar(brand.id, p.id))}>
                    Remove
                  </button>
                </li>
              ))}
          </ul>
        </>
      )}

      {ch.quotaUsedToday > 0 && (
        <p className="form-hint">
          YouTube quota used today: {ch.quotaUsedToday.toLocaleString('en-US')} of the {ch.quotaLimit.toLocaleString('en-US')} units TrendDeck allows itself.
          {ch.backoffUntil ? ` Snapshots wait until ${new Date(ch.backoffUntil).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.` : ''}
        </p>
      )}
      {note && <p className="form-hint">{note}</p>}
      {error && <p className="form-error">{error}</p>}

      <h4>Map</h4>
      <ContentMap brandId={brand.id} projects={brand.projects} />
    </div>
  )
}
