import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  recording: false, streaming: false, profile: 'User profile', directory: 'C:/Existing',
  profiles: ['User profile'], calls: [] as string[], failStart: false
}))

vi.mock('./preferences', () => ({
  assertBrand: vi.fn(),
  obsPreferences: async () => ({ endpoint: 'ws://127.0.0.1:4455/', hasPassword: true }),
  obsCredentials: async () => ({ endpoint: 'ws://127.0.0.1:4455/', password: 'private-password' }),
  saveObsPreferences: vi.fn()
}))
vi.mock('../craft/paths', () => ({ findProject: vi.fn(), projectFolder: async () => 'C:/Brand/Project' }))
vi.mock('../media/watch', () => ({ addWatch: vi.fn(async () => {}) }))
vi.mock('node:fs', () => ({ promises: { mkdir: vi.fn(async () => {}) } }))
vi.mock('./client', () => ({
  ObsClient: class {
    async connect(): Promise<void> {}
    disconnect(): void {}
    async request(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
      state.calls.push(name)
      switch (name) {
        case 'GetVersion': return { availableRequests: ['GetRecordStatus', 'GetStreamStatus', 'GetProfileList', 'GetSceneList', 'GetRecordDirectory', 'CreateProfile', 'SetCurrentProfile', 'SetRecordDirectory', 'StartRecord', 'StopRecord'] }
        case 'GetRecordStatus': return { outputActive: state.recording }
        case 'GetStreamStatus': return { outputActive: state.streaming }
        case 'GetProfileList': return { currentProfileName: state.profile, profiles: state.profiles }
        case 'GetSceneList': return { currentProgramSceneName: 'Scene', scenes: [{ sceneName: 'Scene' }] }
        case 'GetRecordDirectory': return { recordDirectory: state.directory }
        case 'CreateProfile': state.profile = String(args.profileName); state.profiles.push(state.profile); return {}
        case 'SetCurrentProfile': state.profile = String(args.profileName); return {}
        case 'SetRecordDirectory': state.directory = String(args.recordDirectory); return {}
        case 'StartRecord':
          state.recording = true
          if (state.failStart) throw new Error('outcome may be unknown')
          return {}
        case 'StopRecord': state.recording = false; return { outputPath: 'C:/Brand/Project/Recordings/clip.mkv' }
        default: throw new Error('Unexpected request')
      }
    }
  }
}))

beforeEach(() => {
  vi.resetModules()
  state.recording = false
  state.streaming = false
  state.profile = 'User profile'
  state.directory = 'C:/Existing'
  state.profiles = ['User profile']
  state.calls = []
  state.failStart = false
})

describe('OBS guarded operations', () => {
  it('inspects read-only and sets up the project profile and media watch', async () => {
    const service = await import('./service')
    const { addWatch } = await import('../media/watch')
    const status = await service.obsStatus('brand-a')
    expect(status).toMatchObject({ connected: true, profiles: ['User profile'], scenes: ['Scene'] })
    expect(state.calls.every((name) => name.startsWith('Get'))).toBe(true)
    await service.setupRecording('brand-a', 'project-a')
    expect(state.profile).toBe('TrendDeck-brand-a-project-a')
    expect(state.directory.replaceAll('\\', '/')).toBe('C:/Brand/Project/Recordings')
    expect(addWatch).toHaveBeenCalledWith('brand-a', state.directory, false)
    expect(JSON.stringify(status)).not.toContain('private-password')
  })

  it.each(['recording', 'streaming'] as const)('never configures when %s', async (field) => {
    const service = await import('./service')
    state[field] = true
    await expect(service.setupRecording('brand-a', 'project-a')).rejects.toThrow('recording or streaming')
    expect(state.calls.every((name) => name.startsWith('Get'))).toBe(true)
  })

  it('requires ownership and blocks another brand from stopping or reconfiguring a recording', async () => {
    const service = await import('./service')
    await expect(service.startRecording('brand-a', 'project-a')).rejects.toThrow('does not own OBS')
    await service.setupRecording('brand-a', 'project-a')
    await service.startRecording('brand-a', 'project-a')
    await expect(service.stopRecording('brand-b', 'project-a')).rejects.toThrow('does not own OBS')
    await expect(service.setupRecording('brand-b', 'project-a')).rejects.toThrow('recording or streaming')
    expect(state.calls).not.toContain('StopRecord')
    await expect(service.stopRecording('brand-a', 'project-a')).resolves.toMatchObject({ recording: false, outputPath: expect.any(String) })
  })

  it('guards changed profile and uncertain start outcomes', async () => {
    const service = await import('./service')
    await service.setupRecording('brand-a', 'project-a')
    state.profile = 'User profile'
    await expect(service.startRecording('brand-a', 'project-a')).rejects.toThrow('changed outside TrendDeck')
    state.profile = 'TrendDeck-brand-a-project-a'
    state.failStart = true
    await expect(service.startRecording('brand-a', 'project-a')).rejects.toThrow('unknown')
    await expect(service.startRecording('brand-a', 'project-a')).rejects.toThrow('uncertain')
    await service.stopRecording('brand-a', 'project-a')
    expect(state.recording).toBe(false)
  })

  it('always asks approval for writes and exposes no credential arguments', async () => {
    const { OBS_TOOLS } = await import('./tools')
    const tools = OBS_TOOLS.filter((tool) => tool.name !== 'obs_status')
    expect(tools).toHaveLength(3)
    for (const tool of tools) {
      expect(tool.risk).toBe('edit')
      expect(tool.alwaysAsk).toBe(true)
      expect(tool.mustAsk).toBeTypeOf('function')
      expect(tool.inputSchema.additionalProperties).toBe(false)
      expect(Object.keys(tool.inputSchema.properties || {})).toEqual(['projectId'])
    }
  })
})
