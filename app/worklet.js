// Chromium resamples all device streams to the AudioContext's 16 kHz clock.
class PCMRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Int16Array(8192);
    this.used = 0;
    this.active = true;
    this.port.onmessage = ({ data }) => {
      if (data === 'stop' && this.active) {
        this.active = false;
        this.flush();
        this.port.postMessage('stopped');
      }
    };
  }
  flush() {
    if (!this.used) return;
    const pcm = this.block.slice(0, this.used);
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    this.used = 0;
  }
  process(inputs) {
    if (!this.active) return false;
    const mono = inputs[0]?.[0];
    if (mono) for (const sample of mono) {
      this.block[this.used++] = Math.round(Math.max(-1, Math.min(1, sample)) * 32767);
      if (this.used === this.block.length) this.flush();
    }
    return true;
  }
}
registerProcessor('pcm-recorder', PCMRecorder);
