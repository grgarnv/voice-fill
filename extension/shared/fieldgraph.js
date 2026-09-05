// FieldGraph - the DOM scanner (PRD F1.1 / F1.2).
//
// Loaded as a CLASSIC script, not a module: MV3 content_scripts have no ES
// module support, so the manifest injects this file ahead of content.js and the
// two share an isolated-world global. The same source is eval'd by the Node
// test harness against real Chrome via CDP, so there is exactly one
// implementation and no shim that can drift from what ships.
globalThis.VFFieldGraph = (() => {
  'use strict';

  const FIELD_SELECTOR = 'input,select,textarea,[contenteditable=""],[contenteditable="true"],[role=combobox],[role=radiogroup]';

  // Buttons are controls, not answerable fields. `hidden` never reaches a user.
  const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

  /**
   * An explicit role overrides the tag. Wikipedia's navigation is built from
   * <input type=checkbox role=button aria-haspopup=true> dropdown toggles: real
   * checkboxes in the DOM, pure UI chrome to a user. Without this the scanner
   * asks "Main menu? Say yes or no."
   *
   * `switch` is deliberately absent - that IS a real yes/no field.
   */
  const WIDGET_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'presentation', 'none', 'tooltip', 'separator']);

  function isWidgetNotField(el) {
    const role = (el.getAttribute && el.getAttribute('role') || '').toLowerCase().trim();
    if (role && WIDGET_ROLES.has(role)) return true;
    const hp = el.getAttribute && el.getAttribute('aria-haspopup');
    if (hp && hp !== 'false') return true;   // a disclosure toggle, not a question
    return false;
  }

  /** Cannot be answered: asking wastes the user's turn and they cannot comply. */
  function isUnanswerable(el) {
    // `.disabled` reflects the ATTRIBUTE only. A control inside
    // <fieldset disabled> is genuinely disabled but reports .disabled === false;
    // the :disabled pseudo-class is the one that accounts for the ancestor.
    try { if (el.matches && el.matches(':disabled')) return 'disabled'; } catch {}
    if (el.disabled) return 'disabled';
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return 'disabled';
    if (el.readOnly) return 'readonly';
    return null;
  }

  /* ---------------------------------------------------------------- utils -- */

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  /**
   * Strip the decorations that are punctuation on screen but noise in the ear:
   * required markers, trailing colons, parenthesised hints.
   */
  function normalizeLabel(raw) {
    let s = clean(raw)
      .replace(/[\u00a0\u200b]/g, ' ')
      .replace(/\(\s*(required|optional|mandatory)\s*\)/gi, '')
      .replace(/\b(required|optional)\b\s*$/i, '')
      .replace(/[*\u2217\u066d]+/g, '')
      .replace(/\s*[:：]\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    return s;
  }

  /**
   * Visibility. `offsetParent === null` is the cheap test the PRD names, but it
   * reports NULL FOR EVERY position:fixed ELEMENT, including plainly visible
   * ones - a sticky header search box would be dropped from the graph. So the
   * offsetParent result is only trusted after computed style rules out fixed,
   * and getClientRects() is the backstop.
   */
  /**
   * Ancestors hide their descendants in ways getComputedStyle(el) cannot see.
   * opacity does NOT inherit, so an input inside `opacity:0` reports opacity 1
   * on itself, and the 1px-overflow-hidden "sr-only" wrapper leaves the input's
   * own border box at full natural size. Both must be found by walking up.
   */
  function ancestorHides(el, win, { skipOwnOpacity = false } = {}) {
    let n = el, hops = 0;
    while (n && n.nodeType === 1 && hops < 24) {
      let cs;
      try { cs = win.getComputedStyle(n); } catch { return false; }
      if (cs) {
        const own = n === el;
        if (cs.opacity === '0' && !(own && skipOwnOpacity)) return true;
        if (!own) {
          // The sr-only / honeypot idiom: a 1px box with the overflow clipped.
          const r = n.getBoundingClientRect();
          const tiny = r.width <= 2 || r.height <= 2;
          if (tiny && (cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.overflowY === 'hidden')) return true;
          if (tiny && /inset\(\s*(50%|100%)/.test(cs.clipPath || '')) return true;
        }
      }
      n = n.parentElement; hops++;
    }
    return false;
  }

  /**
   * Visibility. `offsetParent === null` is the cheap test the PRD names, but it
   * reports NULL FOR EVERY position:fixed ELEMENT, including plainly visible
   * ones - a sticky header search box would be dropped from the graph. So the
   * offsetParent result is only trusted after computed style rules out fixed,
   * and getClientRects() is the backstop.
   *
   * Radios and checkboxes are exempted from the size and own-opacity rules: the
   * near-universal custom-control idiom is a 1px or opacity:0 input paired with
   * a styled visible label, and that input is a real, operable field.
   */
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.hidden) return false;
    if (el.type && SKIP_INPUT_TYPES.has(el.type)) return false;
    if (el.closest('[aria-hidden="true"]')) return false;

    const win = el.ownerDocument.defaultView || window;
    let cs;
    try { cs = win.getComputedStyle(el); } catch { return false; }
    if (!cs) return false;
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;

    const isTinyByDesign = el.type === 'radio' || el.type === 'checkbox';
    if (ancestorHides(el, win, { skipOwnOpacity: isTinyByDesign })) return false;

    const rects = el.getClientRects();
    if (rects.length === 0) return false;
    const r = el.getBoundingClientRect();
    if (!isTinyByDesign && (r.width === 0 || r.height === 0)) return false;

    if (cs.position !== 'fixed' && cs.position !== 'sticky' && el.offsetParent === null) return false;
    return true;
  }

  /* ------------------------------------------------------- shadow DOM walk -- */

  /**
   * Collect matches across open shadow roots. Closed roots are unreachable by
   * construction and are declared as a limitation, not worked around.
   */
  function deepQueryAll(root, selector, out = [], seen = new Set()) {
    if (!root || seen.has(root)) return out;
    seen.add(root);
    let nodes = [];
    try { nodes = Array.from(root.querySelectorAll(selector)); } catch { nodes = []; }
    for (const n of nodes) out.push(n);
    let all = [];
    try { all = Array.from(root.querySelectorAll('*')); } catch { all = []; }
    for (const el of all) if (el.shadowRoot) deepQueryAll(el.shadowRoot, selector, out, seen);
    return out;
  }

  /* -------------------------------------------------- label resolution F1.2 -- */

  function labelFromFor(el) {
    if (!el.id) return null;
    const doc = el.ownerDocument;
    let l = null;
    try {
      // CSS.escape guards ids containing ':' or '.', which are legal in HTML5
      // and common in Rails/Angular output - an unescaped selector throws and
      // would abort the whole scan.
      const esc = (doc.defaultView && doc.defaultView.CSS && doc.defaultView.CSS.escape)
        ? doc.defaultView.CSS.escape(el.id) : el.id.replace(/["\\]/g, '\\$&');
      l = doc.querySelector(`label[for="${esc}"]`);
    } catch { l = null; }
    if (!l) {
      // Fallback for exotic ids: linear scan by property, no selector parsing.
      const labels = doc.getElementsByTagName('label');
      for (const cand of labels) if (cand.htmlFor === el.id) { l = cand; break; }
    }
    return l ? labelText(l, el) : null;
  }

  function labelFromWrapping(el) {
    const l = el.closest('label');
    return l ? labelText(l, el) : null;
  }

  /** A wrapping <label> contains the control; its own value must not become its name. */
  function labelText(labelEl, controlEl) {
    const c = labelEl.cloneNode(true);
    c.querySelectorAll('input,select,textarea,button').forEach(n => n.remove());
    return normalizeLabel(c.textContent);
  }

  function labelFromAriaLabel(el) {
    return el.getAttribute && el.getAttribute('aria-label') ? normalizeLabel(el.getAttribute('aria-label')) : null;
  }

  function labelFromAriaLabelledBy(el) {
    const ids = (el.getAttribute && el.getAttribute('aria-labelledby')) || '';
    if (!ids.trim()) return null;
    const doc = el.ownerDocument;
    const parts = ids.trim().split(/\s+/)
      .map(id => { const n = doc.getElementById(id); return n ? clean(n.textContent) : ''; })
      .filter(Boolean);
    return parts.length ? normalizeLabel(parts.join(' ')) : null;
  }

  /**
   * Placeholders are used two ways: as a label ("Company name") and as a sample
   * of the expected VALUE ("name@example.com", "DD/MM/YYYY", "(555) 555-5555").
   * Speaking the second kind produces "What's your name at example dot com?",
   * so an example-shaped placeholder is rejected and the chain continues.
   */
  function looksLikeExampleValue(raw) {
    const t = (raw || '').trim();
    if (!t) return true;
    if (/^(e\.?g\.?|ex\.?|example|sample|enter|type)\b[:.\s]/i.test(t)) return true;
    if (/^[\w.+-]+@[\w-]+\.[a-z]{2,}$/i.test(t)) return true;          // an email sample
    if (/^https?:\/\//i.test(t)) return true;
    if (/^[\d\s()+\-.]{6,}$/.test(t)) return true;                     // a phone sample
    if (/^(dd|mm|yy|yyyy|hh)[\/\-. ]/i.test(t)) return true;           // DD/MM/YYYY
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return true;
    const letters = (t.match(/[a-z]/gi) || []).length;
    if (letters < Math.ceil(t.length / 3)) return true;                 // mostly punctuation
    return false;
  }

  function labelFromPlaceholder(el) {
    const p = (el.getAttribute && el.getAttribute('placeholder')) || '';
    if (!p.trim() || looksLikeExampleValue(p)) return null;
    return normalizeLabel(p);
  }

  /**
   * Last resort: the nearest text that visually precedes the control. Walks the
   * previous-sibling chain, then up to the parent, bounded so a whole page of
   * prose can never be adopted as one field's name.
   */
  /**
   * Is this node already spoken for as some OTHER field's name? A <label>, or
   * an element referenced by an aria-labelledby, belongs to a field that is not
   * this one. Adopting it announces the wrong question - the single worst
   * failure this product has, because the user cannot see that it is wrong.
   */
  function isConsumedAsAnotherLabel(node) {
    if (node.nodeType !== 1) return false;
    if (/^label$/i.test(node.tagName)) return true;
    if (node.querySelector && node.querySelector('label')) return true;
    if (node.id) {
      const doc = node.ownerDocument;
      try {
        const esc = (doc.defaultView && doc.defaultView.CSS && doc.defaultView.CSS.escape)
          ? doc.defaultView.CSS.escape(node.id) : node.id.replace(/["\\]/g, '\\$&');
        if (doc.querySelector(`[aria-labelledby~="${esc}"]`)) return true;
      } catch {}
    }
    return false;
  }

  const CONTROL_SEL = 'input,select,textarea,button,[contenteditable=""],[contenteditable="true"]';

  /**
   * Last resort: the nearest text that visually precedes the control. Walks the
   * previous-sibling chain, then up to the parent, and STOPS at the form
   * boundary - without that bound it will happily adopt the page's <h1>.
   *
   * Candidates are rejected if they contain a form control (that text labels
   * the other control, not this one) or are already another field's accessible
   * name.
   */
  function labelFromPrecedingText(el) {
    let node = el, hops = 0;
    while (node && hops < 5) {
      const parent = node.parentElement;
      let sib = node.previousSibling;
      while (sib) {
        if (sib.nodeType === 3) {
          const t = normalizeLabel(sib.textContent);
          if (t.length >= 2 && t.length <= 80) return t;
        } else if (sib.nodeType === 1) {
          const tag = sib.tagName.toLowerCase();
          const skip = /^(script|style|input|select|textarea|button|br|hr)$/.test(tag)
            || (sib.querySelector && sib.querySelector(CONTROL_SEL))
            || isConsumedAsAnotherLabel(sib);
          if (!skip) {
            const t = normalizeLabel(sib.textContent);
            if (t.length >= 2 && t.length <= 80) return t;
          }
        }
        sib = sib.previousSibling;
      }
      // Do not climb out of the form: beyond it lies page furniture, not labels.
      if (!parent || /^(form|body|html)$/i.test(parent.tagName)) return null;
      node = parent;
      hops++;
    }
    return null;
  }

  /** Group name for radios/checkboxes: the fieldset legend is the real question. */
  function labelFromFieldset(el) {
    const fs = el.closest('fieldset');
    if (!fs) return null;
    const lg = fs.querySelector('legend');
    return lg ? normalizeLabel(lg.textContent) : null;
  }

  /** The smallest ancestor holding more than one member of this control's group. */
  function groupContainer(el) {
    const name = el.name;
    if (!name) return null;
    let node = el.parentElement, hops = 0;
    while (node && hops < 6 && !/^(form|body|html)$/i.test(node.tagName)) {
      let count = 0, kids = [];
      try { kids = node.querySelectorAll('input'); } catch { kids = []; }
      for (const k of kids) if (k.name === name && k.type === el.type) count++;
      if (count > 1) return node;
      node = node.parentElement; hops++;
    }
    return null;
  }

  /**
   * The group's question, taken from the container's own leading text - the
   * text that sits before the options and is not inside any <label>.
   */
  function labelFromGroupContainerText(container) {
    if (!container) return null;
    for (const child of container.childNodes) {
      if (child.nodeType === 3) {
        const t = normalizeLabel(child.textContent);
        if (t.length >= 2 && t.length <= 100) return t;
      } else if (child.nodeType === 1) {
        const tag = child.tagName.toLowerCase();
        if (/^(script|style|input|select|textarea|button|br|hr|label)$/.test(tag)) continue;
        if (child.querySelector && child.querySelector(CONTROL_SEL)) continue;
        const t = normalizeLabel(child.textContent);
        if (t.length >= 2 && t.length <= 100) return t;
      }
    }
    return null;
  }

  function labelFromRoleGroup(el) {
    const rg = el.closest('[role=radiogroup],[role=group]');
    if (!rg) return null;
    return labelFromAriaLabel(rg) || labelFromAriaLabelledBy(rg);
  }

  /**
   * A humanised `name`/`id`. Reliable exactly when the attribute is wordy -
   * "date_of_birth" is a real question, "q1" is not.
   */
  function humanisedName(el) {
    const nm = (el.getAttribute && (el.getAttribute('name') || el.getAttribute('id'))) || '';
    if (!nm || !/[a-z]/i.test(nm)) return null;
    if (/^(field|input|q|item|txt|fld|ctl|elem)[-_]?\d*$/i.test(nm)) return null;
    const h = normalizeLabel(nm.replace(/[_\-.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'));
    return h.length >= 2 ? h : null;
  }

  /** Wordy enough to outrank the preceding-text guess. */
  function isWordyName(el) {
    const nm = (el.getAttribute && (el.getAttribute('name') || el.getAttribute('id'))) || '';
    if (!/[_\-.]/.test(nm) && !/[a-z][A-Z]/.test(nm)) return false;
    const h = humanisedName(el);
    return !!h && h.split(' ').filter(Boolean).length >= 2;
  }

  /**
   * PRD F1.2 priority, in order. `source` is returned alongside the text so the
   * test harness can assert WHICH rule fired, not merely that something did.
   *
   * For a GROUP the per-control rules are deliberately skipped: a radio's own
   * <label> is its OPTION's text, so running the normal chain names the group
   * after whichever option comes first - "Yes. Choose one: Yes, No."
   */
  function resolveLabel(el, { isGroup = false } = {}) {
    if (isGroup) {
      const groupChain = [
        ['fieldset-legend', () => labelFromFieldset(el)],
        ['role-group', () => labelFromRoleGroup(el)],
        ['group-container-text', () => labelFromGroupContainerText(groupContainer(el))],
        ['preceding-text', () => { const c = groupContainer(el); return c ? labelFromPrecedingText(c) : null; }],
        ['name-attr', () => humanisedName(el)],
      ];
      for (const [source, fn] of groupChain) {
        let v = null;
        try { v = fn(); } catch { v = null; }
        if (v) return { label: v, source };
      }
      return { label: null, source: 'unlabelled' };
    }

    const chain = [
      ['label-for', labelFromFor],
      ['label-wrap', labelFromWrapping],
      ['aria-label', labelFromAriaLabel],
      ['aria-labelledby', labelFromAriaLabelledBy],
      ['placeholder', labelFromPlaceholder],
      // A wordy name beats a guess at nearby prose; a terse one does not.
      ['name-attr', (e) => (isWordyName(e) ? humanisedName(e) : null)],
      ['preceding-text', labelFromPrecedingText],
      ['name-attr', humanisedName],
    ];
    for (const [source, fn] of chain) {
      let v = null;
      try { v = fn(el); } catch { v = null; }
      if (v) return { label: v, source };
    }
    return { label: null, source: 'unlabelled' };
  }

  /* ------------------------------------------------------------- field type -- */

  function fieldType(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') return el.multiple ? 'select-multiple' : 'select';
    if (tag === 'textarea') return 'textarea';
    if (el.getAttribute && el.getAttribute('role') === 'radiogroup') return 'radiogroup';
    if (el.getAttribute && el.getAttribute('role') === 'combobox') return 'combobox';
    if (el.isContentEditable) return 'contenteditable';
    if (tag === 'input') return (el.getAttribute('type') || 'text').toLowerCase();
    return tag;
  }

  const PLACEHOLDER_OPTION = /^\s*(-{2,}|\u2014)?\s*(please\s+)?(choose|select|pick|open this|make a selection|nothing selected|no selection)\b/i;

  function isPlaceholderOption(o) {
    if (o.value === '') return true;
    if (!o.selected) return false;
    if (o.hasAttribute && o.hasAttribute('value')) return false;   // authored as data
    return PLACEHOLDER_OPTION.test(clean(o.textContent));
  }

  function optionsOf(el, type) {
    if (type === 'select' || type === 'select-multiple') {
      return Array.from(el.options || [])
        .filter(o => !o.disabled)
        .filter(o => clean(o.textContent).length > 0)
        // Drop the leading placeholder option - it is a prompt, not a choice,
        // and reading it aloud offers "Please choose" as a valid answer.
        //
        // value="" is the clean idiom, but plenty of real forms write
        // <option selected>Open this select menu</option> with no value at all.
        // That needs three signals together before it is safe to discard:
        // first, selected, no explicit value attribute, and placeholder wording.
        .filter((o, i) => !(i === 0 && isPlaceholderOption(o)))
        .map(o => ({ value: o.value, text: clean(o.textContent) }));
    }
    return [];
  }

  /* ------------------------------------------------------------- ordering --- */

  /**
   * DOM order, then tab order (PRD F1.1). Positive tabindex genuinely reorders
   * keyboard traversal and therefore the order a form is meant to be answered
   * in; tabindex 0 / absent keeps document order.
   */
  function orderKey(el, domIndex) {
    const raw = el.getAttribute ? el.getAttribute('tabindex') : null;
    const ti = raw === null || raw === undefined ? NaN : parseInt(raw, 10);
    const positive = Number.isFinite(ti) && ti > 0;
    return { group: positive ? 0 : 1, tabindex: positive ? ti : 0, domIndex };
  }

  /* --------------------------------------------------------------- scan ----- */

  function stableKey(el, label, type, seenCounts) {
    const name = (el.getAttribute && (el.getAttribute('name') || el.getAttribute('id'))) || '';
    const base = `${type}|${name || (label || '').toLowerCase().slice(0, 40) || 'anon'}`;
    const n = (seenCounts.get(base) || 0) + 1;
    seenCounts.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  }

  /**
   * Build the FieldGraph.
   *
   * Returns plain serialisable records plus a parallel `elements` array - the
   * element itself can never cross chrome.runtime, and the session pointer is
   * held by stable key and element reference, never by index (PRD Phase 1:
   * SPA remounts renumber indices).
   */
  function scan(root = document) {
    const raw = deepQueryAll(root, FIELD_SELECTOR);

    // Deduplicate: a [role=combobox] that is also an <input> matches twice.
    const uniq = [];
    const seenEl = new Set();
    for (const el of raw) { if (!seenEl.has(el)) { seenEl.add(el); uniq.push(el); } }

    const domIndex = new Map();
    uniq.forEach((el, i) => domIndex.set(el, i));

    const fields = [];
    const elements = [];
    const radioGroups = new Map();
    const checkboxGroups = new Map();
    const seenCounts = new Map();
    let skipped = { hidden: 0, button: 0, dup: 0, widget: 0, disabled: 0, readonly: 0 };

    for (const el of uniq) {
      const type = fieldType(el);

      if (el.tagName.toLowerCase() === 'input' && SKIP_INPUT_TYPES.has(type)) { skipped.button++; continue; }
      if (isWidgetNotField(el)) { skipped.widget++; continue; }
      const blocked = isUnanswerable(el);
      if (blocked) { skipped[blocked]++; continue; }
      if (!isVisible(el)) { skipped.hidden++; continue; }

      // --- radios collapse into ONE question with options -------------------
      if (type === 'radio') {
        const gname = el.name || `__anon_${domIndex.get(el)}`;
        if (radioGroups.has(gname)) {
          const g = radioGroups.get(gname);
          g.options.push({ value: el.value, text: radioOptionText(el) });
          g.els.push(el);
          skipped.dup++;
          continue;
        }
        const { label, source } = resolveLabel(el, { isGroup: true });
        const g = {
          type: 'radiogroup', name: gname, el, els: [el],
          label, labelSource: source,
          options: [{ value: el.value, text: radioOptionText(el) }],
          domIndex: domIndex.get(el),
        };
        radioGroups.set(gname, g);
        fields.push(g); elements.push(el);
        continue;
      }

      // --- same-name checkboxes collapse into one multi-select --------------
      if (type === 'checkbox' && el.name && countSameName(uniq, el) > 1) {
        const gname = el.name;
        if (checkboxGroups.has(gname)) {
          const g = checkboxGroups.get(gname);
          g.options.push({ value: el.value, text: radioOptionText(el) });
          g.els.push(el);
          skipped.dup++;
          continue;
        }
        const { label, source } = resolveLabel(el, { isGroup: true });
        const g = {
          type: 'checkboxgroup', name: gname, el, els: [el],
          label, labelSource: source,
          options: [{ value: el.value, text: radioOptionText(el) }],
          domIndex: domIndex.get(el),
        };
        checkboxGroups.set(gname, g);
        fields.push(g); elements.push(el);
        continue;
      }

      const { label, source } = resolveLabel(el);
      fields.push({
        type, name: el.name || '', el, els: [el],
        label, labelSource: source,
        options: optionsOf(el, type),
        domIndex: domIndex.get(el),
      });
      elements.push(el);
    }

    // Order, then assign stable keys in the order the user will meet them.
    const withOrder = fields.map(f => ({ f, k: orderKey(f.el, f.domIndex) }));
    withOrder.sort((a, b) =>
      a.k.group - b.k.group || a.k.tabindex - b.k.tabindex || a.k.domIndex - b.k.domIndex);

    const out = [];
    const outEls = [];
    withOrder.forEach(({ f }, i) => {
      const required = !!(f.el.required || f.el.getAttribute('aria-required') === 'true');
      const key = stableKey(f.el, f.label, f.type, seenCounts);
      out.push({
        id: key,
        index: i,
        label: f.label,
        labelSource: f.labelSource,
        type: f.type,
        name: f.name,
        required,
        options: f.options,
        visible: true,
        dependsOn: null,          // populated on dynamic rescan (F4.1 does the real work)
        optionCount: f.options.length,
      });
      outEls.push(f.els.length > 1 ? f.els : f.el);
    });

    return { fields: out, elements: outEls, skipped, scannedAt: Date.now() };
  }

  /** The visible text for one radio/checkbox option. */
  function radioOptionText(el) {
    const viaFor = labelFromFor(el);
    if (viaFor) return viaFor;
    const wrap = labelFromWrapping(el);
    if (wrap) return wrap;
    const aria = labelFromAriaLabel(el);
    if (aria) return aria;
    const t = labelFromPrecedingText(el);
    if (t) return t;
    return clean(el.value) || '(unnamed option)';
  }

  function countSameName(list, el) {
    let n = 0;
    for (const o of list) if (o.name === el.name && o.type === el.type) n++;
    return n;
  }

  return {
    scan, resolveLabel, isVisible, normalizeLabel, fieldType,
    deepQueryAll, FIELD_SELECTOR, looksLikeExampleValue, isWidgetNotField, isUnanswerable,
  };
})();
