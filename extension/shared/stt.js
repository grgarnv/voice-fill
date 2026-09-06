// Speech-to-text abstraction (PRD F2.2), plus the Phase 3 open microphone.
//
// Two STT providers behind one interface, chosen at runtime:
//
//   webspeech  Browser SpeechRecognition. Zero setup, the PRD's option A and
//              the default for the judged demo.
//   backend    Mic PCM -> POST /stt -> whisper.cpp. The PRD's option B: better
//              in noise, and the only provider an automated harness can drive
//              here, because Chrome's Web Speech API returns no transcript in
//              this environment (measured - see backend/stt.mjs).
//
// Two microphone modes (PRD Phase 3 options):
//
//   ptt   Push-to-talk. backendStart/backendStop bracket a turn. The mic is
//         shut while Rime speaks, so echo never arises.
//   open  The worklet's energy detector decides when speech starts and ends.
//         onOnset fires the barge-in; onSegment delivers the captured PCM.
//         echoCancellation:true is set on the capture; the harness cannot
//         exercise real acoustic echo (its fake device does not hear the
//         speaker), so that remains documented, not measured.
//
// Both resolve to the same shape, so the session never branches on provider:
//   { ok, text, provider, ms, error, interim }
globalThis.VFStt = (() => {
  'use strict';

  const SAMPLE_RATE = 16000;      // whisper's native rate; no resample server-side

  /* ------------------------------------------------------- web speech ----- */

  function webSpeechAvailable() {
    return typeof (globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition) === 'function';
  }

  /**
   * One push-to-talk turn. Returns { promise, stop } - push-to-talk needs a
   * real handle to end the turn on key release, so the caller gets one rather
   * than waiting for Chrome's own silence timeout.
   */
  function webSpeechTurn({ maxMs = 15000, onInterim } = {}) {
    const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
    if (!SR) {
      return { promise: Promise.resolve({ ok: false, text: '', provider: 'webspeech', error: 'not supported' }), stop: () => {} };
    }
    const t0 = Date.now();
    const rec = new SR();
    rec.lang = 'en-US';
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    let finalText = '', interim = '', err = null, settled = false, resolveOuter;
    const promise = new Promise((r) => { resolveOuter = r; });

    const done = (why) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      try { rec.stop(); } catch {}
      const text = (finalText || interim).trim();
      resolveOuter({
        ok: !!text, text, provider: 'webspeech', ms: Date.now() - t0,
        error: text ? null : (err || why), interim: interim.trim(),
      });
    };

    rec.onresult = (e) => {
      finalText = ''; interim = '';
      for (const r of e.results) {
        if (r.isFinal) finalText += r[0].transcript + ' ';
        else interim += r[0].transcript + ' ';
      }
      if (onInterim && interim) { try { onInterim(interim.trim()); } catch {} }
    };
    rec.onerror = (e) => { err = e.error; };
    rec.onend = () => done('ended');

    const guard = setTimeout(() => done('timeout'), maxMs);
    try { rec.start(); } catch (e) { err = 'start: ' + e.message; done('start-failed'); }

    return { promise, stop: () => done('released') };
  }

  /* ---------------------------------------------------------- microphone --- */

  let micStream = null, micCtx = null, micNode = null, workletReady = false;
  let level = { rms: 0, threshold: 0, floor: 0, at: 0 };

  async function ensureMic(workletUrl) {
    if (micStream && micCtx && micNode) return true;
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Phase 0 flagged AEC as the top open risk. It is what makes an open
        // mic survivable at all; push-to-talk does not depend on it.
        echoCancellation: true,
        // AGC and noise suppression are OFF: the barge-in detector needs the
        // raw level. With AGC on, one interruption in 22 was detected ~1s late
        // (the gain was still ramping after the previous burst) and the
        // captured segment was only its tail. whisper does not need AGC.
        noiseSuppression: false, autoGainControl: false,
      },
    });
    micCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    if (!workletReady) { await micCtx.audioWorklet.addModule(workletUrl); workletReady = true; }
    const src = micCtx.createMediaStreamSource(micStream);
    micNode = new AudioWorkletNode(micCtx, 'vf-recorder');
    src.connect(micNode);
    // Not connected to destination: capture must never be echoed to the speaker.
    micNode.port.onmessage = routeWorkletMessage;
    return true;
  }

  function floatsToPcm16(chunks, total) {
    const out = new Int16Array(total);
    let o = 0;
    for (const c of chunks) {
      for (let i = 0; i < c.length; i++) {
        const s = Math.max(-1, Math.min(1, c[i]));
        out[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
    }
    return out;
  }

  /**
   * Convert a worklet frame time (mic AudioContext seconds) to performance.now()
   * milliseconds. currentTime read here is the time of the most recently
   * rendered block, so the mapping is exact to within one 8 ms quantum.
   */
  function micTimeToPerf(frameTime) {
    if (!micCtx) return performance.now();
    return performance.now() - (micCtx.currentTime - frameTime) * 1000;
  }

  /* --------------------------------------------------- ptt (Phase 2) ------ */

  let recording = null;      // { chunks, t0 }
  let openMic = null;        // { onOnset, onSegment, onEnd, seg }

  function routeWorkletMessage(e) {
    const d = e.data;
    if (d instanceof Float32Array) {
      if (recording) { recording.chunks.push(d); return; }
      if (openMic?.seg) { openMic.seg.chunks.push(d); return; }
      return;
    }
    if (!d || typeof d !== 'object') return;
    if (d.type === 'level') { level = { rms: d.rms, threshold: d.threshold, floor: d.floor, at: Date.now() }; return; }
    if (!openMic) return;
    if (d.type === 'onset') {
      const onsetPerf = micTimeToPerf(d.frameTime);
      const receivedPerf = performance.now();
      openMic.seg = { chunks: [...(d.preroll || [])], onsetPerf, receivedPerf, t0: Date.now(), rms: d.rms, threshold: d.threshold };
      try { openMic.onOnset({ onsetPerf, receivedPerf, rms: d.rms, threshold: d.threshold, floor: d.floor }); } catch {}
      return;
    }
    if (d.type === 'end') {
      const seg = openMic.seg;
      openMic.seg = null;
      if (!seg) return;
      const endPerf = micTimeToPerf(d.frameTime);
      let total = 0;
      for (const c of seg.chunks) total += c.length;
      // The hangover is silence; trim most of it so whisper is not fed 600 ms of nothing.
      const trim = Math.max(0, Math.floor(((d.hangSec || 0) - 0.15) * SAMPLE_RATE));
      const pcm = floatsToPcm16(seg.chunks, total).subarray(0, Math.max(0, total - trim));
      try { openMic.onSegment({ pcm, seconds: +(pcm.length / SAMPLE_RATE).toFixed(2), onsetPerf: seg.onsetPerf, endPerf, t0: seg.t0 }); } catch {}
    }
  }

  async function backendStart({ workletUrl }) {
    await ensureMic(workletUrl);
    if (micCtx.state === 'suspended') { try { await micCtx.resume(); } catch {} }
    if (!openMic) micNode.port.postMessage({ type: 'mode', mode: 'ptt' });
    recording = { chunks: [], t0: Date.now() };
    micNode.port.postMessage('start');
    return true;
  }

  /** Peak level travels with the result: "no speech" from a mic capturing dead
   *  silence is a permissions or routing problem, not an STT one. */
  function peakOf(pcm) {
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 16) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; }
    return peak;
  }

  async function postPcm(pcm, { backendUrl, proxyToken, t0 }) {
    const seconds = +(pcm.length / SAMPLE_RATE).toFixed(2);
    const peak = peakOf(pcm);
    const url = new URL(backendUrl);
    if (proxyToken) url.searchParams.set('token', proxyToken);
    try {
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'x-vf-rate': String(SAMPLE_RATE) },
        body: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
      });
      const j = await res.json().catch(() => ({}));
      return {
        ok: !!j.ok && !!j.text, text: String(j.text || ''), provider: 'backend',
        ms: Date.now() - t0, error: j.error || (res.ok ? null : `HTTP ${res.status}`),
        seconds, peak, silent: peak < 200,
      };
    } catch (e) {
      return { ok: false, text: '', provider: 'backend', ms: Date.now() - t0, error: String(e.message), seconds, peak };
    }
  }

  async function backendStop({ backendUrl, proxyToken }) {
    if (!recording) return { ok: false, text: '', provider: 'backend', error: 'not recording' };
    micNode.port.postMessage('stop');
    const { chunks, t0 } = recording;
    recording = null;
    let total = 0;
    for (const c of chunks) total += c.length;
    if (total < SAMPLE_RATE * 0.15) {
      return { ok: false, text: '', provider: 'backend', ms: Date.now() - t0, error: 'too short - hold the key while speaking' };
    }
    return postPcm(floatsToPcm16(chunks, total), { backendUrl, proxyToken, t0 });
  }

  /* ------------------------------------------------- open mic (Phase 3) --- */

  /**
   * Start the energy detector. onOnset fires on the audio thread's verdict
   * (converted to performance time); onSegment delivers the PCM of one speech
   * segment once it ends. The caller decides what to do with either.
   */
  async function openMicStart({ workletUrl, onOnset, onSegment, params }) {
    await ensureMic(workletUrl);
    if (micCtx.state === 'suspended') { try { await micCtx.resume(); } catch {} }
    openMic = { onOnset, onSegment, seg: null };
    if (params) micNode.port.postMessage({ type: 'params', params });
    micNode.port.postMessage({ type: 'mode', mode: 'vad' });
    return true;
  }

  /** Retune the energy detector mid-session (used to duck the mic under our own playback). */
  function setVadParams(params) {
    if (!micNode || !params) return false;
    micNode.port.postMessage({ type: 'params', params });
    return true;
  }

  /** Returns whether a speech segment was cut off by the switch, so the caller can abandon its capture. */
  function openMicStop() {
    if (!openMic) return { stopped: false, segmentInProgress: false };
    const segmentInProgress = !!openMic.seg;
    openMic = null;
    try { micNode?.port.postMessage({ type: 'mode', mode: 'ptt' }); } catch {}
    return { stopped: true, segmentInProgress };
  }

  /** Transcribe one open-mic segment. */
  function transcribeSegment(seg, { backendUrl, proxyToken }) {
    if (seg.pcm.length < SAMPLE_RATE * 0.25) {
      return Promise.resolve({ ok: false, text: '', provider: 'backend', ms: 0, error: 'too short', seconds: seg.seconds, peak: peakOf(seg.pcm) });
    }
    return postPcm(seg.pcm, { backendUrl, proxyToken, t0: seg.t0 });
  }

  function releaseMic() {
    try { micNode?.port.postMessage('stop'); } catch {}
    try { micStream?.getTracks().forEach(t => t.stop()); } catch {}
    micStream = null; micNode = null; openMic = null;
    try { micCtx?.close(); } catch {}
    micCtx = null; workletReady = false; recording = null;
  }

  return {
    SAMPLE_RATE,
    webSpeechAvailable, webSpeechTurn,
    backendStart, backendStop, releaseMic,
    openMicStart, openMicStop, transcribeSegment, setVadParams,
    isRecording: () => !!recording,
    isOpenMic: () => !!openMic,
    micLevel: () => level,
    micTimeToPerf,
  };
})();
