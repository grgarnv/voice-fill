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

  /* ------------------------------------------------- masks (PRD F4.5) ---- */

  // A mask template as the page states it: placeholder, data-mask, or a pattern
  // simple enough to read literally. `#` and `9`/`X`/letters stand for the
  // significant characters; everything else is punctuation the widget inserts.
  const MASK_CHARS = /[#9xX_aA0]/;

  /**
   * The mask this element expects, as a template like "(###) ###-####", or null.
   *
   * Only sources that are unambiguously a FORMAT are trusted. A placeholder is
   * a mask when it is mostly punctuation and repeated placeholder characters -
   * "(555) 555-5555" and "DD/MM/YYYY" are, "Your phone number" is not.
   */
  function maskOf(el) {
    if (!el || !el.getAttribute) return null;
    const explicit = el.getAttribute('data-mask') || el.getAttribute('data-inputmask')
      || el.getAttribute('data-format') || el.getAttribute('data-date-format');
    if (explicit && MASK_CHARS.test(explicit.replace(/[dmyhDMYH]/g, '#'))) return normalizeMask(explicit);
    const ph = el.getAttribute('placeholder');
    if (ph && looksLikeMask(ph)) return normalizeMask(ph);
    return null;
  }

  /**
   * Is this string a FORMAT rather than a hint?
   *
   * Two shapes, and only two: the letter form ("DD/MM/YYYY") and the sample
   * form ("(555) 555-5555", "___-__-____"). Both are entirely slots and
   * punctuation. Anything containing a word - "Your phone number", "e.g. SW1A
   * 2AA" - is a hint, and treating a hint as a mask silently mangles the value.
   */
  function looksLikeMask(raw) {
    const t = String(raw || '').trim();
    if (!t || t.length > 32) return false;
    if (/^(d{1,2}|m{1,2}|y{2,4}|h{1,2})([\/\-. ](d{1,2}|m{1,2}|y{2,4}|h{1,2}))+$/i.test(t)) return true;
    if (/[a-wz]/i.test(t)) return false;              // any real letter: a hint, not a mask
    const slots = (t.match(/[#9_xX0-9]/g) || []).length;
    const punct = (t.match(/[^#9_xX0-9]/g) || []).length;
    return slots >= 3 && punct >= 1;
  }

  /**
   * Every slot character becomes `#`; punctuation is kept verbatim.
   *
   * A template that already uses explicit slot characters keeps its digits as
   * LITERALS - "+1 (###) ###-####" means a leading 1, not a fourteenth slot.
   * A sample-form template has no explicit slots, so its digits are the slots.
   */
  function normalizeMask(raw) {
    const t = String(raw);
    const hasSlots = /[#9_xX]/.test(t);
    return hasSlots
      ? t.replace(/[dmyhDMYH#9_xXaA]/g, '#')
      : t.replace(/[dmyhDMYHaA0-9]/g, '#');
  }

  /**
   * Significant characters poured into a template - all of them, into all of
   * its slots, or null.
   *
   * Deliberately all-or-nothing. A half-filled mask ("(555) 12") is a
   * plausible-looking wrong value, and this product's one unrecoverable failure
   * is a wrong value that reads back as if it were right. A value that does not
   * fit goes in raw instead, and the page's own validation gets to refuse it.
   */
  function applyMask(chars, template) {
    const src = String(chars);
    const slots = (template.match(/#/g) || []).length;
    if (src.length !== slots) return null;
    let out = '', i = 0;
    for (const t of template) out += (t === '#' ? src[i++] : t);
    return out;
  }

  const significant = (v) => String(v ?? '').replace(/[^0-9a-z]/gi, '');

  /** A mask that is plainly a date, and the order its parts are in. */
  function dateMaskOrder(el) {
    const raw = (el.getAttribute && (el.getAttribute('data-date-format') || el.getAttribute('placeholder'))) || '';
    const m = /\b(d{1,2}|m{1,2}|y{2,4})\b[\/\-. ]+\b(d{1,2}|m{1,2}|y{2,4})\b[\/\-. ]+\b(d{1,2}|m{1,2}|y{2,4})\b/i.exec(raw);
    if (!m) return null;
    const sep = (/[\/\-.]/.exec(raw.replace(/[dmyDMY]/g, '')) || ['/'])[0];
    return { order: [m[1], m[2], m[3]].map(x => x[0].toLowerCase()), sep, widths: [m[1].length, m[2].length, m[3].length] };
  }

  /** ISO week number, for `<input type=week>`. */
  function isoWeek(y, mo, d) {
    const dt = new Date(Date.UTC(y, mo - 1, d));
    const day = dt.getUTCDay() || 7;
    dt.setUTCDate(dt.getUTCDate() + 4 - day);
    const start = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
    return { year: dt.getUTCFullYear(), week: Math.ceil(((dt - start) / 86400000 + 1) / 7) };
  }

  /**
   * The session's canonical value -> the string THIS element accepts (PRD F4.4
   * / F4.5).
   *
   * The session holds one shape per intent - ISO for dates, bare digits for
   * phones and postcodes - because that is what the read-back speaks and what
   * the validator checks. The page's own shape is a property of the element,
   * so the translation happens here, at the last possible moment, and nothing
   * upstream has to know the mask exists.
   */
  function formatForField(value, type, el) {
    const v = String(value ?? '');
    if (!v) return v;
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);

    // Native temporal inputs have a fixed wire format that is not YYYY-MM-DD.
    if (iso) {
      const [, y, mo, d] = iso;
      if (type === 'month') return `${y}-${mo}`;
      if (type === 'week') { const w = isoWeek(+y, +mo, +d); return `${w.year}-W${String(w.week).padStart(2, '0')}`; }
      if (type === 'datetime-local') return `${v}T00:00`;
      if (type === 'date') return v;
      // A text input pretending to be a date: honour the order it advertises.
      const dm = dateMaskOrder(el);
      if (dm) {
        const part = { d, m: mo, y };
        return dm.order.map((k, i) => (k === 'y' && dm.widths[i] === 2 ? y.slice(2) : part[k])).join(dm.sep);
      }
    }

    const mask = maskOf(el);
    if (mask) {
      const masked = applyMask(significant(v), mask);
      if (masked) return masked;
      // The value does not fit the stated mask. Writing a truncated one would
      // be a plausible-looking wrong answer, so the raw value goes in and the
      // page's own validation gets the last word.
    }
    return v;
  }

  /**
   * A controlled input does not revert synchronously.
   *
   * React schedules its re-render; checking `el.value` on the same tick sees
   * the pixels we just wrote and reports success for a write React is about to
   * throw away. One macrotask is enough for the render to land, and it is the
   * difference between "it looked like it worked" and knowing.
   */
  const settle = () => new Promise(r => setTimeout(r, 0));

  /** Did the field end up holding this value? A mask's own punctuation is not a difference. */
  const holds = (el, want) =>
    String(el.value) === String(want) || significant(el.value) === significant(want);

  async function writeText(el, value) {
    el.focus();
    setNativeValue(el, value);
    notify(el);
    await settle();
    if (holds(el, value)) { el.blur(); return String(el.value); }

    // Assignment was rejected or reverted. A masked widget inserts its own
    // punctuation, so typing the FORMATTED string into one produces
    // "((555)) 555--5555"; the significant characters alone are what it wants.
    const sig = significant(value);
    if (sig && sig !== String(value)) {
      typeInto(el, sig);
      await settle();
      if (holds(el, value)) { el.blur(); return String(el.value); }
    }
    typeInto(el, value);
    await settle();
    el.blur();
    return String(el.value);
  }

  /* -------------------------------------- custom ARIA controls (F4.7) ---- */

  const ariaLabelOf = (el) => (
    el.getAttribute('aria-label')
    || (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
        .map(id => (el.ownerDocument.getElementById(id) || {}).textContent || '').join(' ')
    || el.textContent || ''
  ).replace(/\s+/g, ' ').trim();

  const sameText = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

  /** The value a custom option carries: its explicit data, else its own text. */
  const optionValueOf = (el) =>
    el.getAttribute('data-value') || el.getAttribute('value') || ariaLabelOf(el);

  function findAriaOption(nodes, value) {
    return nodes.find(n => sameText(optionValueOf(n), value))
      || nodes.find(n => sameText(ariaLabelOf(n), value))
      || null;
  }

  /**
   * The listbox a combobox owns. `aria-controls`/`aria-owns` first, because a
   * popup listbox is routinely portalled to the end of <body> and is nowhere
   * near the trigger in the tree.
   */
  function listboxFor(el) {
    const doc = el.ownerDocument;
    const id = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    if (id) { const n = doc.getElementById(id.split(/\s+/)[0]); if (n) return n; }
    const inside = el.querySelector('[role=listbox]');
    if (inside) return inside;
    const wrap = el.closest('[role=combobox],[class*="select" i],[class*="combo" i]') || el.parentElement;
    const near = wrap && wrap.querySelector('[role=listbox]');
    if (near) return near;
    const all = Array.from(doc.querySelectorAll('[role=listbox]'));
    return all.length === 1 ? all[0] : null;   // more than one and we cannot tell: fail safe
  }

  const visibleOptions = (box) => {
    if (!box) return [];
    const win = box.ownerDocument.defaultView || window;
    return Array.from(box.querySelectorAll('[role=option]')).filter(o => {
      if (o.getAttribute('aria-disabled') === 'true') return false;
      try { const cs = win.getComputedStyle(o); return cs.display !== 'none' && cs.visibility !== 'hidden'; }
      catch { return true; }
    });
  };

  /**
   * A custom select: open it, pick the option by its own text, verify.
   *
   * Nothing here is told a selector by anything outside this file. The option
   * is found by matching the text the user was offered - which is the text the
   * FieldGraph read out of this same listbox - and the result is confirmed
   * against aria-selected or the trigger's own label before it counts.
   */
  async function writeCombobox(el, value) {
    const wasExpanded = el.getAttribute('aria-expanded') === 'true';
    if (!wasExpanded) {
      el.focus();
      (el.querySelector('[role=button],button') || el).click();
      await settle();
    }
    const box = listboxFor(el);
    let opts = visibleOptions(box);
    if (!opts.length) {
      // Some widgets only build their list a frame after the click.
      await new Promise(r => setTimeout(r, 60));
      opts = visibleOptions(listboxFor(el));
    }
    if (!opts.length) return { ok: false, error: 'the option list did not open' };

    const target = findAriaOption(opts, value);
    if (!target) {
      if (!wasExpanded) { try { el.click(); } catch {} }
      return { ok: false, error: 'no matching option' };
    }
    target.click();
    await settle();
    const chosen = target.getAttribute('aria-selected') === 'true'
      || el.getAttribute('aria-activedescendant') === target.id
      || sameText(ariaLabelOf(el), ariaLabelOf(target))
      || sameText(el.value ?? '', ariaLabelOf(target));
    return { ok: !!chosen, written: optionValueOf(target), display: ariaLabelOf(target) };
  }

  /** [role=radiogroup] / [role=listbox] of [role=radio] or [role=option]. */
  async function writeAriaChoice(container, value) {
    const nodes = Array.from(container.querySelectorAll('[role=radio],[role=option]'))
      .filter(n => n.getAttribute('aria-disabled') !== 'true');
    const target = findAriaOption(nodes, value);
    if (!target) return { ok: false, error: 'no matching option' };
    target.click();
    await settle();
    const on = target.getAttribute('aria-checked') === 'true' || target.getAttribute('aria-selected') === 'true';
    return { ok: on, written: optionValueOf(target), display: ariaLabelOf(target) };
  }

  async function writeAriaMultiChoice(container, values) {
    const want = new Set((Array.isArray(values) ? values : [values]).map(v => String(v).trim().toLowerCase()));
    const nodes = Array.from(container.querySelectorAll('[role=checkbox],[role=option]'))
      .filter(n => n.getAttribute('aria-disabled') !== 'true');
    let missed = 0;
    for (const n of nodes) {
      const on = want.has(String(optionValueOf(n)).trim().toLowerCase())
        || want.has(ariaLabelOf(n).toLowerCase());
      const is = n.getAttribute('aria-checked') === 'true' || n.getAttribute('aria-selected') === 'true';
      if (is !== on) { n.click(); await settle(); }
      const now = n.getAttribute('aria-checked') === 'true' || n.getAttribute('aria-selected') === 'true';
      if (now !== on) missed++;
    }
    const written = nodes.filter(n => n.getAttribute('aria-checked') === 'true' || n.getAttribute('aria-selected') === 'true')
      .map(n => optionValueOf(n));
    return { ok: missed === 0, written, display: nodes.filter(n => written.includes(optionValueOf(n))).map(ariaLabelOf).join(', ') };
  }

  /** [role=checkbox] / [role=switch] standing on its own: a yes/no. */
  async function writeAriaBoolean(el, value) {
    const want = value === true || value === 'true' || value === 'yes';
    const is = () => el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true';
    if (is() !== want) { el.click(); await settle(); }
    return { ok: is() === want, written: String(is()) };
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

  /**
   * Dispatch by field type. `els` may be one element or a group.
   *
   * Async since F4: a controlled input's revert and a custom listbox's opening
   * both happen a task later, and a write that is not verified after they have
   * had their chance is a claim, not a fact.
   */
  async function write(els, type, value) {
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

        // --- custom ARIA controls (F4.7) ---------------------------------
        case 'combobox': return await writeCombobox(el, value);
        case 'aria-radiogroup': return await writeAriaChoice(el, value);
        case 'aria-checkboxgroup': return await writeAriaMultiChoice(el, value);
        case 'aria-checkbox': return await writeAriaBoolean(el, value);

        case 'date': case 'time': case 'datetime-local': case 'month': case 'week': {
          // A native temporal input takes its own wire format, which is not the
          // session's ISO date for month/week/datetime-local.
          const want = formatForField(value, type, el);
          el.focus(); setNativeValue(el, want); notify(el);
          await settle();
          if (!holds(el, want)) { typeInto(el, significant(want) || want); await settle(); }
          el.blur();
          return { ok: holds(el, want), written: el.value };
        }
        default: {
          // A masked text field states its shape; the session holds the value
          // in one canonical shape per intent. Translate at the last moment.
          const want = formatForField(value, type, el);
          const written = await writeText(el, want);
          return { ok: holds(el, want), written };
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
      case 'combobox': {
        const box = listboxFor(el);
        const sel = box && box.querySelector('[role=option][aria-selected="true"]');
        if (sel) return ariaLabelOf(sel);
        const active = el.getAttribute('aria-activedescendant');
        const a = active && el.ownerDocument.getElementById(active);
        return a ? ariaLabelOf(a) : (el.value || ariaLabelOf(el) || null);
      }
      case 'aria-radiogroup': {
        const on = el.querySelector('[role=radio][aria-checked="true"],[role=option][aria-selected="true"]');
        return on ? ariaLabelOf(on) : null;
      }
      case 'aria-checkboxgroup':
        return Array.from(el.querySelectorAll('[role=checkbox][aria-checked="true"],[role=option][aria-selected="true"]'))
          .map(ariaLabelOf).join(', ') || null;
      case 'aria-checkbox':
        return el.getAttribute('aria-checked') === 'true' ? 'yes' : 'no';
      default: return el.value;
    }
  }

  /* ------------------------------- form-wide validation sweep (F4.3) ----- */

  /**
   * Every field the page is currently complaining about, in document order.
   *
   * Run after a submit, when a server or a form-level handler marks fields the
   * session has already left. It reports elements; the caller maps them back to
   * its own field ids and NAVIGATES there - nothing here decides where to go.
   */
  function findInvalid(elementsById) {
    const out = [];
    for (const [id, els] of Object.entries(elementsById || {})) {
      const el = Array.isArray(els) ? els[0] : els;
      if (!el || !el.isConnected) continue;
      const v = validate(els);
      if (!v.valid) out.push({ id, reason: v.reason, source: v.source });
    }
    return out;
  }

  return {
    write, validate, readCurrent, setNativeValue, typeInto, nearbyError,
    writeSelect, writeRadio, writeCheckboxGroup, writeBoolean, writeText,
    // F4: masks, format translation and the custom-control writers
    maskOf, applyMask, formatForField, looksLikeMask, dateMaskOrder, significant,
    writeCombobox, writeAriaChoice, writeAriaMultiChoice, writeAriaBoolean,
    listboxFor, ariaLabelOf, optionValueOf, findInvalid,
  };
})();
