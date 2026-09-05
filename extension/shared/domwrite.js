// DOM writing (PRD F2.4) and validation detection (F2.7).
//
// The whole file exists because `el.value = x` does not work on a
// framework-controlled input. React installs its own value setter on the
// element instance, tracks the last value it wrote, and IGNORES an input event
// whose value matches what it already believes - so a naive assignment either
// does nothing or updates the pixels and leaves React's state stale, which is
// worse, because it looks like it worked.
globalThis.VFDomWrite = (() => {
  'use strict';

  /**
   * Write through the PROTOTYPE's native setter, bypassing the instance-level
   * setter React installs, then invalidate React's internal value tracker so
   * the change event is not swallowed as a no-op.
   */
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    const own = Object.getOwnPropertyDescriptor(el, 'value');

    // React >=16 stashes a tracker here. Without resetting it, an event whose
    // value equals the tracked one is discarded before any handler runs.
    const tracker = el._valueTracker;
    if (tracker && typeof tracker.setValue === 'function') tracker.setValue('__vf_stale__');

    if (desc && desc.set) desc.set.call(el, value);
    else if (own && own.set) own.set.call(el, value);
    else el.value = value;
  }

  const fire = (el, type, init = {}) => el.dispatchEvent(new Event(type, { bubbles: true, ...init }));

  /** Frameworks listen for different things; sending all of them is cheap. */
  function notify(el) {
    fire(el, 'input');
    fire(el, 'change');
    try { el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' })); } catch {}
  }

  /**
   * Masked and date widgets frequently ignore a value assignment and accept only
   * real keystrokes. Typing is slower, so it is a fallback, not the default.
   */
  function typeInto(el, text) {
    el.focus();
    setNativeValue(el, '');
    notify(el);
    for (const ch of String(text)) {
      const init = { bubbles: true, key: ch, cancelable: true };
      try { el.dispatchEvent(new KeyboardEvent('keydown', init)); } catch {}
      setNativeValue(el, (el.value || '') + ch);
      fire(el, 'input');
      try { el.dispatchEvent(new KeyboardEvent('keyup', init)); } catch {}
    }
    fire(el, 'change');
  }

  function writeText(el, value) {
    el.focus();
    setNativeValue(el, value);
    notify(el);
    // A controlled input that rejected the write reverts synchronously.
    if (String(el.value) !== String(value)) typeInto(el, value);
    el.blur();
    return String(el.value);
  }

  function writeContentEditable(el, value) {
    el.focus();
    el.textContent = value;
    fire(el, 'input');
    el.blur();
    return el.textContent;
  }

  /** select: match by value, then exact label, then case-insensitively. */
  function writeSelect(el, value) {
    const opts = Array.from(el.options || []);
    const opt = opts.find(o => o.value === value)
      || opts.find(o => o.textContent.trim() === value)
      || opts.find(o => o.textContent.trim().toLowerCase() === String(value).toLowerCase())
      || opts.find(o => o.value.toLowerCase() === String(value).toLowerCase());
    if (!opt) return { ok: false, written: el.value, error: 'no matching option' };
    el.focus();
    // selectedIndex rather than .value: it keeps duplicate-valued options
    // distinguishable and works when the option has no explicit value.
    el.selectedIndex = opt.index;
    notify(el);
    el.blur();
    return { ok: el.selectedIndex === opt.index, written: el.value };
  }

  function writeSelectMultiple(el, values) {
    const want = new Set((Array.isArray(values) ? values : [values]).map(String));
    const opts = Array.from(el.options || []);
    let hit = 0;
    for (const o of opts) {
      const on = want.has(o.value) || want.has(o.textContent.trim());
      if (on) hit++;
      o.selected = on;
    }
    notify(el);
    return { ok: hit > 0, written: opts.filter(o => o.selected).map(o => o.value) };
  }

  /**
   * Radios and checkboxes are CLICKED, never assigned. A framework listening for
   * a click never sees `.checked = true`, and a styled control usually hides its
   * real input behind a label that owns the interaction.
   */
  function clickTargetFor(el) {
    return (el.offsetParent === null && el.labels && el.labels[0]) ? el.labels[0] : el;
  }

  function writeRadio(els, value) {
    const list = Array.isArray(els) ? els : [els];
    const labelOf = (e) => (e.labels && e.labels[0] ? e.labels[0].textContent : '').trim();
    const target = list.find(e => e.value === value)
      || list.find(e => labelOf(e) === value)
      || list.find(e => labelOf(e).toLowerCase() === String(value).toLowerCase());
    if (!target) return { ok: false, error: 'no matching radio' };
    clickTargetFor(target).click();
    if (!target.checked) { target.checked = true; notify(target); }
    return { ok: !!target.checked, written: target.value };
  }

  function writeCheckboxGroup(els, values) {
    const list = Array.isArray(els) ? els : [els];
    const want = new Set((Array.isArray(values) ? values : [values]).map(String));
    let changed = 0;
    for (const el of list) {
      const label = (el.labels && el.labels[0] ? el.labels[0].textContent : '').trim();
      const on = want.has(el.value) || want.has(label)
        || [...want].some(w => String(w).toLowerCase() === label.toLowerCase());
      if (el.checked !== on) {
        clickTargetFor(el).click();
        if (el.checked !== on) { el.checked = on; notify(el); }
        changed++;
      }
    }
    return { ok: true, changed, written: list.filter(e => e.checked).map(e => e.value) };
  }

  function writeBoolean(el, value) {
    const want = value === true || value === 'true' || value === 'yes';
    if (el.checked !== want) {
      clickTargetFor(el).click();
      if (el.checked !== want) { el.checked = want; notify(el); }
    }
    return { ok: el.checked === want, written: String(el.checked) };
  }

  /** Dispatch by field type. `els` may be one element or a group. */
  function write(els, type, value) {
    const el = Array.isArray(els) ? els[0] : els;
    if (!el || !el.isConnected) return { ok: false, error: 'element gone from the DOM' };
    try {
      switch (type) {
        case 'radiogroup': return writeRadio(els, value);
        case 'checkboxgroup': return writeCheckboxGroup(els, value);
        case 'checkbox': return writeBoolean(el, value);
        case 'select': return writeSelect(el, value);
        case 'select-multiple': return writeSelectMultiple(el, value);
        case 'contenteditable': return { ok: true, written: writeContentEditable(el, value) };
        case 'date': case 'time': case 'datetime-local': case 'month': case 'week': {
          // A native date input accepts a correctly formatted value directly. A
          // masked text widget pretending to be one accepts only keystrokes.
          el.focus(); setNativeValue(el, value); notify(el); el.blur();
          if (el.value !== value) typeInto(el, value);
          return { ok: el.value === value, written: el.value };
        }
        default: {
          const written = writeText(el, value);
          return { ok: written === String(value), written };
        }
      }
    } catch (e) {
      return { ok: false, error: String(e.message) };
    }
  }

  /* ------------------------------------------------- validation (F2.7) ---- */

  /**
   * Did the page reject the value? Three independent signals, because sites use
   * whichever they please: constraint validation, ARIA, and a visible error node.
   */
  function validate(els) {
    const el = Array.isArray(els) ? els[0] : els;
    if (!el || !el.isConnected) return { valid: false, reason: 'element gone', source: 'dom' };

    if (el.getAttribute && el.getAttribute('aria-invalid') === 'true') {
      return { valid: false, reason: describedByText(el) || 'the page marked this field invalid', source: 'aria-invalid' };
    }
    if (typeof el.checkValidity === 'function' && !el.checkValidity()) {
      return { valid: false, reason: el.validationMessage || 'the value is not in the format this field expects', source: 'constraint' };
    }
    const near = nearbyError(el);
    if (near) return { valid: false, reason: near, source: 'error-node' };
    return { valid: true, reason: null, source: null };
  }

  function describedByText(el) {
    const ids = (el.getAttribute('aria-describedby') || '').trim();
    if (!ids) return null;
    const doc = el.ownerDocument;
    const t = ids.split(/\s+/)
      .map(id => (doc.getElementById(id) || {}).textContent || '')
      .join(' ').replace(/\s+/g, ' ').trim();
    return t || null;
  }

  const CONTROL_SEL = 'input:not([type=hidden]),select,textarea,[contenteditable=""],[contenteditable="true"]';
  const ERROR_SEL = '[role=alert],[aria-live=assertive],.error,.invalid,.field-error,.form-error,'
    + '.help-block,.invalid-feedback,.error-message,[class*="error" i]';

  /**
   * A visible error message belonging to THIS field.
   *
   * Walking up the ancestors and taking the first error-shaped node was wrong
   * in a way that matters: on any flat form the walk reaches <body> and adopts
   * the page's own error banner, which marks a perfectly good value invalid and
   * sends the session into its retry-then-skip path. Measured on the validation
   * fixture: a conforming postcode was reported invalid because of an unrelated
   * notice elsewhere on the page.
   *
   * Ownership is decided by document order instead. An error node belongs to
   * the last control that precedes it (or to the control it wraps), which is
   * how a sighted reader assigns it too.
   */
  function nearbyError(el) {
    const doc = el.ownerDocument;
    const win = doc.defaultView;
    const root = el.closest('form') || doc.body;
    if (!root) return null;

    let controls = [];
    let nodes = [];
    try {
      controls = Array.from(root.querySelectorAll(CONTROL_SEL));
      nodes = Array.from(root.querySelectorAll(ERROR_SEL));
    } catch { return null; }

    for (const n of nodes) {
      if (n.contains(el)) continue;
      let cs;
      try { cs = win.getComputedStyle(n); } catch { continue; }
      if (!cs || cs.display === 'none' || cs.visibility === 'hidden') continue;
      const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 160) continue;

      // Which control does this message sit with?
      let owner = null;
      for (const c of controls) {
        if (n.contains(c)) { owner = c; break; }
        // c precedes n in document order
        if (c.compareDocumentPosition(n) & 4 /* DOCUMENT_POSITION_FOLLOWING */) owner = c;
      }
      if (!owner) continue;
      // Same field, or another member of the same radio/checkbox group.
      if (owner === el) return t;
      if (el.name && owner.name === el.name) return t;
    }
    return null;
  }

  /** What is actually in the field now - the truth a read-back must report. */
  function readCurrent(els, type) {
    const el = Array.isArray(els) ? els[0] : els;
    if (!el || !el.isConnected) return null;
    const labelOf = (e) => (e.labels && e.labels[0] ? e.labels[0].textContent : '').trim();
    switch (type) {
      case 'radiogroup': {
        const on = (Array.isArray(els) ? els : [els]).find(e => e.checked);
        return on ? (labelOf(on) || on.value) : null;
      }
      case 'checkboxgroup':
        return (Array.isArray(els) ? els : [els]).filter(e => e.checked)
          .map(e => labelOf(e) || e.value).join(', ') || null;
      case 'checkbox': return el.checked ? 'yes' : 'no';
      case 'select': {
        const o = el.options[el.selectedIndex];
        return o ? o.textContent.trim() : null;
      }
      case 'select-multiple':
        return Array.from(el.selectedOptions || []).map(o => o.textContent.trim()).join(', ') || null;
      case 'contenteditable': return el.textContent;
      default: return el.value;
    }
  }

  return {
    write, validate, readCurrent, setNativeValue, typeInto, nearbyError,
    writeSelect, writeRadio, writeCheckboxGroup, writeBoolean, writeText,
  };
})();
