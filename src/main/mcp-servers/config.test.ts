import { describe, expect, it } from 'vitest'
import type { McpServerInput } from '@shared/mcp-servers'
import {
  applyInput,
  cleanServer,
  cleanServers,
  cleanToolDefs,
  ConfigError,
  defaultSecret,
  nameProblem,
  pairValues,
  secretsOf,
  toolEntries,
  toView,
  urlProblem,
  type StoredServer
} from './config'

// a stand in for safeStorage: reversible, and the sealed form never equals the plain one
const seal = (v: string): string => (v ? `enc:${Buffer.from(v).toString('base64')}` : '')
const unseal = (v: string): string => (v.startsWith('enc:') ? Buffer.from(v.slice(4), 'base64').toString() : '')

function stdio(patch: Partial<McpServerInput> = {}): McpServerInput {
  return {
    id: 'files',
    create: true,
    label: 'Files',
    kind: 'stdio',
    command: 'npx',
    args: ['-y', 'some-server'],
    cwd: '',
    env: [],
    url: '',
    headers: [],
    brandId: 'brand-a',
    ...patch
  }
}

function http(patch: Partial<McpServerInput> = {}): McpServerInput {
  return { ...stdio(), id: 'web', kind: 'http', command: '', args: [], url: 'https://mcp.example.com/mcp', ...patch }
}

const fails = (input: unknown, old: StoredServer | null = null, taken: string[] = []): string => {
  try {
    applyInput(input, old, taken, seal)
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError)
    return (err as Error).message
  }
  throw new Error('expected a ConfigError')
}

const live = { status: 'off' as const, error: '' }

describe('names', () => {
  it('takes short lowercase ids', () => {
    expect(nameProblem('files', [])).toBeNull()
    expect(nameProblem('a1', [])).toBeNull()
    expect(nameProblem('a'.repeat(20), [])).toBeNull()
  })

  it('refuses bad names', () => {
    for (const bad of ['', 'Files', '1files', 'my_server', 'my-server', 'a'.repeat(21), 'files ', 'fi les']) {
      expect(nameProblem(bad, []), bad).not.toBeNull()
    }
  })

  it("refuses TrendDeck's own prefixes and craft app ids", () => {
    for (const bad of ['craft', 'git', 'storage', 'pipeline', 'run', 'media', 'review', 'show', 'suggest', 'brand', 'past', 'remember', 'style', 'qc', 'obs', 'filmcraft', 'photocraft']) {
      expect(nameProblem(bad, []), bad).toMatch(/already uses/)
    }
  })

  it('refuses a name you already have when adding', () => {
    expect(fails(stdio(), null, ['files'])).toMatch(/already have/)
  })

  it("can't edit a server that isn't saved", () => {
    expect(fails(stdio({ create: false }))).toMatch(/isn't saved/)
  })
})

describe('urls', () => {
  it('takes http and https', () => {
    expect(urlProblem('https://mcp.example.com/mcp')).toBeNull()
    expect(urlProblem('http://127.0.0.1:3000/mcp')).toBeNull()
  })

  it('refuses other schemes and junk', () => {
    for (const bad of ['', 'ftp://example.com', 'file:///c:/x', 'javascript:alert(1)', 'example.com/mcp', 'ws://example.com']) {
      expect(urlProblem(bad), bad).not.toBeNull()
    }
  })

  it('refuses a login in the address', () => {
    expect(urlProblem('https://user:pw@example.com/mcp')).toMatch(/login/)
    expect(urlProblem('https://user@example.com/mcp')).toMatch(/login/)
    expect(fails(http({ url: 'https://user:pw@example.com/mcp' }))).toMatch(/login/)
  })

  it('refuses line breaks', () => {
    expect(urlProblem('https://example.com/\r\nx')).not.toBeNull()
  })
})

describe('commands and env', () => {
  it('saves a stdio server, on for the brand it was added from only and untrusted', () => {
    const s = applyInput(stdio(), null, [], seal, 5)
    expect(s.brands).toEqual({ 'brand-a': true })
    expect(s.trusted).toBe(false)
    expect(s.addedAt).toBe(5)
    expect(s.args).toEqual(['-y', 'some-server'])
  })

  it('refuses a missing or odd command', () => {
    expect(fails(stdio({ command: '' }))).toMatch(/command/)
    expect(fails(stdio({ command: 'npx\r\nx' }))).toMatch(/line breaks/)
    expect(fails(stdio({ command: '"C:\\x y\\a.exe"' }))).toMatch(/quotes/)
  })

  it('refuses too many or bad arguments', () => {
    expect(fails(stdio({ args: Array.from({ length: 65 }, (_, i) => `a${i}`) }))).toMatch(/Up to 64/)
    expect(fails(stdio({ args: ['ok', 'two\nlines'] }))).toMatch(/line breaks/)
    expect(fails(stdio({ args: [3 as unknown as string] }))).toMatch(/bad arguments/)
  })

  it('refuses bad env names, reserved ones and twins', () => {
    expect(fails(stdio({ env: [{ key: '1ABC', value: 'x', secret: false }] }))).toMatch(/valid variable/)
    expect(fails(stdio({ env: [{ key: 'A B', value: 'x', secret: false }] }))).toMatch(/valid variable/)
    expect(fails(stdio({ env: [{ key: 'A=B', value: 'x', secret: false }] }))).toMatch(/valid variable/)
    expect(fails(stdio({ env: [{ key: 'ELECTRON_RUN_AS_NODE', value: '1', secret: false }] }))).toMatch(/itself/)
    expect(
      fails(
        stdio({
          env: [
            { key: 'Path', value: 'a', secret: false },
            { key: 'PATH', value: 'b', secret: false }
          ]
        })
      )
    ).toMatch(/twice/)
  })

  it('refuses a relative folder to run in', () => {
    expect(fails(stdio({ cwd: 'some\\folder' }))).toMatch(/full path/)
    expect(applyInput(stdio({ cwd: 'C:\\Users\\me\\work' }), null, [], seal).cwd).toBe('C:\\Users\\me\\work')
  })

  it('skips empty rows', () => {
    const s = applyInput(stdio({ env: [{ key: '', value: '', secret: false }] }), null, [], seal)
    expect(s.env).toEqual([])
  })
})

describe('headers', () => {
  it('refuses line breaks in a header value', () => {
    expect(fails(http({ headers: [{ key: 'X-Team', value: 'a\r\nInjected: yes', secret: false }] }))).toMatch(/line breaks/)
    expect(fails(http({ headers: [{ key: 'X-Team', value: 'a\nb', secret: true }] }))).toMatch(/line breaks/)
  })

  it('refuses bad and reserved header names', () => {
    expect(fails(http({ headers: [{ key: 'Bad Header', value: 'x', secret: false }] }))).toMatch(/valid header/)
    expect(fails(http({ headers: [{ key: 'X-A\r\nB', value: 'x', secret: false }] }))).toMatch(/valid header/)
    expect(fails(http({ headers: [{ key: 'Mcp-Session-Id', value: 'x', secret: false }] }))).toMatch(/itself/)
    expect(fails(http({ headers: [{ key: 'Content-Type', value: 'x', secret: false }] }))).toMatch(/itself/)
  })
})

describe('secrets', () => {
  it('starts key and token names out secret', () => {
    for (const k of ['YOUTUBE_API_KEY', 'GITHUB_TOKEN', 'Authorization', 'X-Api-Key', 'OPENAI_KEY', 'DB_PASSWORD', 'CLIENT_SECRET']) {
      expect(defaultSecret(k), k).toBe(true)
    }
    for (const k of ['DEBUG', 'LANG', 'X-Team', 'MEMORY_FILE_PATH', 'MONKEY']) expect(defaultSecret(k), k).toBe(false)
  })

  it('seals secret values and never puts them in the view', () => {
    const s = applyInput(
      stdio({
        env: [
          { key: 'YOUTUBE_API_KEY', value: 'abc', secret: true },
          { key: 'DEBUG', value: '1', secret: false }
        ]
      }),
      null,
      [],
      seal
    )
    expect(s.env[0].value).not.toBe('abc')
    expect(s.env[0].value.startsWith('enc:')).toBe(true)
    const v = toView(s, 'brand-a', live, null)
    expect(v.env).toEqual([
      { key: 'YOUTUBE_API_KEY', secret: true, set: true },
      { key: 'DEBUG', secret: false, value: '1' }
    ])
    const text = JSON.stringify(v)
    expect(text).not.toContain('abc')
    expect(text).not.toContain(s.env[0].value)
    expect(text).not.toContain('enc:')
  })

  it('keeps header secrets out of the view too', () => {
    const s = applyInput(http({ headers: [{ key: 'Authorization', value: 'abc', secret: true }] }), null, [], seal)
    const text = JSON.stringify(toView(s, 'brand-a', live, null))
    expect(text).not.toContain('abc')
    expect(text).not.toContain('enc:')
    expect(pairValues(s.headers, unseal)).toEqual({ Authorization: 'abc' })
    expect(secretsOf(s, unseal)).toEqual(['abc'])
  })

  it('keeps the saved secret when it comes back empty', () => {
    const first = applyInput(stdio({ env: [{ key: 'API_KEY', value: 'abc', secret: true }] }), null, [], seal)
    const again = applyInput(stdio({ create: false, label: 'Renamed', env: [{ key: 'API_KEY', value: '', secret: true }] }), first, ['files'], seal)
    expect(again.label).toBe('Renamed')
    expect(again.env[0].value).toBe(first.env[0].value)
    expect(pairValues(again.env, unseal)).toEqual({ API_KEY: 'abc' })
  })

  it('replaces a saved secret with a new value', () => {
    const first = applyInput(stdio({ env: [{ key: 'API_KEY', value: 'abc', secret: true }] }), null, [], seal)
    const again = applyInput(stdio({ create: false, env: [{ key: 'API_KEY', value: 'xyz', secret: true }] }), first, ['files'], seal)
    expect(pairValues(again.env, unseal)).toEqual({ API_KEY: 'xyz' })
  })

  it('clear forgets the saved secret and keeps the key', () => {
    const first = applyInput(stdio({ env: [{ key: 'API_KEY', value: 'abc', secret: true }] }), null, [], seal)
    const again = applyInput(stdio({ create: false, env: [{ key: 'API_KEY', value: '', secret: true, clear: true }] }), first, ['files'], seal)
    expect(again.env).toEqual([{ key: 'API_KEY', value: '', secret: true }])
    expect(toView(again, 'brand-a', live, null).env).toEqual([{ key: 'API_KEY', secret: true, set: false }])
    expect(pairValues(again.env, unseal)).toEqual({})
  })

  it('a row left out is dropped', () => {
    const first = applyInput(stdio({ env: [{ key: 'API_KEY', value: 'abc', secret: true }] }), null, [], seal)
    const again = applyInput(stdio({ create: false, env: [] }), first, ['files'], seal)
    expect(again.env).toEqual([])
  })

  it('turning secret off with no value never copies the old value out', () => {
    const first = applyInput(stdio({ env: [{ key: 'API_KEY', value: 'abc', secret: true }] }), null, [], seal)
    const again = applyInput(stdio({ create: false, env: [{ key: 'API_KEY', value: '', secret: false }] }), first, ['files'], seal)
    expect(again.env).toEqual([{ key: 'API_KEY', value: '', secret: false }])
  })

  it('editing keeps brands and trust, the window can\'t set them through save', () => {
    const first = { ...applyInput(stdio(), null, [], seal), trusted: true, brands: { 'brand-a': true, 'brand-b': true } as Record<string, true> }
    const again = applyInput({ ...stdio({ create: false, brandId: 'brand-c' }), trusted: false, brands: {} }, first, ['files'], seal)
    expect(again.trusted).toBe(true)
    expect(again.brands).toEqual({ 'brand-a': true, 'brand-b': true })
  })
})

describe('the saved file', () => {
  it('drops bad servers and unsealed secrets', () => {
    const good = applyInput(stdio({ env: [{ key: 'API_KEY', value: 'abc', secret: true }] }), null, [], seal)
    const list = cleanServers({
      servers: [
        good,
        { ...good, id: 'Bad_Name' },
        { ...good, id: 'craft' },
        { ...good, id: 'other', env: [{ key: 'API_KEY', value: 'not sealed', secret: true }] },
        { ...good, id: 'web', kind: 'http', url: 'ftp://x' },
        good
      ]
    })
    expect(list.map((s) => s.id)).toEqual(['files', 'other'])
    expect(list[1].env).toEqual([])
    expect(cleanServer({ ...good, brands: { 'brand-a': true, 'bad id!': true, 'brand-b': 'yes' } })?.brands).toEqual({ 'brand-a': true })
  })
})

describe('tools', () => {
  it('names, risks and asks', () => {
    const defs = cleanToolDefs([
      { name: 'read_file', annotations: { readOnlyHint: true } },
      { name: 'write_file' },
      { name: 'delete_file', annotations: { destructiveHint: true } },
      { name: 'Read-File' },
      { name: '' },
      { nope: 1 }
    ])
    const entries = toolEntries('files', defs)
    expect(entries.map((t) => [t.name, t.risk, t.alwaysAsk])).toEqual([
      ['files_read_file', 'read', false],
      ['files_write_file', 'edit', false],
      ['files_delete_file', 'edit', true]
    ])
    const v = toView(applyInput(stdio(), null, [], seal), 'brand-a', live, { at: 1, defs })
    expect(v.tools.map((t) => t.tool)).toEqual(['read_file', 'write_file', 'delete_file'])
    expect(v.enabled).toBe(true)
    expect(toView(applyInput(stdio(), null, [], seal), 'brand-b', live, null).enabled).toBe(false)
  })
})
