import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  recording: false, streaming: false, profile: 'User profile', directory: 'C:/Existing', collection: 'Main',
  profiles: ['User profile', 'Talking head'], collections: ['Main', 'Studio'], format: '%CCYY-%MM-%DD %hh-%mm-%ss',
  calls: [] as string[], failStart: false, rejectStart: false, settings: {} as Record<string, unknown>,
  ingested: [] as unknown[], files: [] as string[]
}))

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('./preferences', () => ({
  assertBrand: vi.fn(),
  obsPreferences: async () => ({ endpoint: 'ws://127.0.0.1:4455/', hasPassword: true }),
  obsCredentials: async () => ({ endpoint: 'ws://127.0.0.1:4455/', password: '' }),
  recordingSettings: async () => ({ profile: '', sceneCollection: '', folder: 'footage', filename: '', autoImport: true, ...state.settings }),
  saveObsPreferences: vi.fn()
}))
vi.mock('../craft/paths', () => ({
  findProject: vi.fn(() => ({ brandName: 'Brand', project: { id: 'project-a', name: 'Project' } })),
  projectFolder: async () => 'C:/Brand/Project'
}))
vi.mock('../takes/ingest', () => ({ ingestRecording: vi.fn(async (input: unknown) => { state.ingested.push(input) }) }))
vi.mock('node:fs', () => ({
  promises: {
    mkdir: vi.fn(async () => {}),
    realpath: vi.fn(async (p: string) => p),
    readdir: vi.fn(async () => state.files),
    stat: vi.fn(async () => ({ isFile: () => true, size: 2048, mtimeMs: Date.now() }))
  }
}))
vi.mock('./client', async () => {
  const { ObsRequestError } = await import('./protocol')
  return {
    ObsClient: class {
      connected = true
      async connect(): Promise<void> {}
      disconnect(): void {}
      async request(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
        state.calls.push(name)
        switch (name) {
          case 'GetVersion': return { availableRequests: ['GetRecordStatus', 'GetStreamStatus', 'GetProfileList', 'GetSceneList', 'GetRecordDirectory', 'SetCurrentProfile', 'SetRecordDirectory', 'StartRecord', 'StopRecord', 'GetSceneCollectionList'] }
          case 'GetRecordStatus': return { outputActive: state.recording, outputDuration: 1000 }
          case 'GetStreamStatus': return { outputActive: state.streaming }
          case 'GetProfileList': return { currentProfileName: state.profile, profiles: state.profiles }
          case 'GetSceneCollectionList': return { currentSceneCollectionName: state.collection, sceneCollections: state.collections }
          case 'GetSceneList': return { currentProgramSceneName: 'Camera', scenes: [{ sceneName: 'Screen' }, { sceneName: 'Camera' }] }
          case 'GetInputList': return { inputs: [{ inputName: 'Mic', inputKind: 'wasapi_input_capture', inputKindCaps: 642 }, { inputName: 'Screen', inputKind: 'monitor_capture', inputKindCaps: 32905 }] }
          case 'GetInputMute': return { inputMuted: false }
          case 'GetRecordDirectory': return { recordDirectory: state.directory }
          case 'GetProfileParameter': return { parameterValue: state.format }
          case 'SetProfileParameter': state.format = String(args.parameterValue); return {}
          case 'SetCurrentProfile': state.profile = String(args.profileName); return {}
          case 'SetCurrentSceneCollection': state.collection = String(args.sceneCollectionName); return {}
          case 'SetRecordDirectory': state.directory = String(args.recordDirectory); return {}
          case 'SetCurrentProgramScene': return {}
          case 'GetSourceScreenshot': return { imageData: `data:image/png;base64,${Buffer.from('png').toString('base64')}` }
          case 'StartRecord':
            if (state.rejectStart) throw new ObsRequestError('OBS StartRecord failed (code 500)', 500)
            state.recording = true
            if (state.failStart) throw new Error('OBS StartRecord timed out; outcome may be unknown')
            return {}
          case 'StopRecord': state.recording = false; return { outputPath: 'C:/Brand/Project/footage/clip.mkv' }
          default: throw new Error(`Unexpected request ${name}`)
        }
      }
    }
  }
})

beforeEach(() => {
  vi.resetModules()
  Object.assign(state, {
    recording: false, streaming: false, profile: 'User profile', directory: 'C:/Existing', collection: 'Main',
    profiles: ['User profile', 'Talking head'], collections: ['Main', 'Studio'], format: '%CCYY-%MM-%DD %hh-%mm-%ss',
    calls: [], failStart: false, rejectStart: false, settings: {}, ingested: [], files: []
  })
})

const writes = (): string[] => state.calls.filter((name) => !name.startsWith('Get'))
const norm = (p: string): string => p.replaceAll('\\', '/')

describe('OBS guarded operations', () => {
  it('inspects read-only and never exposes the password', async () => {
    const service = await import('./service')
    const status = await service.obsStatus('brand-a')
    expect(status).toMatchObject({ connected: true, profiles: ['User profile', 'Talking head'], scenes: ['Camera', 'Screen'], sceneCollections: ['Main', 'Studio'] })
    expect(writes()).toEqual([])
    const scenes = await service.obsScenes('brand-a')
    expect(scenes.inputs).toEqual([{ name: 'Mic', kind: 'wasapi_input_capture', muted: false }, { name: 'Screen', kind: 'monitor_capture', muted: null }])
    expect(writes()).toEqual([])
  })

  it('records into the project footage folder, keeps the profile, then puts the folder back and imports the take', async () => {
    const service = await import('./service')
    await service.startRecording('brand-a', 'project-a', 'thread-1')
    expect(norm(state.directory)).toBe('C:/Brand/Project/footage')
    expect(state.profile).toBe('User profile')
    expect(state.calls).not.toContain('CreateProfile')
    expect(state.calls).not.toContain('SetCurrentProfile')
    expect(state.calls).not.toContain('SetProfileParameter')
    await expect(service.stopRecording('brand-a', 'project-a')).resolves.toMatchObject({ recording: false, outputPath: 'C:/Brand/Project/footage/clip.mkv' })
    expect(state.directory).toBe('C:/Existing')
    await vi.waitFor(() => expect(state.ingested).toHaveLength(1))
    expect(state.ingested[0]).toMatchObject({ brandId: 'brand-a', projectId: 'project-a', source: 'obs', threadId: 'thread-1' })
    expect(norm((state.ingested[0] as { path: string }).path)).toBe('C:/Brand/Project/footage/clip.mkv')
  })

  it('applies the brand profile, scene collection and file name, and restores the file name format', async () => {
    state.settings = { profile: 'Talking head', sceneCollection: 'Studio', filename: '{brand} {project} %hh-%mm', folder: 'footage\\obs' }
    const service = await import('./service')
    await service.startRecording('brand-a', 'project-a', null)
    expect(state.profile).toBe('Talking head')
    expect(state.collection).toBe('Studio')
    expect(state.format).toBe('Brand Project %hh-%mm')
    expect(norm(state.directory)).toBe('C:/Brand/Project/footage/obs')
    await service.stopRecording('brand-a', 'project-a')
    expect(state.format).toBe('%CCYY-%MM-%DD %hh-%mm-%ss')
    expect(state.directory).toBe('C:/Existing')
  })

  it('refuses a profile that does not exist instead of creating one', async () => {
    state.settings = { profile: 'Missing' }
    const service = await import('./service')
    await expect(service.startRecording('brand-a', 'project-a')).rejects.toThrow('no profile called "Missing"')
    expect(writes()).toEqual([])
  })

  it.each(['recording', 'streaming'] as const)('never configures or starts when OBS is already %s', async (field) => {
    const service = await import('./service')
    state[field] = true
    await expect(service.startRecording('brand-a', 'project-a')).rejects.toThrow(field === 'recording' ? 'outside TrendDeck' : 'streaming')
    await expect(service.setupRecording('brand-a', 'project-a')).rejects.toThrow()
    expect(writes()).toEqual([])
  })

  it('never stops an external recording or one owned by another brand', async () => {
    const service = await import('./service')
    state.recording = true
    await expect(service.stopRecording('brand-a', 'project-a')).rejects.toThrow('does not own OBS')
    state.recording = false
    await service.startRecording('brand-a', 'project-a')
    await expect(service.stopRecording('brand-b', 'project-a')).rejects.toThrow('does not own OBS')
    await expect(service.startRecording('brand-b', 'project-a')).rejects.toThrow('already recording')
    expect(state.calls).not.toContain('StopRecord')
    await service.stopRecording('brand-a', 'project-a')
  })

  it('keeps an uncertain lock when start times out and never retries it', async () => {
    const service = await import('./service')
    state.failStart = true
    await expect(service.startRecording('brand-a', 'project-a')).rejects.toThrow('unknown')
    await expect(service.startRecording('brand-a', 'project-a')).rejects.toThrow('uncertain')
    expect(state.calls.filter((n) => n === 'StartRecord')).toHaveLength(1)
    // the folder stays on the project while the outcome is unknown, the approved stop resolves it
    expect(norm(state.directory)).toBe('C:/Brand/Project/footage')
    await service.stopRecording('brand-a', 'project-a')
    expect(state.recording).toBe(false)
    expect(state.directory).toBe('C:/Existing')
  })

  it('puts the folder back once when OBS refuses to start', async () => {
    const service = await import('./service')
    state.rejectStart = true
    await expect(service.startRecording('brand-a', 'project-a')).rejects.toThrow("didn't start recording")
    expect(state.directory).toBe('C:/Existing')
    state.rejectStart = false
    await service.startRecording('brand-a', 'project-a')
    expect(state.calls.filter((n) => n === 'StartRecord')).toHaveLength(2)
  })

  it('does not import when auto-import is off', async () => {
    state.settings = { autoImport: false }
    const service = await import('./service')
    await service.startRecording('brand-a', 'project-a')
    await service.stopRecording('brand-a', 'project-a')
    await new Promise((ok) => setTimeout(ok, 10))
    expect(state.ingested).toEqual([])
  })

  it('switches scenes only to scenes that exist and takes pictures as png', async () => {
    const service = await import('./service')
    await expect(service.switchScene('brand-a', 'Nope')).rejects.toThrow('no scene')
    await service.switchScene('brand-a', 'Screen')
    expect(state.calls).toContain('SetCurrentProgramScene')
    const shot = await service.screenshot('brand-a', undefined, 960)
    expect(shot.source).toBe('Camera')
    expect(shot.png.toString()).toBe('png')
  })

  it('lists recent takes relative to the project folder', async () => {
    state.files = ['a.mkv', 'notes.txt', 'b.mp4']
    const service = await import('./service')
    const takes = await service.recentTakes('brand-a', 'project-a')
    expect(takes.map((t) => t.file).sort()).toEqual(['footage/a.mkv', 'footage/b.mp4'])
  })
})

describe('OBS agent tools', () => {
  it('asks every time for recording and streaming, and takes no credentials', async () => {
    vi.doMock('../cards/store', () => ({ addCard: vi.fn(), newCardId: () => 'card' }))
    vi.doMock('../store', () => ({ getData: () => null }))
    const { OBS_TOOLS } = await import('./tools')
    const names = OBS_TOOLS.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['obs_status', 'obs_scenes', 'obs_screenshot', 'obs_scene_switch', 'obs_input_mute', 'obs_takes', 'obs_show', 'obs_setup_recording', 'obs_start_recording', 'obs_stop_recording', 'obs_stream_start', 'obs_stream_stop']))
    for (const tool of OBS_TOOLS) {
      expect(tool.inputSchema.additionalProperties).toBe(false)
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/password|key|token/i)
      if (/recording/.test(tool.name)) {
        expect(tool.risk).toBe('edit')
        expect(tool.alwaysAsk).toBe(true)
        expect(tool.mustAsk).toBeTypeOf('function')
      }
      if (/stream/.test(tool.name)) {
        expect(tool.risk).toBe('publish')
        expect(tool.alwaysAsk).toBe(true)
        expect(tool.mustAsk).toBeTypeOf('function')
      }
    }
    expect(OBS_TOOLS.filter((t) => t.risk === 'read').map((t) => t.name).sort()).toEqual(['obs_scenes', 'obs_screenshot', 'obs_show', 'obs_status', 'obs_takes'])
  })
})
