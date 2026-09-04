// Offscreen: audio playback + playback clock.
//
// Phase 0 scope is the bundled-mp3 smoke test. The AudioContext scaffolding is
// here already because the Phase 3 heard ledger needs a sample-accurate clock,
// and retrofitting that onto an <audio> element later means rewriting this file.

const el = document.getElementById('player');
let ctx = null;

/** Lazily created: an AudioContext made before a user gesture starts suspended. */
function audioContext() {
  if (!ctx) ctx = new AudioContext({ sampleRate: 24000 });
  return ctx;
}

/** Playback position in seconds. Phase 3 filters word timestamps against this. */
export function playedSeconds() {
  return el.currentTime;
}

async function playTest() {
  const url = chrome.runtime.getURL('assets/test.mp3');
  const c = audioContext();
  // Autoplay policy: a suspended context must be resumed inside the gesture chain.
  // The popup click that triggered this counts.
  if (c.state === 'suspended') await c.resume();

  el.src = url;
  const t0 = performance.now();

  // Three distinct moments, previously collapsed into one misleading number:
  //   startLatency - request to audible. This is what "how responsive is it"
  //                  means, and what the barge-in budget is measured against.
  //   playedMs     - audible to finished. Roughly the clip duration.
  // The old code computed both at the 'ended' event, so it reported the clip's
  // own length (~720ms) as if it were start latency.
  let startLatencyMs = null;

  // 'playing' fires at the first rendered frame; play() resolving only means
  // the request was accepted. Prefer 'playing', fall back to the promise.
  const playing = new Promise(res => el.addEventListener('playing', res, { once: true }));
  await el.play();
  const afterPlayCall = performance.now() - t0;
  await Promise.race([playing, new Promise(r => setTimeout(r, 2000))]);
  startLatencyMs = Math.round(performance.now() - t0);

  return new Promise((resolve) => {
    let settled = false;
    const done = (why) => {
      if (settled) return;
      settled = true;
      resolve({
        ok: true,
        startLatencyMs,                                   // request -> audible
        playCallMs: Math.round(afterPlayCall),            // request -> play() resolved
        playedMs: Math.round(performance.now() - t0 - startLatencyMs),
        durationSec: el.duration,
        audioContextState: c.state,
        endedCleanly: why === 'ended',
      });
    };
    el.addEventListener('ended', () => done('ended'), { once: true });
    // Bound by the clip's own length rather than a flat 6s, so a stuck player
    // is obvious instead of looking like a slow one.
    setTimeout(() => done('timeout'), Math.max(3000, (el.duration || 1) * 1000 + 2000));
  });
}

chrome.runtime.onMessage.addListener((msg, _s, respond) => {
  if (msg?.target !== 'offscreen') return;
  (async () => {
    try {
      if (msg.type === 'OFF_PLAY_TEST') respond(await playTest());
      else if (msg.type === 'OFF_CLOCK') respond({ ok: true, playedSeconds: playedSeconds() });
      else respond({ ok: false, error: `unknown offscreen message ${msg.type}` });
    } catch (e) {
      respond({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});

console.log('[VoiceFill] offscreen document loaded');
