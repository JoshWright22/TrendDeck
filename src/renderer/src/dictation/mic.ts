import workletUrl from './capture-worklet.js?url'
import { VAD_SAMPLE_RATE } from '@shared/vad'

// the microphone as 16 kHz mono frames. the audio context runs at 16 kHz so chromium resamples
// for us; echo cancellation and noise suppression stay on so room tone sits under the vad

export interface Mic {
  close(): void
}

export async function openMic(onFrame: (frame: Float32Array) => void): Promise<Mic> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This computer has no microphone TrendDeck can use.')
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false
  })
  let ctx: AudioContext | null = null
  try {
    ctx = new AudioContext({ sampleRate: VAD_SAMPLE_RATE })
    await ctx.audioWorklet.addModule(workletUrl)
    const source = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'td-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 })
    node.port.onmessage = (e: MessageEvent<Float32Array>) => onFrame(e.data)
    source.connect(node)
    const context = ctx
    return {
      close: () => {
        node.port.onmessage = null
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
