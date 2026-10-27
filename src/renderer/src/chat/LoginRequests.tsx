import { useState, type ReactNode } from 'react'
import type { LoginRequest } from '@shared/vault'
import { useLoginRequests } from './useLoginRequests'

function LoginCard({ request, onOpenSite }: { request: LoginRequest; onOpenSite: (siteId: string, url?: string) => void }): ReactNode {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const cancel = (): void => {
    setUsername('')
    setPassword('')
    void window.trenddeckVault.answerLogin(request.id, null).catch(() => setError('Could not dismiss this request. Try again.'))
  }
  return (
    <form className="cx-card cx-secure-login" data-over-craft onSubmit={(event) => {
      event.preventDefault()
      if (busy) return
      setBusy(true)
      setError('')
      void window.trenddeckVault.answerLogin(request.id, { username, password, notes: '', loginUrl: '' }).then((message) => {
        setPassword('')
        setError(message)
      }).catch(() => { setPassword(''); setError('Could not save securely. Try again.') }).finally(() => setBusy(false))
    }}>
      <header><strong>Sign in to {request.siteName}</strong><span className="cx-kind">Private input</span></header>
      <p>{new URL(request.siteUrl).hostname} / Saved encrypted for this brand. Your agent receives only the sign-in result, never your credentials.</p>
      <label>Username or email<input value={username} autoComplete="username" maxLength={320} disabled={busy} onChange={(event) => setUsername(event.target.value)} /></label>
      <label>Password<input type="password" value={password} autoComplete="current-password" maxLength={1000} disabled={busy} onChange={(event) => setPassword(event.target.value)} /></label>
      {error && <p role="alert">{error}</p>}
      <footer>
        <button type="button" className="pill" disabled={busy} onClick={cancel}>Cancel</button>
        <button type="button" className="pill" disabled={busy} onClick={() => { onOpenSite(request.siteId, request.siteUrl); cancel() }}>Sign in on website instead</button>
        <button type="submit" className="pill teal" disabled={busy || !username.trim() || !password}>{busy ? 'Saving securely...' : 'Save and sign in'}</button>
      </footer>
    </form>
  )
}

export default function LoginRequests({ brandId, threadId, onOpenSite }: { brandId: string; threadId: string | null; onOpenSite: (siteId: string, url?: string) => void }): ReactNode {
  const requests = useLoginRequests(brandId)
  return requests.filter((request) => request.threadId === null || request.threadId === threadId).map((request) => (
    <LoginCard key={request.id} request={request} onOpenSite={onOpenSite} />
  ))
}
