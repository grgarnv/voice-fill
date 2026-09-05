// Speech-to-text abstraction (PRD F2.2).
//
// Two providers behind one interface, chosen at runtime:
//
//   webspeech  Browser SpeechRecognition. Zero setup, the PRD's option A and
//              the default for the judged demo.
//   backend    Mic PCM -> POST /stt -> whisper.cpp. The PRD's option B: better
//              in noise, and the only provider an automated harness can drive
//              here, because Chrome's Web Speech API returns no transcript in
//              this environment (measured - see backend/stt.mjs).
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
   *
   * Chrome's SpeechRecognition stops itself after a silence and after ~60s, so
   * `onend` is the normal exit and not an error.
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

  /* ---------------------------------------------------------- backend ----- */

  let micStream = null, micCtx = null, micNode = null, workletReady = false;

  async function ensureMic(workletUrl) {
    if (micStream && micCtx && micNode) return true;
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Phase 0 flagged AEC as the top open risk. Enabling it here is what
        // makes an open mic survivable at all once Phase 3 lands; push-to-talk
        // does not depend on it.
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      },
    });
    micCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    if (!workletReady) { await micCtx.audioWorklet.addModule(workletUrl); workletReady = true; }
    const src = micCtx.createMediaStreamSource(micStream);
    micNode = new AudioWorkletNode(micCtx, 'vf-recorder');
    src.connect(micNode);
    // Not connected to destination: capture must never be echoed to the speaker.
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

  let recording = null;

  async function backendStart({ workletUrl }) {
    await ensureMic(workletUrl);
    if (micCtx.state === 'suspended') { try { await micCtx.resume(); } catch {} }
    const chunks = [];
    let total = 0;
    const onMsg = (e) => { chunks.push(e.data); total += e.data.length; };
    micNode.port.onmessage = onMsg;
    micNode.port.postMessage('start');
    recording = { chunks, get total() { return total; }, t0: Date.now() };
    return true;
  }

  async function backendStop({ backendUrl, proxyToken }) {
    if (!recording) return { ok: false, text: '', provider: 'backend', error: 'not recording' };
    micNode.port.postMessage('stop');
    const { chunks, t0 } = recording;
    let total = 0;
    for (const c of chunks) total += c.length;
    recording = null;
    if (total < SAMPLE_RATE * 0.15) {
      return { ok: false, text: '', provider: 'backend', ms: Date.now() - t0, error: 'too short - hold the key while speaking' };
    }
    const pcm = floatsToPcm16(chunks, total);
    // Peak level travels with the result: "no speech" from a mic that was
    // capturing dead silence is a permissions or routing problem, not an STT
    // one, and the two are indistinguishable without this number.
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 16) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; }
    const seconds = +(total / SAMPLE_RATE).toFixed(2);
    const url = new URL(backendUrl);
    if (proxyToken) url.searchParams.set('token', proxyToken);
    try {
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'x-vf-rate': String(SAMPLE_RATE) },
        body: pcm.buffer,
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

  function releaseMic() {
    try { micNode?.port.postMessage('stop'); } catch {}
    try { micStream?.getTracks().forEach(t => t.stop()); } catch {}
    micStream = null; micNode = null;
    try { micCtx?.close(); } catch {}
    micCtx = null; workletReady = false; recording = null;
  }

  return {
    SAMPLE_RATE,
    webSpeechAvailable, webSpeechTurn,
    backendStart, backendStop, releaseMic,
    isRecording: () => !!recording,
  };
})();
