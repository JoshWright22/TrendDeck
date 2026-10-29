import workletUrl from './capture-worklet.js?url'
import { VAD_SAMPLE_RATE } from '@shared/vad'

// the microphone as 16 kHz mono frames. the audio context runs at 16 kHz so chromium resamples
// for us; echo cancellation and noise suppression stay on so room tone sits under the vad

export interface Mic {
  close(): void
  // the same mic at full quality with the call filters off, for the recording you keep. null when
  // the computer wouldn't open it a second time
  hifi: HiFi | null
}

export interface HiFi {
  rate: number
  // the stretch between these seconds since the mic opened, as the 16 kHz frames count them
  slice(start: number, end: number): Float32Array
}

// echo cancellation, noise suppression and auto gain are for calls: they make a voice sound
// metallic. the copy you keep goes without them, at the mic's own rate
const HIFI_CONSTRAINTS = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 48_000 }
// how much full quality audio is held, the oldest goes first. 15 minutes at 48 kHz in 16 bit is 86 MB
const HIFI_KEEP_S = 15 * 60

async function openHiFi(deviceId: string | undefined): Promise<(HiFi & { close(): void }) | null> {
  let stream: MediaStream | null = null
  let ctx: AudioContext | null = null
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { ...HIFI_CONSTRAINTS, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }, video: false })
    const rate = stream.getAudioTracks()[0]?.getSettings().sampleRate || 48_000
    ctx = new AudioContext({ sampleRate: rate })
    const source = ctx.createMediaStreamSource(stream)
    const chunks: Int16Array[] = []
    let dropped = 0
    let held = 0
    const node = ctx.createScriptProcessor(4096, 1, 1)
    const mute = ctx.createGain()
    mute.gain.value = 0
    node.onaudioprocess = (e) => {
      const f = e.inputBuffer.getChannelData(0)
      const c = new Int16Array(f.length)
      for (let i = 0; i < f.length; i++) c[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767)))
      chunks.push(c)
      held += c.length
      while (held > HIFI_KEEP_S * rate && chunks.length > 1) {
        const old = chunks.shift()!
        held -= old.length
        dropped += old.length
      }
    }
    source.connect(node)
    node.connect(mute)
    mute.connect(ctx.destination)
    const s = stream
    const c = ctx
    return {
      rate,
      slice: (start, end) => {
        const from = Math.max(0, Math.round(start * rate) - dropped)
        const to = Math.max(from, Math.round(end * rate) - dropped)
        const out = new Float32Array(to - from)
        let at = 0
        let pos = 0
        for (const ch of chunks) {
          const a = Math.max(from, pos)
          const b = Math.min(to, pos + ch.length)
          for (let i = a; i < b; i++) out[at++] = ch[i - pos] / 32767
          pos += ch.length
          if (pos >= to) break
        }
        return out.subarray(0, at)
      },
      close: () => {
        node.onaudioprocess = null
        try {
          source.disconnect()
          node.disconnect()
          mute.disconnect()
        } catch {
          // already gone
        }
        s.getTracks().forEach((t) => t.stop())
        void c.close().catch(() => {})
      }
    }
  } catch {
    stream?.getTracks().forEach((t) => t.stop())
    void ctx?.close().catch(() => {})
    return null
  }
}

// "Microphone (HyperX Cloud III S Wireless) (03f0:06be)" without the usb ids on the end
const plainName = (label: string): string => label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, '')

// the names of the microphones, sent to main too so the agent can pick one. windows lists a
// headset again as "Default - ..." and "Communications - ...", those are left out. names only
// show once the page may use the mic, before that the list is empty
export async function listMics(): Promise<string[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    const names = [...new Set(all.filter((d) => d.kind === 'audioinput' && d.label && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => plainName(d.label)))]
    window.trenddeckDictation?.reportMics?.(names)
    return names
  } catch {
    return []
  }
}

// the device for a saved mic name, matching on part of it too. none: the Windows default
async function micId(name: string): Promise<string | null> {
  if (!name) return null
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
  const hit = all.find((d) => plainName(d.label) === name) ?? all.find((d) => d.label && norm(d.label).includes(norm(name)))
  return hit?.deviceId ?? null
}

const CONSTRAINTS = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }

export async function openMic(onFrame: (frame: Float32Array) => void, name = ''): Promise<Mic> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This computer has no microphone TrendDeck can use.')
  let stream = await navigator.mediaDevices.getUserMedia({ audio: CONSTRAINTS, video: false })
  // mic names only show once the page may use the mic, so the chosen one is found after the first open
  const id = await micId(name).catch(() => null)
  if (id && stream.getAudioTracks()[0]?.getSettings().deviceId !== id) {
    try {
      const picked = await navigator.mediaDevices.getUserMedia({ audio: { ...CONSTRAINTS, deviceId: { exact: id } }, video: false })
      stream.getTracks().forEach((t) => t.stop())
      stream = picked
    } catch {
      // unplugged or busy, the default it is
    }
  }
  void listMics()
  let ctx: AudioContext | null = null
  try {
    ctx = new AudioContext({ sampleRate: VAD_SAMPLE_RATE })
    const source = ctx.createMediaStreamSource(stream)
    const hifi = await openHiFi(stream.getAudioTracks()[0]?.getSettings().deviceId)
    const stop = await capture(ctx, source, onFrame)
    const context = ctx
    return {
      hifi,
      close: () => {
        stop()
        hifi?.close()
        try {
          source.disconnect()
        } catch {
          // already gone
        }
        stream.getTracks().forEach((t) => t.stop())
        void context.close().catch(() => {})
      }
    }
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop())
    void ctx?.close().catch(() => {})
    throw err
  }
}

const FRAME = 2048

// the frames come from the audio worklet where chromium lets the page load one (the dev build over
// http). the packaged app's file:// page can't load a worklet module from any url, so there a
// script processor does the same job on the main thread: 2048 samples is 128 ms at 16 kHz
async function capture(ctx: AudioContext, source: MediaStreamAudioSourceNode, onFrame: (frame: Float32Array) => void): Promise<() => void> {
  try {
    await ctx.audioWorklet.addModule(workletUrl)
    const node = new AudioWorkletNode(ctx, 'td-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 })
    node.port.onmessage = (e: MessageEvent<Float32Array>) => onFrame(e.data)
    source.connect(node)
    return () => {
      node.port.onmessage = null
    }
  } catch {
    const node = ctx.createScriptProcessor(FRAME, 1, 1)
    // it only runs while connected to the output, a silent gain keeps the mic out of the speakers
    const mute = ctx.createGain()
    mute.gain.value = 0
    node.onaudioprocess = (e) => onFrame(new Float32Array(e.inputBuffer.getChannelData(0)))
    source.connect(node)
    node.connect(mute)
    mute.connect(ctx.destination)
    return () => {
      node.onaudioprocess = null
      node.disconnect()
      mute.disconnect()
    }
  }
}
