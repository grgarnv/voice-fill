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
}

async function refreshState() {
  const s = await send({ type: 'VF_STATE' });
  if (s?.ok) {
    paintProvider(s.provider);
    paintSession(s);
    const wsOk = s.connected;
    set('ws', wsOk ? 'ok' : (s.lastError ? 'bad' : 'wait'),
        wsOk ? `${s.state.toLowerCase()} · turn ${s.turnId}` : (s.lastError || 'not connected').slice(0, 26));
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
  await send({ type: 'VF_LISTEN_START' });
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

await refreshDiagnostics();
// Open the socket and warm it now, while the user is still reading the popup.
// By the time Start is pressed the first utterance is a warm one.
send({ type: 'VF_CONNECT' }).then(refreshState);
await refreshState();
// The session lives in the offscreen document, so the popup is a view onto it,
// not its owner: closing and reopening the popup must not disturb playback.
setInterval(refreshState, 700);
