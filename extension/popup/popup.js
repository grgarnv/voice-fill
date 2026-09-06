// Popup: provider disclosure (F1.5) + Next/Previous/Repeat (F1.6) + the Phase 0
// diagnostics, kept because they are how you tell a broken load from a broken
// backend in one glance.
const set = (k, state, text) => {
  const d = document.getElementById(`d-${k}`), v = document.getElementById(`v-${k}`);
  if (d) d.className = `dot ${state}`;
  if (v) v.textContent = text;
};
const $ = (id) => document.getElementById(id);

async function send(msg) {
  try { return await chrome.runtime.sendMessage(msg); }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
}

/* ---------------------------------------------------- provider disclosure -- */

function paintProvider(p) {
  if (!p) return;
  if (p.speaker) $('speaker').textContent = p.speaker;
  if (p.model) $('model').textContent = p.model;
  if (p.audioFormat) $('fmt').textContent = p.audioFormat + (p.samplingRate ? ` ${Math.round(p.samplingRate / 1000)}kHz` : '');
  if (p.endpoint) { try { $('endpoint').textContent = new URL(p.endpoint).host + new URL(p.endpoint).pathname; } catch {} }
  if (p.segment) $('seg').textContent = `segment=${p.segment}`;
}

/* --------------------------------------------------------- session view ---- */

function paintSession(s) {
  const running = !!(s?.ok && s.total > 0 && s.index >= 0);
  $('prev').disabled = !running;
  $('next').disabled = !running;
  $('repeat').disabled = !running;
  $('stop').disabled = !running;
  $('ptt').disabled = !running;
  $('start').textContent = running ? 'Restart' : 'Start';

  if (!running) {
    $('pos').textContent = 'no session';
    $('lab').textContent = 'Press Start to read this form';
    $('meta').textContent = s?.lastError ? s.lastError.slice(0, 60) : '';
    return;
  }
  $('pos').textContent = s.pending
    ? `Confirming field ${s.index + 1} of ${s.total}`
    : `Field ${s.index + 1} of ${s.total}`;
  $('lab').textContent = s.pending
    ? `Is "${s.pending.display}" correct?`
    : (s.field?.label || '(unlabelled field)');
  if (s.lastTranscript && !pttHeld) $('heard').textContent = `heard: ${s.lastTranscript}`;
  const bits = [s.field?.type];
  if (s.field?.required) bits.push('required');
  if (s.field?.optionCount) bits.push(`${s.field.optionCount} options`);
  if (s.field?.labelSource) bits.push(`via ${s.field.labelSource}`);
  $('meta').textContent = bits.filter(Boolean).join(' · ');
  paintLedger(s);
}

/* ------------------------------------------------ Phase 3: heard ledger ---- */
//
// The PRD's demo beat: interrupt the PIN prompt mid-word and SHOW that the
// system knows exactly which words were audible. The last interrupted
// utterance is displayed as Rime's words up to the cut, then "[interrupted]".

function paintLedger(s) {
  const last = [...(s.ledger || [])].reverse().find(e => e.status === 'interrupted');
  $('ledger').textContent = last ? `heard: "${last.display}"` : '';
  const m = s.metrics || {};
  const bits = [];
  if (m.bargeIns) bits.push(`${m.bargeIns} interruption${m.bargeIns === 1 ? '' : 's'}`);
  if (m.stopLatencyP50 != null) bits.push(`stop p50 ${Math.round(m.stopLatencyP50)}ms`);
  if (m.stopLatencyP95 != null) bits.push(`p95 ${Math.round(m.stopLatencyP95)}ms`);
  if (m.reasks) bits.push(`RE-ASKS ${m.reasks}`);
  if (m.staleAudioEvents) bits.push(`STALE AUDIO ${m.staleAudioEvents}`);
  // Echo rejections are normal on speakers and pathological in headphones; either
  // way the count is the difference between "working" and "hearing itself".
  if (m.echoRejected) bits.push(`ECHO ${m.echoRejected}${m.echoGaveUp ? ` (${m.echoGaveUp} dropped)` : ''}`);
  // A failing STT backend and a dead microphone both produce "I didn't catch
  // that" and nothing else. Show which one it is: the error if the backend
  // answered, otherwise the mic level the worklet is actually seeing.
  if (s.lastSttError) bits.push(`STT: ${String(s.lastSttError).split('\n')[0].slice(0, 40)}`);
  else if (s.micLevel?.at && s.micLevel.rms < 0.001) bits.push('MIC SILENT');
  $('bargein').textContent = bits.join(' · ');
  $('mic-ptt').classList.toggle('primary', s.micMode !== 'open');
  $('mic-open').classList.toggle('primary', s.micMode === 'open');
  $('ptt').hidden = s.micMode === 'open';
  const ill = s.machine?.illegalCount || 0;
  set('machine', ill ? 'bad' : 'ok', `${(s.state || 'idle').toLowerCase()}${ill ? ` · ${ill} illegal` : ''}`);
}

async function refreshState() {
  const s = await send({ type: 'VF_STATE' });
  if (s?.ok) {
    paintProvider(s.provider);
    paintSession(s);
    const wsOk = s.connected;
    set('ws', wsOk ? 'ok' : (s.lastError ? 'bad' : 'wait'),
        wsOk ? `${s.state.toLowerCase()} · turn ${s.turnId}` : (s.lastError || 'not connected').slice(0, 26));
    // Required failure disclosure: when Rime is unreachable mid-session the
    // badge turns red and says so, rather than the popup looking normal.
    const badge = document.querySelector('.badge');
    if (badge) badge.style.borderColor = (!wsOk && s.total > 0) ? 'var(--bad)' : '';
    if (badge) badge.title = (!wsOk && s.total > 0) ? 'Rime connection lost - reconnecting; text-only until it returns' : '';
  } else {
    paintSession(null);
  }
  return s;
}

async function refreshDiagnostics() {
  const bg = await send({ type: 'VF_PING' });
  set('bg', bg?.ok ? 'ok' : 'bad', bg?.ok ? 'alive' : 'no response');

  const off = await send({ type: 'VF_OFFSCREEN_STATUS' });
  set('off', off?.ok && off.exists ? 'ok' : 'wait', off?.exists ? 'running' : 'not created');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    try {
      // Address frame 0 explicitly. Without frameId, sendMessage broadcasts to
      // every frame and reports whichever replied first - on an iframe-heavy
      // page that is effectively random, and it said "iframe" on pages whose
      // top frame was injected perfectly well.
      const c = await chrome.tabs.sendMessage(tab.id, { type: 'VF_CONTENT_PING' }, { frameId: 0 });
      set('content', c?.ok ? 'ok' : 'bad', c?.ok ? `${c.frame} · ${c.fieldCount} fields` : 'not injected');
      // A page can enforce CSP via response header, which a content script
      // cannot read - so trust the active probe, not the meta tag.
      set('csp', c?.csp?.enforced ? 'ok' : 'wait', c?.csp?.label ?? 'unknown');
    } catch {
      set('content', 'bad', 'not injected');
      set('csp', 'wait', 'unknown');
    }
  }
}

/* ------------------------------------------------------------- controls ---- */
//
// Every one of these rides the popup click, which is the user gesture that
// satisfies Chrome's autoplay policy. AudioContext.resume() downstream is only
// legal because it stays on this call stack.

$('start').addEventListener('click', async () => {
  $('start').disabled = true;
  $('pos').textContent = 'scanning…';
  const r = await send({ type: 'VF_SESSION_START' });
  $('start').disabled = false;
  if (!r?.ok) { $('lab').textContent = (r?.error || 'failed').slice(0, 80); return; }
  if (r.fieldCount === 0) { $('pos').textContent = 'no fields'; $('lab').textContent = 'No fillable fields found on this page'; return; }
  await refreshState();
});

/* ------------------------------------------------------- push-to-talk ---- */
//
// Press and hold. The mic opens on pointerdown and closes on pointerup, so it
// is shut whenever Rime is speaking - the echo problem Phase 0 flagged as the
// top open risk simply does not arise in this mode.
//
// pointerup is bound on the WINDOW, not the button: releasing the mouse
// outside the button must still end the turn, or the mic stays open.
let pttHeld = false;

async function pttDown(e) {
  e?.preventDefault();
  if (pttHeld || $('ptt').disabled) return;
  pttHeld = true;
  $('ptt').classList.add('live');
  $('ptt').textContent = 'Listening — release to send';
  $('heard').textContent = '';
  const r = await send({ type: 'VF_LISTEN_START' });
  // If the mic never opened there is no turn to stop. Say why, instead of
  // letting release report the meaningless "not listening".
  if (r && !r.ok && !r.already) {
    pttHeld = false;
    $('ptt').classList.remove('live');
    $('ptt').textContent = 'Hold to speak';
    $('heard').textContent = `mic: ${String(r.error || 'failed').slice(0, 56)}`;
    if (/permission|notallowed|denied|dismissed/i.test(r.error || '')) $('mic-row').hidden = false;
  }
}

async function pttUp() {
  if (!pttHeld) return;
  pttHeld = false;
  $('ptt').classList.remove('live');
  $('ptt').textContent = 'Transcribing…';
  const r = await send({ type: 'VF_LISTEN_STOP' });
  $('ptt').textContent = 'Hold to speak';
  if (r?.transcript) $('heard').textContent = `heard: ${r.transcript}`;
  else if (r?.error) $('heard').textContent = r.error.slice(0, 60);
  await refreshState();
}

$('ptt').addEventListener('pointerdown', pttDown);
window.addEventListener('pointerup', pttUp);
// Holding the spacebar is easier than aiming at a button when you cannot see it.
window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.repeat) pttDown(e); });
window.addEventListener('keyup', (e) => { if (e.code === 'Space') pttUp(); });

$('mic-ptt').addEventListener('click',  async () => { await send({ type: 'VF_SET_MIC_MODE', mode: 'ptt' });  await refreshState(); });
$('mic-open').addEventListener('click', async () => {
  const r = await send({ type: 'VF_SET_MIC_MODE', mode: 'open' });
  if (r && !r.ok) { $('heard').textContent = `mic: ${String(r.error || 'failed').slice(0, 56)}`; if (/permission|notallowed|denied/i.test(r.error || '')) $('mic-row').hidden = false; }
  await refreshState();
});
$('next').addEventListener('click',   async () => { await send({ type: 'VF_NEXT' });   await refreshState(); });
$('prev').addEventListener('click',   async () => { await send({ type: 'VF_PREV' });   await refreshState(); });
$('repeat').addEventListener('click', async () => { await send({ type: 'VF_REPEAT' }); await refreshState(); });
$('stop').addEventListener('click',   async () => { await send({ type: 'VF_STOP' });   await refreshState(); });

$('play').addEventListener('click', async () => {
  set('audio', 'wait', 'playing');
  const r = await send({ type: 'VF_PLAY_TEST' });
  if (r?.ok) set('audio', 'ok', `${r.startLatencyMs}ms start, ${r.playedMs}ms played`);
  else set('audio', 'bad', (r?.error || 'failed').slice(0, 22));
  await refreshDiagnostics();
});

/* ------------------------------------------------------- proxy token ---- */

// The backend's /speak upgrade and /stt both 401 without PROXY_TOKEN. The
// offscreen document reads it from chrome.storage.local, so saving it here and
// reconnecting is all that is needed - no reload of the extension.
{
  const d = await chrome.storage.local.get(['proxyToken']);
  $('token').value = d.proxyToken || '';
  $('token-row').hidden = !!d.proxyToken;
  $('token-msg').textContent = d.proxyToken ? '' : 'Backend needs PROXY_TOKEN from .env before it will speak';
}
/* --------------------------------------------------- mic permission ---- */

// The popup shares the extension origin, so it can read the mic permission
// state even though the capture happens in the offscreen document.
async function refreshMic() {
  try {
    const p = await navigator.permissions.query({ name: 'microphone' });
    $('mic-row').hidden = p.state === 'granted';
    $('mic-msg').textContent = p.state === 'denied'
      ? 'Microphone blocked for this extension - allow it on the permission page'
      : 'Push-to-talk needs microphone access before it can hear you';
    p.onchange = refreshMic;
  } catch { /* leave hidden; a failed listen still reveals the row */ }
}
$('mic-allow').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('permission/permission.html') });
});
await refreshMic();

$('token-edit').addEventListener('click', () => { $('token-row').hidden = false; $('token').focus(); });
$('token-save').addEventListener('click', async () => {
  const proxyToken = $('token').value.trim();
  await chrome.storage.local.set({ proxyToken });
  $('token-msg').textContent = 'saved, reconnecting';
  const r = await send({ type: 'VF_CONNECT' });
  $('token-msg').textContent = r?.ok ? 'connected' : `still failing: ${r?.error || 'unknown'}`;
  if (r?.ok) $('token-row').hidden = true;
  await refreshDiagnostics();
  await refreshState();
});

await refreshDiagnostics();
// Open the socket and warm it now, while the user is still reading the popup.
// By the time Start is pressed the first utterance is a warm one.
send({ type: 'VF_CONNECT' }).then(refreshState);
await refreshState();
// The session lives in the offscreen document, so the popup is a view onto it,
// not its owner: closing and reopening the popup must not disturb playback.
setInterval(refreshState, 700);

/* ponytail: debug capture for the static report. Remove with the worklet half.
   Rec arms the output monitor; Dump saves exactly what was rendered to the
   speaker as a WAV, so the noise can be looked at instead of described. */
$('rec').addEventListener('click', async () => {
  const r = await send({ type: 'VF_REC_START' });
  $('ledger').textContent = r?.ok ? 'recording output...' : `rec failed: ${r?.error}`;
});
$('dump').addEventListener('click', async () => {
  const r = await send({ type: 'VF_REC_DUMP' });
  if (!r?.ok) { $('ledger').textContent = `dump failed: ${r?.error}`; return; }
  const bin = atob(r.b64), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const h = new DataView(new ArrayBuffer(44));
  const W = (o, str) => { for (let i = 0; i < str.length; i++) h.setUint8(o + i, str.charCodeAt(i)); };
  W(0, 'RIFF'); h.setUint32(4, 36 + u8.length, true); W(8, 'WAVEfmt ');
  h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, r.rate, true); h.setUint32(28, r.rate * 2, true);
  h.setUint16(32, 2, true); h.setUint16(34, 16, true); W(36, 'data'); h.setUint32(40, u8.length, true);
  const url = URL.createObjectURL(new Blob([h.buffer, u8], { type: 'audio/wav' }));
  const a = document.createElement('a');
  a.href = url; a.download = `voicefill-output-${Date.now()}.wav`; a.click();
  $('ledger').textContent = `dumped ${(r.frames / r.rate).toFixed(2)}s @ ${r.rate}Hz`;
});
