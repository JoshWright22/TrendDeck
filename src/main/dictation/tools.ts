import { app } from 'electron'
import { LOCAL_MODELS, prefsFor, sourceParts, type LocalModelInfo } from '../../shared/dictation'
import { ToolError, type GatewayTool } from '../gateway/types'
import { obj, str } from '../gateway/validate'
import { applyMic, applySource, knownMics, loadStored, publicConfig, sendModelProgress } from './index'
import { customModels, downloadModel, findModel, installedDtypes, modelsState } from './models'
import { gpuFacts, gpuKind, mainGpu, pickDictationModel, type GpuFacts } from './pick'
import { allProviders, findProvider } from './sources'

// dictation for the agent: what this computer's GPU can do and which models are here (read), and
// setting up a local model (edit, so the user approves it). only local models are ever set up, a
// cloud API needs a key the user adds in Settings. no key, path or device id goes back

// how long dictation_setup waits for a download before saying it's still going
export const SETUP_WAIT_MS = 45_000

const size = (bytes: number): string => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`)

async function readGpu(): Promise<GpuFacts> {
  let basic: unknown = null
  let features: unknown = null
  try {
    basic = await Promise.race([app.getGPUInfo('basic'), new Promise((resolve) => setTimeout(() => resolve(null), 5_000))])
  } catch {
    basic = null
  }
  try {
    features = app.getGPUFeatureStatus()
  } catch {
    features = null
  }
  let accel = true
  try {
    accel = app.isHardwareAccelerationEnabled()
  } catch {
    accel = true
  }
  return gpuFacts(basic, features, accel)
}

function allModels(): LocalModelInfo[] {
  return [...LOCAL_MODELS, ...customModels()]
}

function sourceLabel(source: string, config: ReturnType<typeof publicConfig>): string {
  const parts = sourceParts(source)
  if (parts?.kind === 'local') return findModel(parts.id)?.label ?? parts.id
  const p = parts ? config.providers.find((x) => x.id === parts.id) : undefined
  return p ? `${p.label}${p.kind === 'api' ? ' (cloud)' : ' (server on this computer)'}` : 'none'
}

export async function dictationStatus(): Promise<unknown> {
  const facts = await readGpu()
  const stored = loadStored()
  const config = publicConfig(stored)
  const state = await modelsState()
  const gpu = mainGpu(facts)
  const pick = pickDictationModel(facts)
  const parts = sourceParts(config.source)
  return {
    gpu: {
      inUse: gpu ? `${gpu.name} (${gpu.vendor})` : 'unknown',
      kind: gpuKind(gpu),
      driver: gpu?.driver || 'unknown',
      others: facts.gpus.filter((g) => g !== gpu).map((g) => `${g.name} (${g.vendor})`),
      webgpu: facts.webgpu === null ? 'unknown' : facts.webgpu ? 'available' : 'not available',
      hardwareAcceleration: facts.hardwareAcceleration ? 'on' : 'off'
    },
    activeSource: { kind: parts?.kind === 'provider' ? 'provider' : 'local model', name: sourceLabel(config.source, config) },
    localModels: allModels().map((m) => {
      const s = state.models.find((x) => x.id === m.id)
      const dtype = prefsFor(m, stored.options.localPrefs).dtype
      const going = s?.downloading[0]
      return {
        id: m.id,
        name: m.label,
        downloaded: s?.installed.length ? 'yes' : going ? `downloading, ${going.total ? Math.floor((going.received / going.total) * 100) : 0}%` : 'no',
        active: config.source === `local:${m.id}` ? 'yes' : 'no',
        downloadSize: size(m.variants[dtype]?.bytes ?? 0),
        languages: m.englishOnly ? 'English only' : 'many',
        speed: m.speed,
        note: m.note
      }
    }),
    providers: allProviders().map((p) => {
      const saved = config.providers.filter((c) => c.providerId === p.id)
      const ready = saved.some((c) => p.fields.every((f) => !f.required || (f.secret ? c.hasSecret[f.key] : !!c.values[f.key])))
      return { name: p.label, kind: p.kind === 'api' ? 'cloud API' : 'server on this computer', configured: ready ? 'yes' : 'no' }
    }),
    microphone: { inUse: stored.options.mic || 'the Windows default', onThisComputer: knownMics() },
    recommended: { model: pick.id, why: pick.reason },
    note: 'dictation_setup sets up local models only. Cloud APIs need a key the user adds in Settings, Dictation.'
  }
}

// the model to set up: the one asked for (checked against the known list) or the best for the GPU
function chosenModel(raw: unknown, facts: GpuFacts): { info: LocalModelInfo; why: string } {
  if (typeof raw === 'string' && raw.trim()) {
    const id = raw.trim().replace(/^local:/, '')
    if (/^provider:/.test(id) || findProvider(id)) {
      throw new ToolError('dictation_setup only sets up local models. A cloud API or local server needs the user to add it in Settings, Dictation.')
    }
    const info = findModel(id)
    if (!info) throw new ToolError(`no local model called ${id}. models: ${allModels().map((m) => m.id).join(', ')}`)
    return { info, why: '' }
  }
  const pick = pickDictationModel(facts)
  return { info: findModel(pick.id)!, why: pick.reason }
}

export async function setupDictationModel(args: Record<string, unknown>, waitMs = SETUP_WAIT_MS): Promise<string> {
  const facts = await readGpu()
  const { info, why } = chosenModel(args.model, facts)
  const target = `local:${info.id}`
  const tail = why ? ` ${why}` : ''
  const stored = loadStored()
  if (installedDtypes(info.id).length) {
    const already = stored.options.source === target
    try {
      applySource(target)
    } catch (err) {
      throw new ToolError((err as Error).message)
    }
    return already ? `${info.label} is already downloaded and is the dictation source.${tail}` : `${info.label} was already downloaded and is now the dictation source.${tail}`
  }
  const dtype = prefsFor(info, stored.options.localPrefs).dtype
  const before = stored.options.source
  const download = downloadModel(info.id, dtype, sendModelProgress).then(() => {
    // once it lands it becomes the source, unless the user picked another one meanwhile
    if (loadStored().options.source === before) applySource(target)
    return 'done' as const
  })
  // a download that fails after this returns is shown in Settings, not thrown here
  download.catch(() => {})
  let timer: NodeJS.Timeout | undefined
  const waited = new Promise<'waiting'>((resolve) => { timer = setTimeout(() => resolve('waiting'), waitMs) })
  let outcome: 'done' | 'waiting'
  try {
    outcome = await Promise.race([download, waited])
  } catch (err) {
    throw new ToolError(`${info.label} could not be downloaded: ${(err as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
  const bytes = info.variants[dtype]?.bytes ?? 0
  if (outcome === 'done') return `Downloaded ${info.label} (${size(bytes)}) and made it the dictation source.${tail}`
  const going = (await modelsState()).models.find((m) => m.id === info.id)?.downloading.find((d) => d.dtype === dtype)
  const progress = going && going.total ? `, ${size(going.received)} of ${size(going.total)} so far` : ''
  return `${info.label} (${size(bytes)}) is still downloading${progress}. It becomes the dictation source by itself when it finishes. Check with dictation_status.${tail}`
}

// picks the mic by a name or part of one, e.g. "Cloud II" for "HyperX Cloud II Wireless"
export function setDictationMic(args: Record<string, unknown>): string {
  const want = typeof args.name === 'string' ? args.name.trim() : ''
  const mics = knownMics()
  if (!want || /^(default|windows default)$/i.test(want)) {
    applyMic('')
    return 'Dictation uses the Windows default microphone now.'
  }
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const hits = mics.filter((m) => norm(m).includes(norm(want)))
  if (!mics.length) throw new ToolError("TrendDeck hasn't seen the microphones yet. Ask the user to turn Dictate on once, then try again.")
  if (!hits.length) throw new ToolError(`no microphone matches "${want}". this computer has: ${mics.join('; ')}`)
  // a headset often shows up twice (the default and communications entries), the shortest is the plain one
  const exact = hits.find((m) => norm(m) === norm(want)) ?? [...hits].sort((a, b) => a.length - b.length)[0]
  applyMic(exact)
  return `Dictation uses ${exact} now. It switches the next time Dictate starts listening, and if Dictate is on it switches right away.`
}

export const DICTATION_TOOLS: GatewayTool[] = [
  {
    name: 'dictation_status', title: 'Check dictation setup', risk: 'read',
    description: 'The graphics card dictation would run on (name, vendor, driver, whether WebGPU and hardware acceleration are available), the active dictation source, every local speech model with whether it is downloaded and its download size, which cloud APIs or local servers are configured (yes or no only), and the recommended local model for this GPU.',
    inputSchema: obj(),
    run: () => dictationStatus()
  },
  {
    name: 'dictation_mic', title: 'Switch the dictation microphone', risk: 'read',
    annotations: { readOnlyHint: false, idempotentHint: true },
    description: 'Switches the microphone dictation listens to. name is the name of the mic or part of it, from dictation_status (microphone.onThisComputer), e.g. "Cloud II". "default" goes back to the Windows default. Use it when the user asks for another mic or the transcripts sound like the wrong one.',
    inputSchema: obj({ name: str('the microphone name or part of it, or "default"', 200, 1) }),
    run: async (_turn, args) => setDictationMic(args)
  },
  {
    name: 'dictation_setup', title: 'Set up dictation', risk: 'edit',
    description: 'Downloads a local speech model (if it is not downloaded yet) and makes it the dictation source. Leave model out to pick the best model for this GPU: Whisper Large v3 Turbo on a dedicated GPU with WebGPU, Whisper Small on built-in graphics, Whisper Base on the CPU. Local models only, never a cloud API. Waits up to 45 seconds for the download and says if it is still going.',
    inputSchema: obj({ model: str('a local model id from dictation_status, e.g. whisper-small. leave it out for the best one for this GPU', 120, 1) }),
    summarize: async (_turn, args) => {
      try {
        const raw = typeof args.model === 'string' ? args.model.trim().replace(/^local:/, '') : ''
        const info = raw ? findModel(raw) : findModel(pickDictationModel(await readGpu()).id)
        if (!info) return 'Set up dictation'
        const dtype = prefsFor(info, loadStored().options.localPrefs).dtype
        const have = installedDtypes(info.id).length > 0
        return have ? `Use ${info.label} for dictation` : `Download ${info.label} (${size(info.variants[dtype]?.bytes ?? 0)}) and use it for dictation`
      } catch {
        return 'Set up dictation'
      }
    },
    run: (_turn, args) => setupDictationModel(args)
  }
]
