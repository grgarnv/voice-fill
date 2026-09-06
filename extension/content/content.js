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
  const DW = globalThis.VFDomWrite;

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

  const indexFor = (fieldId) => graph.fields.findIndex(f => f.id === fieldId);

  /** The element(s) for a field. Groups keep their whole list - a radio group
   *  is written by clicking one of several, not by touching the first. */
  const elementsFor = (fieldId) => {
    const i = indexFor(fieldId);
    return i < 0 ? null : graph.elements[i];
  };

  const elementFor = (fieldId) => {
    const e = elementsFor(fieldId);
    return Array.isArray(e) ? e[0] : e;
  };

  /* --------------------------------------------- dependent fields (F4.1) --- */

  const dependentsOf = (fieldId) => graph.fields.filter(f => f.dependsOn === fieldId);

  /**
   * Re-read the fields whose contents depend on the one just answered.
   *
   * The page repopulates them itself, asynchronously and on its own schedule -
   * a cascading country select usually fetches. So this waits for the option
   * list to actually change, up to a bounded number of frames, and then says
   * what it found. It never populates anything: if the page does not, the
   * dependent field is reported still empty and the session asks nothing it
   * cannot offer answers for.
   */
  async function refreshDependents(dependents, { tries = 12, everyMs = 60 } = {}) {
    const before = new Map(dependents.map(f => [f.id, f.optionCount]));
    for (let i = 0; i < tries; i++) {
      await new Promise(r => setTimeout(r, everyMs));
      rescan();
      const now = graph.fields.filter(f => before.has(f.id));
      if (now.some(f => f.optionCount !== before.get(f.id))) break;
    }
    // Tell the session the shape changed, on the same channel an SPA remount
    // uses. Updating lastSignature here would leave the observer with nothing
    // to report, and the session holding the empty option list it started with.
    lastSignature = signature(graph);
    try {
      chrome.runtime.sendMessage({ type: 'VF_FIELDS_CHANGED', fields: graph.fields, frame: where, why: 'dependent' }).catch(() => {});
    } catch {}
    return graph.fields
      .filter(f => before.has(f.id))
      .map(f => ({
        id: f.id, label: f.label, optionCount: f.optionCount, options: f.options,
        awaitingParent: f.awaitingParent, wasOptionCount: before.get(f.id),
      }));
  }

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

  // The FieldGraph's own signature: ids, types, option counts, labels and
  // requiredness. Ids alone missed a dependent select being populated - the
  // change that matters most on a cascading form (F4.1 / F4.9).
  const signature = (g) => g.signature ?? FG.signatureOf(g.fields || []);

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
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'aria-hidden', 'disabled', 'type',
        // F4: a cascading select is repopulated, a wizard step is swapped in,
        // a custom control changes its selection - none of which touch an id.
        'required', 'aria-required', 'aria-invalid', 'aria-expanded', 'aria-checked',
        'aria-selected', 'aria-disabled', 'value', 'placeholder', 'role'],
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

      // ---- Phase 2: write, validate, read back -------------------------
      case 'VF_WRITE_FIELD': {
        const els = elementsFor(msg.fieldId);
        if (!els) { respond({ ok: false, error: 'field not found - the page may have re-rendered' }); return true; }
        const i = indexFor(msg.fieldId);
        // msg.type is the MESSAGE type; the field's type travels as fieldType.
        const type = msg.fieldType || graph.fields[i]?.type;
        // Async since F4: a controlled input reverts a task later and a custom
        // listbox opens a frame later. Both are awaited before anything is
        // reported, so `ok` is a fact rather than a hope.
        DW.write(els, type, msg.value).then(async (w) => {
          const v = DW.validate(els);
          // A dependent field's options are a function of this answer, so the
          // graph is rebuilt before the session is told the write landed - the
          // next question is then asked against the list the page really has.
          const dependents = dependentsOf(msg.fieldId);
          let refreshed = null;
          if (dependents.length) refreshed = await refreshDependents(dependents);
          respond({
            ok: !!w.ok, written: w.written, error: w.error || null,
            valid: v.valid, reason: v.reason, validationSource: v.source,
            current: DW.readCurrent(els, type),
            dependents: refreshed,
          });
        }).catch(e => respond({ ok: false, error: String(e?.message || e) }));
        return true;
      }

      // F4.9: an explicit rescan, for a caller that knows the DOM moved (a
      // wizard step, a submit) and will not wait for the observer's debounce.
      case 'VF_RESCAN': {
        rescan();
        lastSignature = signature(graph);
        startObserver();
        respond({ ok: true, fields: graph.fields, skipped: graph.skipped, frame: where, url: location.href });
        return true;
      }

      // F4.3: everything the page is complaining about right now, mapped back
      // to the session's own field ids. It reports; it decides nothing.
      case 'VF_FIND_INVALID': {
        const byId = {};
        graph.fields.forEach((f, i) => { byId[f.id] = graph.elements[i]; });
        respond({ ok: true, invalid: DW.findInvalid(byId) });
        return true;
      }

      case 'VF_READ_FIELD': {
        const els = elementsFor(msg.fieldId);
        if (!els) { respond({ ok: false, error: 'field not found' }); return true; }
        const i = indexFor(msg.fieldId);
        const type = graph.fields[i]?.type;
        respond({ ok: true, current: DW.readCurrent(els, type), validity: DW.validate(els) });
        return true;
      }

      case 'VF_CLEAR_FOCUS':
        ringTarget = null; currentId = null; hideRing();
        respond({ ok: true });
        return true;

      default:
        return false;   // not ours - let another listener answer
    }
  });
})();
