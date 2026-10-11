import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { CodeRequest } from '@shared/vault'
import Modal from '../Modal'
import './vault.css'

// a login hit a two-factor page. the code goes from here into the page, agents never get it
export default function CodePrompt(): ReactNode {
  const api = window.trenddeckVault
  const [req, setReq] = useState<CodeRequest | null>(null)
  const [code, setCode] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(
    () =>
      api.onCodeRequest((r) => {
        setCode('')
        setReq(r)
      }),
    [api]
  )

  useEffect(() => {
    if (req) input.current?.focus()
  }, [req])

  if (!req) return null
  const answer = (value: string | null): void => {
    void api.answerCode(req.id, value)
    setReq(null)
    setCode('')
  }

  return (
    <Modal title={`Code for ${req.siteName}`} onClose={() => answer(null)}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          answer(code)
        }}
      >
        <p className="form-hint">
          {req.siteName} wants a sign-in code from your app, text or email. Type it here and
          TrendDeck puts it in. Your agent doesn't see it.
        </p>
        <label>
          Code
          <input
            ref={input}
            className="vault-code"
            value={code}
            inputMode="numeric"
            autoComplete="one-time-code"
            spellCheck={false}
            maxLength={16}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={() => answer(null)}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={code.replace(/[\s-]/g, '').length < 4}>
            Sign in
          </button>
        </div>
      </form>
    </Modal>
  )
}
