/**
 * cursor.mjs: the on-screen pointer for the demo harness.
 *
 * A screen recording of a browser page has no mouse pointer, so the harness
 * draws one: an arrow that follows the real (Playwright driven) mouse events,
 * dips on press, and rings a ripple at each click. Hidden with
 * document.body.classList.add('demo-nocursor') for stills that should not
 * show it.
 */

const ARROW = '<svg viewBox="0 0 26 26" width="26" height="26" aria-hidden="true"><path d="M4 3 L4 21 L8.6 16.9 L11.7 23.4 L14.6 22.1 L11.5 15.8 L17.6 15.8 Z" fill="#ffffff" stroke="#14121f" stroke-width="1.5" stroke-linejoin="round"/></svg>';

export function installCursor() {
  const cur = document.createElement('div');
  cur.id = 'demo-cursor';
  cur.innerHTML = ARROW;
  document.body.append(cur);
  const move = (e) => { cur.style.transform = `translate(${e.clientX - 4}px, ${e.clientY - 3}px)`; };
  window.addEventListener('mousemove', move, { capture: true, passive: true });
  window.addEventListener('mousedown', (e) => {
    move(e);
    cur.classList.add('down');
    const r = document.createElement('div');
    r.className = 'demo-ripple';
    r.style.left = `${e.clientX}px`;
    r.style.top = `${e.clientY}px`;
    document.body.append(r);
    setTimeout(() => r.remove(), 700);
  }, { capture: true, passive: true });
  window.addEventListener('mouseup', () => cur.classList.remove('down'), { capture: true, passive: true });
  return cur;
}
