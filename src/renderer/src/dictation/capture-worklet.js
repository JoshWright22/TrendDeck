// runs on the audio thread: collects the mic's 128-sample blocks into 2048-sample frames
// (128 ms at 16 kHz) and hands them to the page
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.frame = new Float32Array(2048)
    this.at = 0
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0]
    if (!input) return true
    for (let i = 0; i < input.length; i++) {
      this.frame[this.at++] = input[i]
      if (this.at === this.frame.length) {
        this.port.postMessage(this.frame, [this.frame.buffer])
        this.frame = new Float32Array(2048)
        this.at = 0
      }
    }
    return true
  }
}

registerProcessor('td-capture', CaptureProcessor)
