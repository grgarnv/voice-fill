// Content script: the page-side half. Builds the FieldGraph, holds the element
// references (which can never cross chrome.runtime), draws the focus ring, and
// watches for SPA remounts.
//
// Loaded AFTER shared/fieldgraph.js and shared/prompts.js, which the manifest
// injects into the same isolated world.
(() => {
  'use strict';
  const where = window.top === window ? 'top' : 'iframe';
  console.log(`[VoiceFill] content script loaded (${where}) on ${location.origin}`);

  const FG = globalThis.VFFieldGraph;

  /** Live graph: serialisable records for messaging, elements kept here. */
  let graph = { fields: [], elements: [], skipped: null, scannedAt: 0 };
  let currentId = null;

  function rescan() {
    try {
      graph = FG.scan(document);
    } catch (e) {
      console.warn('[VoiceFill] scan failed', e);
      graph = { fields: [], elements: [], skipped: null, scannedAt: Date.now(), error: String(e.message) };
    }
    return graph;
  }

  const elementFor = (fieldId) => {
    const i = graph.fields.findIndex(f => f.id === fieldId);
    if (i < 0) return null;
    const e = graph.elements[i];
    return Array.isArray(e) ? e[0] : e;
  };

  /* ------------------------------------------------------- focus ring F1.5 -- */
  //
  // An overlay div, not a CSS outline on the field itself: page stylesheets
  // routinely set `outline: none !important` on inputs, and mutating the
  // element's own style can trip a framework's dirty-checking. The overlay is
  // pointer-events:none so it can never intercept a click.

  let ring = null;
  let ringTarget = null;

  function ensureRing() {
    if (ring && ring.isConnected) return ring;
    ring = document.createElement('div');
    ring.setAttribute('data-voicefill-ring', '');
    Object.assign(ring.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: '2147483647',
      border: '3px solid #6ea8fe', borderRadius: '6px',
      boxShadow: '0 0 0 3px rgba(110,168,254,.28)', transition: 'all .12s ease-out',
      display: 'none', margin: '0', padding: '0', background: 'transparent',
    });
    (document.body || document.documentElement).appendChild(ring);
    return ring;
  }

  function positionRing() {
    if (!ringTarget || !ringTarget.isConnected) return hideRing();
    const r = ringTarget.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return hideRing();
    const g = ensureRing();
    // Radios and checkboxes are often 13px squares; pad the ring so it reads as
    // "this group", not as a speck.
    const pad = (ringTarget.type === 'radio' || ringTarget.type === 'checkbox') ? 6 : 2;
    Object.assign(g.style, {
      display: 'block',
      top: `${r.top - pad}px`, left: `${r.left - pad}px`,
      width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`,
    });
  }

  function hideRing() { if (ring) ring.style.display = 'none'; }

  function focusField(fieldId) {
    const el = elementFor(fieldId);
    if (!el) return { ok: false, error: 'field not found' };
    currentId = fieldId;
    ringTarget = el;
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {}
    positionRing();
    return { ok: true, fieldId, tag: el.tagName.toLowerCase() };
  }

  addEventListener('scroll', positionRing, { passive: true, capture: true });
  addEventListener('resize', positionRing, { passive: true });

  /* ------------------------------------------- dynamic DOM (SPA) handling --- */
  //
  // React/Angular forms mount fields after load and re-render on interaction.
  // The pointer is kept by stable id, never index (PRD Phase 1), and the
  // observer is debounced because some sites re-render on every keystroke.

  let debounce = null;
  let observer = null;
  let lastSignature = '';

  const signature = (g) => g.fields.map(f => f.id).join('|');

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const before = lastSignature;
        rescan();
        const after = signature(graph);
        if (after !== before) {
          lastSignature = after;
          positionRing();
          // Tell the session the shape changed. Fire-and-forget: the service
          // worker may be asleep, and a rejected promise here must not break
          // the page.
          try {
            chrome.runtime.sendMessage({
              type: 'VF_FIELDS_CHANGED', fields: graph.fields, frame: where,
            }).catch(() => {});
          } catch {}
        }
      }, 250);
    });
    observer.observe(document.documentElement, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['style', 'class', 'hidden', 'aria-hidden', 'disabled', 'type'],
    });
  }

  /* --------------------------------------------------------------- CSP ----- */

  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');

  /**
   * Two earlier attempts failed for instructive reasons:
   *   1. Reading the meta tag misses every site that sends CSP as an HTTP
   *      header - which is most hardened sites, Google and GitHub included.
   *   2. Injecting an inline <script> and watching for securitypolicyviolation
   *      never fires: Chrome runs extension-injected scripts under the
   *      EXTENSION's policy, not the page's. The probe is blind to page CSP for
   *      exactly the reason the offscreen document survives it.
   * A same-origin refetch is the reliable route.
   */
  async function probeCSP() {
    const metaCsp = meta ? meta.getAttribute('content') : null;
    try {
      const res = await fetch(location.href, { method: 'GET', credentials: 'include', cache: 'force-cache', redirect: 'follow' });
      const enforce = res.headers.get('content-security-policy');
      const report = res.headers.get('content-security-policy-report-only');
      const first = (h) => (h || '').split(';').map(d => d.trim().split(' ')[0]).filter(Boolean).slice(0, 3).join(' ');
      if (enforce) return { enforced: true, source: 'header', directives: first(enforce), label: `enforced: ${first(enforce)}` };
      if (metaCsp) return { enforced: true, source: 'meta', directives: first(metaCsp), label: `meta: ${first(metaCsp)}` };
      if (report) return { enforced: false, source: 'report-only', directives: first(report), label: `report-only: ${first(report)}` };
      return { enforced: false, source: 'none', label: 'none' };
    } catch (e) {
      if (metaCsp) return { enforced: true, source: 'meta', label: 'meta CSP present' };
      return { enforced: false, source: 'unknown', label: `not readable (${String(e.message).slice(0, 24)})` };
    }
  }

  window.__voicefill = { loaded: true, frame: where, at: Date.now(), scan: () => rescan() };

  /* -------------------------------------------------------------- router --- */

  chrome.runtime.onMessage.addListener((msg, _s, respond) => {
    switch (msg?.type) {
      case 'VF_CONTENT_PING':
        probeCSP().then(csp => respond({
          ok: true, frame: where, origin: location.origin,
          cspMeta: meta ? meta.getAttribute('content') : null, csp,
          fieldCount: graph.fields.length,
        }));
        return true;

      case 'VF_SCAN': {
        rescan();
        lastSignature = signature(graph);
        startObserver();
        respond({
          ok: true, frame: where, url: location.href,
          fields: graph.fields, skipped: graph.skipped,
          unlabelled: graph.fields.filter(f => !f.label).length,
        });
        return true;
      }

      case 'VF_FOCUS_FIELD':
        respond(focusField(msg.fieldId));
        return true;

      case 'VF_CLEAR_FOCUS':
        ringTarget = null; currentId = null; hideRing();
        respond({ ok: true });
        return true;

      default:
        return false;   // not ours - let another listener answer
    }
  });
})();
