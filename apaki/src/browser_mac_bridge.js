// browser_mac_bridge.js: the page-side half of Myrlin Apaki's built-in browser on macOS.
//
// WHY (Arthur, 2026-10-13, macOS port phase 2): on Windows the engine drives its browser over WebView2's DevTools
// protocol. WKWebView has no such channel, so src/browser_mac.rs answers the few protocol calls the engine makes
// (apaki/engine/browser-tools.js) itself, and what a protocol call would do INSIDE the page is done by this script:
// real-looking mouse clicks, typing and key presses that work without taking the keyboard away from Apaki's own window.
//
// It is evaluated by browser_mac.rs in an isolated WKContentWorld named "apaki", the same world the engine's page
// library (browser-page.js, window.__apaki) lives in, so the page's own scripts can neither see nor change it. DOM
// events it dispatches still reach the page's listeners, as any script's events do.
//
// browser_mac.rs runs `const m = (<this file>)(); return JSON.stringify(m.<function>(...))`. Safe to run again: it keeps one object on
// window.__apakiMac, versioned, and reuses it.
(function () {
  const VERSION = 1;
  const old = window.__apakiMac;
  if (old && old.v === VERSION) return old;
  const M = { v: VERSION, down: null, over: null };

  /** The element that has the keyboard, looking into open shadow roots and same-origin frames. */
  const deepActive = () => {
    let a = document.activeElement;
    for (let i = 0; i < 8 && a; i++) {
      if (a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
      if (a.tagName === 'IFRAME' || a.tagName === 'FRAME') {
        try {
          const inner = a.contentDocument && a.contentDocument.activeElement;
          if (inner && inner !== a.contentDocument.body) { a = inner; continue; }
        } catch (e) { /* another origin */ }
      }
      break;
    }
    return a;
  };

  /** The element under a point, looking into open shadow roots and same-origin frames; x and y become that frame's own. */
  const at = (x, y) => {
    let el = document.elementFromPoint(x, y);
    for (let i = 0; i < 8 && el; i++) {
      if (el.shadowRoot) {
        const n = el.shadowRoot.elementFromPoint(x, y);
        if (n && n !== el) { el = n; continue; }
      }
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        try {
          const r = el.getBoundingClientRect();
          const dx = x - r.left - el.clientLeft;
          const dy = y - r.top - el.clientTop;
          const n = el.contentDocument && el.contentDocument.elementFromPoint(dx, dy);
          if (n) { x = dx; y = dy; el = n; continue; }
        } catch (e) { /* another origin */ }
      }
      break;
    }
    return { el, x, y };
  };

  const FOCUSABLE = 'a[href], button, input:not([type=hidden]), select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable=true]';
  const focusTarget = (el) => {
    for (let n = el; n; n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null) {
      if (n.matches && n.matches(FOCUSABLE) && !n.disabled) return n;
    }
    return null;
  };

  /**
   * One mouse event of a click sequence at a viewport point. type: mouseMoved, mousePressed, mouseReleased (the names
   * the engine uses). Pointer and mouse events, focus the way a click moves it, and the click itself on release.
   */
  M.mouse = (type, x, y, button, clicks) => {
    const hit = at(x, y);
    const el = hit.el;
    if (!el) return { hit: false };
    const win = el.ownerDocument.defaultView || window;
    const base = (extra) => Object.assign({ bubbles: true, cancelable: true, composed: true, view: win, clientX: hit.x, clientY: hit.y, screenX: hit.x, screenY: hit.y, button: 0, buttons: 0, detail: 0 }, extra);
    const mouse = (name, extra) => new win.MouseEvent(name, base(extra));
    const pointer = (name, extra) => (win.PointerEvent ? new win.PointerEvent(name, Object.assign(base(extra), { pointerId: 1, pointerType: 'mouse', isPrimary: true })) : mouse(name, extra));
    const n = Math.max(1, Number(clicks) || 1);
    if (type === 'mouseMoved') {
      const prev = M.over && M.over.isConnected ? M.over : null;
      if (prev !== el) {
        if (prev) { prev.dispatchEvent(pointer('pointerout')); prev.dispatchEvent(mouse('mouseout', { relatedTarget: el })); }
        el.dispatchEvent(pointer('pointerover')); el.dispatchEvent(mouse('mouseover', { relatedTarget: prev }));
        M.over = el;
      }
      el.dispatchEvent(pointer('pointermove')); el.dispatchEvent(mouse('mousemove'));
      return { hit: true };
    }
    if (type === 'mousePressed') {
      M.down = el;
      el.dispatchEvent(pointer('pointerdown', { buttons: 1 }));
      const go = el.dispatchEvent(mouse('mousedown', { buttons: 1, detail: n }));
      if (go) {
        // A click moves the focus to the nearest focusable element, or takes it from the one that had it.
        const f = focusTarget(el);
        if (f && typeof f.focus === 'function') f.focus({ preventScroll: true });
        else if (document.activeElement && document.activeElement !== document.body && typeof document.activeElement.blur === 'function') document.activeElement.blur();
      }
      return { hit: true };
    }
    if (type === 'mouseReleased') {
      el.dispatchEvent(pointer('pointerup'));
      el.dispatchEvent(mouse('mouseup', { detail: n }));
      const down = M.down;
      M.down = null;
      if (down && down.isConnected && (down === el || down.contains(el) || el.contains(down))) {
        // The click goes to the outer of the two when the press and the release were on parent and child.
        const target = down === el || down.contains(el) ? down : el;
        target.dispatchEvent(mouse('click', { detail: n }));
        if (n === 2) target.dispatchEvent(mouse('dblclick', { detail: n }));
      }
      return { hit: true };
    }
    return { hit: false, error: 'unknown mouse event ' + type };
  };

  /** Text typed where the keyboard is (the field the engine just focused and selected). */
  M.insertText = (text) => {
    const el = deepActive();
    const doc = el ? el.ownerDocument : document;
    let ok = false;
    try { ok = doc.execCommand('insertText', false, String(text)); } catch (e) { ok = false; }
    if (!ok && el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.setRangeText === 'function') {
      try {
        const s = el.selectionStart == null ? el.value.length : el.selectionStart;
        const e = el.selectionEnd == null ? el.value.length : el.selectionEnd;
        el.setRangeText(String(text), s, e, 'end');
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(text), inputType: 'insertText' }));
        ok = true;
      } catch (e) { ok = false; }
    }
    return { ok };
  };

  const NOT_TEXT = ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'color', 'range'];

  /**
   * A key press as the engine sends it: keyDown does the whole press (events first, then what the key does when the
   * page allowed it), keyUp only the keyup event. Enter submits the form of a text field, adds a line in a textarea,
   * a paragraph in an editable region and clicks a button or link; Delete and Backspace delete the selection or one
   * character; a key with text types it.
   */
  M.key = (phase, key, code, vk, text) => {
    const el = deepActive() || document.body;
    const win = el.ownerDocument.defaultView || window;
    const doc = el.ownerDocument;
    const init = { key, code: code || key, keyCode: vk || 0, which: vk || 0, bubbles: true, cancelable: true, composed: true, view: win };
    if (phase === 'keyUp') { el.dispatchEvent(new win.KeyboardEvent('keyup', init)); return { ok: true }; }
    const go = el.dispatchEvent(new win.KeyboardEvent('keydown', init));
    if (!go) return { ok: true, prevented: true };
    const tag = el.tagName;
    if (key === 'Enter') {
      el.dispatchEvent(new win.KeyboardEvent('keypress', Object.assign({}, init, { charCode: 13, keyCode: 13, which: 13 })));
      if (tag === 'TEXTAREA') { if (!doc.execCommand('insertLineBreak')) doc.execCommand('insertText', false, '\n'); }
      else if (el.isContentEditable) doc.execCommand('insertParagraph');
      else if (tag === 'INPUT' && !NOT_TEXT.includes(String(el.type).toLowerCase())) {
        const f = el.form;
        if (f) { if (typeof f.requestSubmit === 'function') f.requestSubmit(); else f.submit(); }
      } else if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY' || tag === 'INPUT' || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link') el.click();
    } else if (key === 'Delete' || key === 'Backspace') {
      doc.execCommand(key === 'Delete' ? 'forwardDelete' : 'delete');
    } else if (text) {
      M.insertText(text);
    }
    return { ok: true };
  };

  window.__apakiMac = M;
  return M;
})
