// Service worker: THIN ROUTER ONLY.
//
// Phase 0 architecture decision (locked): the session state machine, the Rime
// WebSocket, the playback clock and turn_id all live in the OFFSCREEN document,
// not here. Two reasons:
//   1. MV3 service workers idle out (~30s). A form session runs for minutes.
//      An offscreen document with reason AUDIO_PLAYBACK stays alive while audio
//      is playing, which is exactly the window we care about.
//   2. The heard ledger compares Rime word timestamps against the local playback
//      position. Those two values must share a context with no chrome.runtime
//      hop between them - every hop is 5-20ms charged against the 300ms barge-in
//      budget, and it turns the ledger into a cross-context consistency problem.
//
// So this file creates the offscreen document, relays messages, and nothing else.

const OFFSCREEN_PATH = 'offscreen/offscreen.html';

async function hasOffscreen() {
  // Guard against "document already exists" - createDocument throws on a second call.
  if (chrome.runtime.getContexts) {
    const ctx = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
    });
    return ctx.length > 0;
  }
  return false;
}

let creating = null;
async function ensureOffscreen() {
  if (await hasOffscreen()) return 'existing';
  if (creating) { await creating; return 'existing'; }   // collapse concurrent callers
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Play Rime TTS audio independently of the page CSP, and keep the session alive during playback.',
  });
  try { await creating; return 'created'; }
  finally { creating = null; }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'VF_PING':
          sendResponse({ ok: true, from: 'background', ts: Date.now() });
          break;

        case 'VF_ENSURE_OFFSCREEN': {
          const how = await ensureOffscreen();
          sendResponse({ ok: true, offscreen: how });
          break;
        }

        case 'VF_PLAY_TEST': {
          // Phase 0 exit criterion: bundled test.mp3 plays from the offscreen
          // document while a strict-CSP page is in the foreground.
          await ensureOffscreen();
          const r = await chrome.runtime.sendMessage({ type: 'OFF_PLAY_TEST', target: 'offscreen' });
          sendResponse(r ?? { ok: false, error: 'no response from offscreen' });
          break;
        }

        case 'VF_OFFSCREEN_STATUS': {
          sendResponse({ ok: true, exists: await hasOffscreen() });
          break;
        }

        default:
          if (msg?.target === 'offscreen') return;  // not ours; let offscreen handle it
          sendResponse({ ok: false, error: `unknown message ${msg?.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;  // async response
});

console.log('[VoiceFill] background service worker loaded');
