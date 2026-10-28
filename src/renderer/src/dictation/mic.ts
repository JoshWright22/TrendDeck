import workletUrl from './capture-worklet.js?url'
import { VAD_SAMPLE_RATE } from '@shared/vad'

// the microphone as 16 kHz mono frames. the audio context runs at 16 kHz so chromium resamples
// for us; echo cancellation and noise suppression stay on so room tone sits under the vad

export interface Mic {
  close(): void
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
    const stop = await capture(ctx, source, onFrame)
    const context = ctx
    return {
      close: () => {
        stop()
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
