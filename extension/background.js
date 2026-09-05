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
// So this file creates the offscreen document and relays. The only state it
// holds is the active tab id, which is routing information: the offscreen
// document has no chrome.tabs access and cannot reach a content script itself.

const OFFSCREEN_PATH = 'offscreen/offscreen.html';
let activeTabId = null;

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

const toOffscreen = async (m) => {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ ...m, target: 'offscreen' });
};

/**
 * The offscreen document cannot read chrome.storage - its API surface is
 * limited to chrome.runtime - so the backend address is resolved here and
 * passed down with the message that needs it.
 */
async function backendConfig() {
  const d = await chrome.storage.local.get(['backendUrl', 'proxyToken']);
  return {
    backendUrl: d.backendUrl || 'ws://localhost:8787/speak',
    proxyToken: d.proxyToken || '',
  };
}

/** Frame 0 only. A broadcast answers from whichever frame replies first, which
 *  on an iframe-heavy page is effectively random. */
const toContent = (tabId, m) => chrome.tabs.sendMessage(tabId, m, { frameId: 0 });

async function resolveTabId(explicit) {
  if (explicit) return explicit;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

/** Scan the page, then hand the field list to the offscreen session machine. */
async function startSession(tabId) {
  const scan = await toContent(tabId, { type: 'VF_SCAN' });
  if (!scan?.ok) return { ok: false, error: 'content script did not respond - reload the page' };
  activeTabId = tabId;
  const started = await toOffscreen({
    type: 'OFF_SESSION_START', fields: scan.fields, tabId, backend: await backendConfig(),
  });
  return { ...started, scanned: scan.fields.length, unlabelled: scan.unlabelled, url: scan.url };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Offscreen-addressed traffic is not ours; the offscreen listener takes it.
  if (msg?.target === 'offscreen') return;

  (async () => {
    try {
      switch (msg?.type) {
        case 'VF_PING':
          sendResponse({ ok: true, from: 'background', ts: Date.now() });
          break;

        case 'VF_ENSURE_OFFSCREEN':
          sendResponse({ ok: true, offscreen: await ensureOffscreen() });
          break;

        case 'VF_PLAY_TEST': {
          // Phase 0 exit criterion: bundled test.mp3 plays from the offscreen
          // document while a strict-CSP page is in the foreground.
          const r = await toOffscreen({ type: 'OFF_PLAY_TEST' });
          sendResponse(r ?? { ok: false, error: 'no response from offscreen' });
          break;
        }

        case 'VF_OFFSCREEN_STATUS':
          sendResponse({ ok: true, exists: await hasOffscreen() });
          break;

        case 'VF_SESSION_START':
          sendResponse(await startSession(await resolveTabId(msg.tabId)));
          break;

        // Pre-warm on popup open (Phase 0 constraint 3): cold TTFA is 1475ms
        // against 513ms warm, and 1.5s of dead air after Start reads as broken.
        case 'VF_CONNECT':
          sendResponse(await toOffscreen({ type: 'OFF_CONNECT', backend: await backendConfig(), warm: msg.warm !== false }));
          break;

        case 'VF_NEXT':    sendResponse(await toOffscreen({ type: 'OFF_NEXT' })); break;
        case 'VF_PREV':    sendResponse(await toOffscreen({ type: 'OFF_PREV' })); break;
        case 'VF_REPEAT':  sendResponse(await toOffscreen({ type: 'OFF_REPEAT' })); break;
        case 'VF_STATE':   sendResponse(await toOffscreen({ type: 'OFF_STATE' })); break;
        case 'VF_SPEAK':   sendResponse(await toOffscreen({ type: 'OFF_SPEAK', text: msg.text })); break;

        case 'VF_STOP': {
          const r = await toOffscreen({ type: 'OFF_STOP' });
          if (activeTabId) { try { await toContent(activeTabId, { type: 'VF_CLEAR_FOCUS' }); } catch {} }
          sendResponse(r);
          break;
        }

        // Offscreen -> page: move the focus ring. Offscreen has no tabs access.
        case 'VF_FOCUS_FIELD': {
          const tabId = msg.tabId ?? activeTabId;
          if (!tabId) { sendResponse({ ok: false, error: 'no active tab' }); break; }
          try { sendResponse(await toContent(tabId, { type: 'VF_FOCUS_FIELD', fieldId: msg.fieldId })); }
          catch (e) { sendResponse({ ok: false, error: String(e?.message || e) }); }
          break;
        }

        // Page -> offscreen: the DOM changed under an SPA remount.
        case 'VF_FIELDS_CHANGED': {
          if (sender?.tab?.id && sender.tab.id !== activeTabId) { sendResponse({ ok: false, ignored: 'inactive tab' }); break; }
          sendResponse(await toOffscreen({ type: 'OFF_UPDATE_FIELDS', fields: msg.fields }));
          break;
        }

        default:
          sendResponse({ ok: false, error: `unknown message ${msg?.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;  // async response
});

console.log('[VoiceFill] background service worker loaded');
