// Phase 0 diagnostic panel. Each row is one exit criterion you can see.
const set = (k, state, text) => {
  document.getElementById(`d-${k}`).className = `dot ${state}`;
  document.getElementById(`v-${k}`).textContent = text;
};

async function send(msg) {
  try { return await chrome.runtime.sendMessage(msg); }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
}

async function refresh() {
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
      set('content', c?.ok ? 'ok' : 'bad', c?.ok ? c.frame : 'not injected');
      // A page can enforce CSP via response header, which a content script
      // cannot read - so trust the active probe, not the meta tag.
      const csp = c?.csp;
      set('csp', csp?.enforced ? 'ok' : 'wait', csp?.label ?? 'unknown');
    } catch {
      set('content', 'bad', 'not injected');
      set('csp', 'wait', 'unknown');
    }
  }

  const { speaker, model } = await chrome.storage.local.get(['speaker', 'model']);
  if (speaker) document.getElementById('speaker').textContent = speaker;
  if (model) document.getElementById('model').textContent = model;
}

// The click is the user gesture that satisfies Chrome's autoplay policy.
// Everything downstream (AudioContext.resume, el.play) rides on this call stack.
document.getElementById('play').addEventListener('click', async () => {
  set('audio', 'wait', 'playing');
  const r = await send({ type: 'VF_PLAY_TEST' });
  if (r?.ok) set('audio', 'ok', `${r.startLatencyMs}ms start, ${r.playedMs}ms played`);
  else set('audio', 'bad', (r?.error || 'failed').slice(0, 22));
  await refresh();
});

refresh();
