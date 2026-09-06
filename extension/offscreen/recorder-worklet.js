// Mic capture worklet, with the Phase 3 barge-in detector.
//
// An AudioWorklet rather than ScriptProcessorNode: capture runs on the audio
// thread, so it cannot be starved by the main thread, and the offscreen
// document is simultaneously scheduling Rime playback on that same main thread.
//
// Two modes, chosen by message:
//
//   'ptt'  (Phase 2)  'start' / 'stop' bracket a turn; every block is posted.
//   'vad'  (Phase 3)  the worklet decides. It keeps a pre-roll ring buffer,
//                     posts {type:'onset', frameTime, preroll} the moment speech
//                     is detected, streams blocks while speech lasts, and posts
//                     {type:'end', frameTime} after the hangover.
//
// The onset message is the barge-in trigger. `frameTime` is the audio-thread
// time of the FIRST block that crossed the threshold - the detection window
// itself (ONSET_BLOCKS) is therefore charged to the latency figure, not hidden.
//
// Energy detector (PRD F3.1, "energy for stop, interim for intent"):
//   RMS per 128-sample block (8 ms at 16 kHz). An adaptive noise floor follows
//   quiet input quickly and loud input slowly, so a steady hum or the residue
//   of imperfect echo cancellation raises the floor rather than firing. Speech
//   = RMS above max(floor x FLOOR_RATIO, ABS_MIN) for ONSET_BLOCKS consecutive
//   blocks; end = below THRESH_OFF_RATIO x threshold for HANG_BLOCKS blocks.
class VFRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mode = 'ptt';
    this.recording = false;          // ptt
    this.speaking = false;           // vad
    this.floor = 0.002;
    this.above = 0;
    this.below = 0;
    this.blocks = 0;
    this.PREROLL_BLOCKS = 63;        // ~500 ms at 128/16k: a soft lead-in ("no, one...") must not be cut
    this.ring = [];
    // HANG_BLOCKS 113 = ~0.9 s of quiet before a segment ends. 0.6 s split a
    // spoken number at a breath ("one" | "six zero zero seven one") in the
    // Phase 3 runs, so the first digit was filled alone and read back.
    this.params = { ABS_MIN: 0.012, FLOOR_RATIO: 4, ONSET_BLOCKS: 3, HANG_BLOCKS: 113, THRESH_OFF_RATIO: 0.6 };
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m === 'start') { this.recording = true; return; }
      if (m === 'stop') { this.recording = false; return; }
      if (m && typeof m === 'object') {
        if (m.type === 'mode') { this.mode = m.mode === 'vad' ? 'vad' : 'ptt'; this.speaking = false; this.above = 0; this.below = 0; }
        if (m.type === 'params') Object.assign(this.params, m.params || {});
        if (m.type === 'reset') { this.speaking = false; this.above = 0; this.below = 0; }
      }
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || !ch.length) return true;
    this.blocks++;

    if (this.mode === 'ptt') {
      // Copy: the buffer is reused by the audio thread on the next render quantum.
      if (this.recording) this.port.postMessage(new Float32Array(ch));
      return true;
    }

    // ---- vad mode -----------------------------------------------------------
    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    const rms = Math.sqrt(sum / ch.length);
    const P = this.params;

    // Adaptive floor: fast down, slow up. Never adapts to speech itself.
    if (!this.speaking) {
      if (rms < this.floor) this.floor += (rms - this.floor) * 0.05;
      else this.floor += (rms - this.floor) * 0.002;
      if (this.floor < 0.0005) this.floor = 0.0005;
    }
    const threshold = Math.max(this.floor * P.FLOOR_RATIO, P.ABS_MIN);

    const copy = new Float32Array(ch);
    if (!this.speaking) {
      this.ring.push(copy);
      if (this.ring.length > this.PREROLL_BLOCKS) this.ring.shift();
      if (rms > threshold) {
        this.above++;
        if (this.above >= P.ONSET_BLOCKS) {
          this.speaking = true; this.below = 0;
          // The first loud block was ONSET_BLOCKS-1 blocks ago.
          const frameTime = currentTime - ((P.ONSET_BLOCKS - 1) * ch.length) / sampleRate;
          const preroll = this.ring.slice();
          this.ring = [];
          this.port.postMessage({ type: 'onset', frameTime, rms, threshold, floor: this.floor, preroll });
          this.above = 0;
        }
      } else {
        this.above = 0;
      }
      // Periodic level report so the popup / harness can see the mic is alive.
      if (this.blocks % 25 === 0) this.port.postMessage({ type: 'level', rms, threshold, floor: this.floor });
      return true;
    }

    // speaking
    this.port.postMessage(copy);
    if (rms < threshold * P.THRESH_OFF_RATIO) {
      this.below++;
      if (this.below >= P.HANG_BLOCKS) {
        this.speaking = false; this.above = 0; this.below = 0;
        this.port.postMessage({ type: 'end', frameTime: currentTime, hangSec: (P.HANG_BLOCKS * ch.length) / sampleRate });
      }
    } else {
      this.below = 0;
    }
    return true;   // keep the node alive across silence
  }
}
registerProcessor('vf-recorder', VFRecorder);
