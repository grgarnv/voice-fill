// Phase 0 content script: prove injection on any page, including strict-CSP sites.
// No DOM scanning yet - FieldGraph is Phase 1.
(() => {
  const where = window.top === window ? 'top' : 'iframe';
  console.log(`[VoiceFill] content script loaded (${where}) on ${location.origin}`);

  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');

  /**
   * Detect the page's Content-Security-Policy.
   *
   * Two earlier attempts failed for instructive reasons:
   *   1. Reading <meta http-equiv="Content-Security-Policy"> misses every site
   *      that delivers CSP as an HTTP response header - which is most hardened
   *      sites, including Google and GitHub.
   *   2. Injecting an inline <script> and watching for securitypolicyviolation
   *      never fires, because Chrome runs extension-injected scripts under the
   *      EXTENSION's policy, not the page's. The probe is blind to page CSP for
   *      exactly the same reason the offscreen document survives it.
   *
   * A same-origin fetch of the current document is the reliable route: CORS
   * imposes no header restrictions on same-origin responses, so the CSP header
   * is readable, and no extra host permission is required.
   */
  async function probeCSP() {
    const metaCsp = meta ? meta.getAttribute('content') : null;
    try {
      const res = await fetch(location.href, {
        method: 'GET', credentials: 'include', cache: 'force-cache', redirect: 'follow',
      });
      const enforce = res.headers.get('content-security-policy');
      const report = res.headers.get('content-security-policy-report-only');
      const first = (h) => (h || '').split(';').map(d => d.trim().split(' ')[0]).filter(Boolean).slice(0, 3).join(' ');

      if (enforce) return { enforced: true, source: 'header', directives: first(enforce), label: `enforced: ${first(enforce)}` };
      if (metaCsp) return { enforced: true, source: 'meta', directives: first(metaCsp), label: `meta: ${first(metaCsp)}` };
      if (report) return { enforced: false, source: 'report-only', directives: first(report), label: `report-only: ${first(report)}` };
      return { enforced: false, source: 'none', label: 'none' };
    } catch (e) {
      // Opaque redirect, offline, or a page that refuses the refetch.
      if (metaCsp) return { enforced: true, source: 'meta', label: 'meta CSP present' };
      return { enforced: false, source: 'unknown', label: `not readable (${String(e.message).slice(0, 24)})` };
    }
  }

  window.__voicefill = { loaded: true, frame: where, cspMeta: meta ? meta.getAttribute('content') : null, at: Date.now() };

  chrome.runtime.onMessage.addListener((msg, _s, respond) => {
    if (msg?.type === 'VF_CONTENT_PING') {
      probeCSP().then(csp => respond({
        ok: true, frame: where, origin: location.origin,
        cspMeta: window.__voicefill.cspMeta, csp,
      }));
      return true;   // async respond
    }
    return true;
  });
})();
