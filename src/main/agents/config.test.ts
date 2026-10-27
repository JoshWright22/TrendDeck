import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => state.directory },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' }
}))

beforeEach(async () => {
  vi.resetModules()
  state.directory = await fs.mkdtemp(join(tmpdir(), 'trenddeck-agent-config-test-'))
})
afterEach(async () => {
  await fs.rm(state.directory, { recursive: true, force: true })
})

const folder = join(tmpdir(), '.claude-two')

describe('agents.json', () => {
  it('reads an old file with only a default and custom agents', async () => {
    const { clean } = await import('./config')
    const old = {
      defaultAgentId: 'codex',
      custom: [{ id: 'custom-abc', name: 'DeepSeek', kind: 'api', command: '', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', key: '' }]
    }
    const s = clean(old)
    expect(s.defaultAgentId).toBe('codex')
    expect(s.custom.map((c) => c.id)).toEqual(['custom-abc'])
    expect(s.accounts).toEqual([])
    expect(s.rank).toEqual([])
    expect(s.autoOff).toEqual([])
  })

  it('keeps good accounts and drops broken ones', async () => {
    const { clean } = await import('./config')
    const s = clean({
      accounts: [
        { id: 'claude@two', name: 'Claude 2', folder },
        { id: 'claude@relative', name: 'x', folder: '.claude-x' },
        { id: 'cursor@two', name: 'x', folder },
        { id: 'claude', name: 'x', folder },
        null
      ],
      rank: ['claude@two', 'codex', 'codex', 7],
      autoOff: 'nope'
    })
    expect(s.accounts).toEqual([{ id: 'claude@two', name: 'Claude 2', folder }])
    expect(s.rank).toEqual(['claude@two', 'codex'])
    expect(s.autoOff).toEqual([])
  })

  it('starts empty with no file', async () => {
    const config = await import('./config')
    expect(await config.getConfig()).toEqual({ defaultAgentId: null, custom: [], accounts: [], rank: [], autoOff: [] })
  })

  it('setting the rank the first time makes auto the default, once', async () => {
    const config = await import('./config')
    await config.setDefault('codex')
    let cfg = await config.setRank(['codex', 'claude'], ['claude'])
    expect(cfg.defaultAgentId).toBe('auto')
    expect(cfg.rank).toEqual(['codex', 'claude'])
    expect(cfg.autoOff).toEqual(['claude'])
    await config.setDefault('claude')
    cfg = await config.setRank(['claude', 'codex'], [])
    expect(cfg.defaultAgentId).toBe('claude')
  })

  it('saves an account with its folder env, and removing it drops it from the rank', async () => {
    const config = await import('./config')
    await config.saveAccount({ id: 'claude@two', name: 'Claude 2', folder })
    expect(await config.accountEnv('claude@two')).toEqual({ CLAUDE_CONFIG_DIR: folder })
    expect(await config.accountEnv('claude')).toEqual({})
    await expect(config.saveAccount({ id: 'claude@three', name: 'Claude 3', folder })).rejects.toThrow(/already uses/)
    await config.setRank(['claude@two', 'codex'], ['claude@two'])
    const cfg = await config.removeAccount('claude@two')
    expect(cfg.accounts).toEqual([])
    expect(cfg.rank).toEqual(['codex'])
    expect(cfg.autoOff).toEqual([])
    const disk = JSON.parse(await fs.readFile(join(state.directory, 'agents.json'), 'utf8'))
    expect(disk.rank).toEqual(['codex'])
  })
})
