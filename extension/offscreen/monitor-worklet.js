// Output monitor. Every Rime buffer source is connected to the destination AND
// to this node, so it sees exactly what is being rendered to the speaker. It
// remembers the audio-thread time of the last non-silent block.
//
// This is how stop latency is MEASURED rather than asserted: after a barge-in
// the main thread asks for `lastLoud`, and the gap between the microphone onset
// and the last loud output block is the number in PHASE3_RESULTS.md. A source
// that kept playing after `stop()` would show up here as loud blocks after the
// stop call - the "stale audio played" counter.
class VFMonitor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.lastLoud = -1;          // context time of the START of the last loud block
    this.lastLoudEnd = -1;       // ...and its end
    this.loudBlocks = 0;
    this.blocks = 0;
    this.SILENCE = 1e-4;         // RMS; PCM dither from Rime never reaches this in silence
    // ponytail: debug capture, remove once the static report is closed.
    // Raw rendered samples, so a dump is what the speaker got, not a re-encode.
    this.rec = null;             // Float32Array[] while recording
    this.recFrames = 0;
    this.REC_MAX = 24000 * 20;   // 20s at 24k
    this.port.onmessage = (e) => {
      if (e.data === 'rec-start') { this.rec = []; this.recFrames = 0; return; }
      if (e.data === 'rec-dump') {
        const total = this.recFrames;
        const out = new Float32Array(total);
        let o = 0;
        for (const c of (this.rec || [])) { out.set(c, o); o += c.length; }
        this.port.postMessage({ type: 'rec', samples: out, frames: total }, [out.buffer]);
        this.rec = null; this.recFrames = 0;
        return;
      }
      if (e.data === 'query') {
        this.port.postMessage({ type: 'monitor', lastLoud: this.lastLoud, lastLoudEnd: this.lastLoudEnd,
                                loudBlocks: this.loudBlocks, blocks: this.blocks, now: currentTime });
      } else if (e.data === 'reset') {
        this.lastLoud = -1; this.lastLoudEnd = -1; this.loudBlocks = 0;
      }
    };
  }
  process(inputs) {
    this.blocks++;
    const ch = inputs[0] && inputs[0][0];
    if (this.rec && ch && ch.length && this.recFrames < this.REC_MAX) {
      this.rec.push(new Float32Array(ch)); this.recFrames += ch.length;
    }
    if (ch && ch.length) {
      let sum = 0;
      for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
      if (Math.sqrt(sum / ch.length) > this.SILENCE) {
        this.lastLoud = currentTime;
        this.lastLoudEnd = currentTime + ch.length / sampleRate;
        this.loudBlocks++;
      }
    }
    return true;
  }
}
registerProcessor('vf-monitor', VFMonitor);
