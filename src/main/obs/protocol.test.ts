import { describe, expect, it } from 'vitest'
import { authentication, identify, normalizeEndpoint, parseFrame, responseData } from './protocol'

describe('OBS v5 pure protocol helpers', () => {
  it('hashes the password with the salt, then with the challenge (OBS v5 auth)', () => {
    // expected value computed independently in python: b64(sha256(b64(sha256(password + salt)) + challenge))
    expect(authentication('', 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=', '+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY='))
      .toBe('veXHKDbw5MimhUsmjIA5hzA9OTsXwns/OSeuVqRO1BI=')
  })

  it('identifies RPC 1 without subscriptions or plaintext credentials', () => {
    expect(identify({ rpcVersion: 1 })).toEqual({ op: 1, d: { rpcVersion: 1, eventSubscriptions: 0 } })
    const frame = identify({ rpcVersion: 1, authentication: { salt: 'salt', challenge: 'challenge' } }, 'private-password')
    expect(JSON.stringify(frame)).not.toContain('private-password')
    expect(frame.d).toHaveProperty('authentication', authentication('private-password', 'salt', 'challenge'))
  })

  it('fails closed on incompatible protocol or missing credentials', () => {
    expect(() => identify({ rpcVersion: 0 })).toThrow('v5')
    expect(() => identify({ rpcVersion: 1, authentication: { salt: 'salt', challenge: 'challenge' } })).toThrow('requires a password')
    expect(() => identify({ rpcVersion: 1, authentication: {} }, 'private')).toThrow('challenge')
  })

  it.each(['ws://example.com:4455', 'wss://localhost:4455', 'http://127.0.0.1:4455', 'ws://user:private@localhost:4455', 'ws://127.0.0.1:4455/path', 'ws://localhost:4455?private=secret', 'ws://localhost:4455/#secret', 'ws://127.0.0.1.evil.test:4455'])('rejects unsafe endpoint %s', (endpoint) => {
    expect(() => normalizeEndpoint(endpoint)).toThrow('OBS endpoint')
  })

  it('pins localhost to loopback and permits IPv6 loopback', () => {
    expect(normalizeEndpoint('ws://localhost:4455')).toBe('ws://127.0.0.1:4455/')
    expect(normalizeEndpoint('ws://[::1]:4455')).toBe('ws://[::1]:4455/')
  })

  it('validates frames and response status without returning server error text', () => {
    expect(parseFrame('{"op":0,"d":{"rpcVersion":1}}').op).toBe(0)
    expect(() => parseFrame('null')).toThrow('Invalid OBS')
    expect(() => parseFrame('{"op":7,"d":[]}')).toThrow('Invalid OBS')
    expect(responseData({ requestType: 'GetVersion', requestStatus: { result: true }, responseData: { obsVersion: '32' } }, 'GetVersion')).toEqual({ obsVersion: '32' })
    expect(() => responseData({ requestType: 'StartRecord', requestStatus: { result: false, code: 500, comment: 'private-password' } }, 'StartRecord')).toThrow('code 500')
    expect(() => responseData({ requestType: 'StopRecord', requestStatus: { result: true } }, 'StartRecord')).toThrow('Invalid OBS')
  })
})
