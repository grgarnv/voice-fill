// Mic capture worklet. Posts raw Float32 frames to the offscreen document,
// which converts to 16-bit PCM and ships it to /stt.
//
// An AudioWorklet rather than ScriptProcessorNode: capture runs on the audio
// thread, so it cannot be starved by the main thread, and the offscreen
// document is simultaneously scheduling Rime playback on that same main thread.
class VFRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.port.onmessage = (e) => {
      if (e.data === 'start') this.recording = true;
      else if (e.data === 'stop') this.recording = false;
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (this.recording && ch && ch.length) {
      // Copy: the buffer is reused by the audio thread on the next render quantum.
      this.port.postMessage(new Float32Array(ch));
    }
    return true;   // keep the node alive across silence
  }
}
registerProcessor('vf-recorder', VFRecorder);
