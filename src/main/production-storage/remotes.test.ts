import { describe, expect, it } from 'vitest'
import { createArgs, parseRemotes, remoteKind } from './remotes'

describe('rclone remotes', () => {
  it('reads listremotes and keeps only kinds TrendDeck works with', () => {
    const out = parseRemotes('gdrive:   drive\nbox: dropbox\none: onedrive\nr2:    s3\nb2x: b2\nlocalthing: local\nbad line\n')
    expect(out.map((r) => r.name)).toEqual(['gdrive', 'box', 'one', 'r2', 'b2x'])
    expect(remoteKind(out[3], { r2: 'r2' })).toBe('r2')
    expect(remoteKind(out[3], {})).toBe('s3')
    // a label that does not fit the backend is ignored
    expect(remoteKind(out[0], { gdrive: 'r2' })).toBe('drive')
  })

  it('builds config create args per kind', () => {
    expect(createArgs({ kind: 'drive', name: 'gdrive' }).args).toEqual(['config', 'create', 'gdrive', 'drive', 'scope=drive.file', '--non-interactive', '--log-level=ERROR'])
    expect(createArgs({ kind: 'dropbox', name: 'box' }).args.slice(0, 4)).toEqual(['config', 'create', 'box', 'dropbox'])
    const r2 = createArgs({ kind: 'r2', name: 'r2', accessKeyId: 'abcd', secretAccessKey: 'wxyz', accountId: '0'.repeat(32) })
    expect(r2.args).toContain('provider=Cloudflare')
    expect(r2.args).toContain(`endpoint=https://${'0'.repeat(32)}.r2.cloudflarestorage.com`)
    expect(r2.args[3]).toBe('s3')
    expect(r2.secrets).toEqual(['abcd', 'wxyz'])
    expect(createArgs({ kind: 's3', name: 's', accessKeyId: 'abcd', secretAccessKey: 'wxyz' }).args).toContain('region=us-east-1')
    expect(createArgs({ kind: 'b2', name: 'b', accessKeyId: 'abcd', secretAccessKey: 'wxyz' }).args).toContain('account=abcd')
  })

  it('refuses bad names, missing keys and odd values', () => {
    expect(() => createArgs({ kind: 'drive', name: '1bad' })).toThrow(/name/)
    expect(() => createArgs({ kind: 'drive', name: 'a b' })).toThrow(/name/)
    expect(() => createArgs({ kind: 'ftp', name: 'x' })).toThrow(/kind/)
    expect(() => createArgs({ kind: 's3', name: 's', accessKeyId: '', secretAccessKey: '' })).toThrow(/key/)
    expect(() => createArgs({ kind: 'r2', name: 'r', accessKeyId: 'abcd', secretAccessKey: 'wxyz', accountId: 'nope' })).toThrow(/account/)
    expect(() => createArgs({ kind: 's3', name: 's', accessKeyId: 'ab cd', secretAccessKey: 'wxyz' })).toThrow(/key id/)
  })
})
