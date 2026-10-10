/**
 * phone.js: phone access in the Apaki window (Track B part 2, 2026-10-09;
 * Arthur: "scan this QR code" connects a phone to the Apaki on your PC).
 *
 * The Phone button sits in the sidebar footer beside the theme and ding
 * switches. It opens a sheet with:
 *   - whether phone access is on, and the relay it goes through;
 *   - Pair a phone: a QR code (rendered here, offline, by the vendored MIT
 *     encoder in vendor/qrcode.js) with its expiry countdown;
 *   - the approval step when a phone scanned it: "<name> wants to connect",
 *     the 6-digit code both screens show, Allow / Deny;
 *   - the paired phones, which one is connected now, and Remove.
 *
 * The engine does the work (apaki/engine/remote.js): this file sends the
 * remote* ops and draws ev 'remote'. The phone's name comes from the phone,
 * so it is always escaped. The QR address holds a one-time secret: it is only
 * drawn, never logged or put in the page text.
 *
 * Connected is shown by the phone glyph's screen lighting up and by the
 * words "Connected now", never by a dot in a pill.
 */

import qrcode from './vendor/qrcode.js';
import { esc } from './markdown.js';

const PAIR_HINT = 'Shows a code your phone\'s camera opens. It works once, for two minutes.';

/** The phone glyph: its screen lights up while that phone is connected. */
export function phoneGlyph(lit = false, cls = '') {
  return `<svg viewBox="0 0 16 16" class="ph-glyph${lit ? ' lit' : ''}${cls ? ` ${cls}` : ''}" aria-hidden="true"><rect class="ph-body" x="3.8" y="1.2" width="8.4" height="13.6" rx="2.1"/><rect class="ph-screen" x="5.3" y="3" width="5.4" height="8.6" rx=".9"/><path class="ph-home" d="M7 13.2h2"/></svg>`;
}

/** A QR code as an SVG (dark modules on a white tile, 4-module quiet zone, crisp edges). */
export function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const q = 4;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + q} ${r + q}h1v1h-1z`;
  }
  const size = n + q * 2;
  return `<svg viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="Pairing code for your phone's camera"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#14121F"/></svg>`;
}

function ago(iso) {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const day = (iso) => { const t = Date.parse(iso || ''); return t ? new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' }) : ''; };

const STATE_TEXT = {
  off: ['Off', 'Phones you paired cannot reach this PC until you turn this on.'],
  unconfigured: ['Not set up', 'The Apaki relay is not deployed yet, so a phone has no way to reach this PC. Phone access starts working once it is (to try a local relay, start Apaki with APAKI_RELAY_URL set).'],
  connecting: ['Connecting', 'Reaching the relay…'],
  online: ['On', 'Reachable through the relay. Nothing listens on this PC: Apaki keeps one outgoing connection.'],
  offline: ['Offline', 'The relay is not answering.'],
  replaced: ['Paused', ''],
  error: ['Problem', ''],
};

/**
 * Wires the Phone button and returns { handle(ev), open(), refresh() }.
 * @param {object} o
 * @param {(op: string, args?: object) => any} o.send  sends an engine command
 * @param {(html: string, wire: Function) => void} o.sheet  Apaki's sheet (one at a time, queued)
 * @param {(kind: string) => void} [o.ding]
 * @param {HTMLElement} o.button
 */
export function initPhone({ send, sheet, ding = () => {}, button }) {
  let st = null;
  let root = null;
  let closeIt = null;
  let queued = false;
  let tick = null;
  let paired = null;
  let confirmRemove = null;

  function renderButton() {
    if (!button) return;
    const live = (st?.devices || []).filter((d) => d.connected);
    const on = Boolean(st?.enabled && st.state === 'online');
    button.classList.toggle('on', on);
    button.classList.toggle('live', live.length > 0);
    button.innerHTML = `${phoneGlyph(live.length > 0)}<span>Phone</span>${live.length > 1 ? `<span class="ph-n">${live.length}</span>` : ''}`;
    button.title = live.length ? `${live.map((d) => d.name).join(', ')} connected` : st?.enabled ? 'Phone access is on' : 'Use Apaki from your phone';
  }

  function stopTick() {
    clearInterval(tick);
    tick = null;
  }

  /** The countdown under the QR, updated in place once a second while it shows. */
  function startTick() {
    stopTick();
    tick = setInterval(() => {
      const el = root?.querySelector('.ph-count .mono');
      if (!el || !st?.pairing) { stopTick(); return; }
      const left = Math.round(st.pairing.exp - Date.now() / 1000);
      if (left <= 0) { stopTick(); render(); return; }
      el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    }, 1000);
  }

  function pairBlock() {
    if (!st?.enabled || !st.relayConfigured) return '';
    if (st.request) {
      const code = String(st.request.sas || '');
      return `<div class="ph-sas" data-sas="${esc(code)}">
        <div class="ph-step"><b>${esc(st.request.name || 'A phone')}</b> wants to connect</div>
        <div class="ph-code" aria-label="Code ${esc(code.split('').join(' '))}"><span>${esc(code.slice(0, 3))}</span><span>${esc(code.slice(3))}</span></div>
        <p>Allow it only if your phone shows the same code. It can then use the Claude Code sessions on this PC, billed to this PC's accounts.</p>
        <div class="ph-actions"><button data-k="deny">Deny</button><button class="primary" data-k="allow">Allow</button></div>
      </div>`;
    }
    const p = st.pairing;
    const left = p ? Math.round(p.exp - Date.now() / 1000) : 0;
    if (p && left > 0) {
      return `<div class="ph-qr-wrap">
        <div class="ph-qr">${qrSvg(p.url)}</div>
        <div class="ph-qr-side">
          <div class="ph-step">Scan with your phone's camera</div>
          <p>It opens Apaki in the phone's browser and asks this PC to connect. You confirm a code here next.</p>
          <div class="ph-count"><span class="mono">${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</span> left · works once</div>
          <div class="ph-actions"><button data-k="cancelpair">Cancel</button><button data-k="newcode">New code</button></div>
        </div>
      </div>`;
    }
    const done = paired && Date.now() - paired.at < 15000 ? `<div class="ph-done"><b>${esc(paired.name)}</b> is paired. It stays connected while this sheet is closed.</div>` : '';
    return `${done}<div class="ph-start"><button class="primary" data-k="pair">${p ? 'Show a new code' : 'Pair a phone'}</button><span>${p ? 'That code expired.' : PAIR_HINT}</span></div>`;
  }

  function devicesBlock() {
    const list = st?.devices || [];
    const rows = list.map((d) => {
      const meta = d.connected
        ? `<span class="ph-live">Connected now</span>${d.panes ? ` · ${d.panes} conversation${d.panes === 1 ? '' : 's'} open` : ''}`
        : `Last seen ${esc(ago(d.lastSeen) || 'never')}${d.pairedAt ? ` · paired ${esc(day(d.pairedAt))}` : ''}`;
      const sure = confirmRemove === d.id;
      return `<li class="ph-dev${d.connected ? ' live' : ''}">${phoneGlyph(d.connected)}<div class="ph-dev-t"><div class="ph-dev-n">${esc(d.name || 'Phone')}</div><div class="ph-dev-m">${meta}</div></div><button class="ph-remove${sure ? ' sure' : ''}" data-k="revoke" data-id="${esc(d.id)}">${sure ? 'Remove for good' : 'Remove'}</button></li>`;
    }).join('');
    return `<div class="ph-devices"><div class="ph-sec"><span>Paired phones</span><span class="ph-sec-n">${list.length || ''}</span></div>${list.length ? `<ul>${rows}</ul>` : '<p class="ph-empty">No phones yet.</p>'}</div>`;
  }

  function render() {
    if (!root) return;
    const s = st || { state: 'off', enabled: false, devices: [] };
    const [label, line] = STATE_TEXT[s.state] || ['', ''];
    let detail = s.error || line;
    if (s.state === 'online' && s.relay) detail = `Reachable through ${s.relay}. Nothing listens on this PC: Apaki keeps one outgoing connection.`;
    if (s.state === 'connecting' && s.relay) detail = `Reaching ${s.relay}…`;
    if (s.state === 'offline' && s.retryInMs != null) detail = `${s.error ? `${s.error} ` : `${s.relay || 'The relay'} is not answering. `}Trying again in ${Math.max(1, Math.round(s.retryInMs / 1000))} s.`;
    const toggle = s.relayConfigured === false && !s.enabled ? '' : `<button data-k="toggle"${s.enabled ? '' : ' class="primary"'}>${s.enabled ? 'Turn off' : 'Turn on'}</button>`;
    const keys = s.protection === 'dpapi' ? 'Keys on this PC are sealed with Windows DPAPI for your account.' : s.protection === 'file' ? 'Keys on this PC are in a file only your account can read.' : '';
    root.innerHTML = `<div class="phone-sheet">
      <div class="ph-head"><div class="ph-kicker">Phone</div><h2>Apaki on your phone</h2>
        <p>Pair a phone once with a code. After that it reaches this PC from anywhere, end to end encrypted: the relay only forwards sealed frames, and your Claude logins never leave this PC.</p></div>
      <div class="ph-status" data-state="${esc(s.state)}"><div class="ph-status-t"><span class="ph-state">${esc(label)}</span><span class="ph-line">${esc(detail)}</span></div>${toggle}</div>
      ${s.opError ? `<div class="ph-err">${esc(s.opError)}</div>` : ''}
      ${pairBlock()}
      ${devicesBlock()}
      <div class="ph-foot"><span class="ph-keys">${esc(keys)}</span><button data-k="done">Done</button></div>
    </div>`;
    wire();
    if (s.pairing && !s.request) startTick(); else stopTick();
  }

  function wire() {
    const on = (k, fn) => root.querySelectorAll(`[data-k="${k}"]`).forEach((b) => { b.onclick = () => fn(b); });
    on('toggle', () => send(st?.enabled ? 'remoteDisable' : 'remoteEnable'));
    on('pair', () => send('remotePairStart'));
    on('newcode', () => send('remotePairStart'));
    on('cancelpair', () => send('remotePairCancel'));
    on('allow', () => send('remotePairDecision', { approve: true }));
    on('deny', () => send('remotePairDecision', { approve: false }));
    on('revoke', (b) => {
      const id = b.dataset.id;
      if (confirmRemove !== id) {
        // Two steps instead of a dialog: the first click asks, the second removes.
        confirmRemove = id;
        render();
        setTimeout(() => { if (confirmRemove === id) { confirmRemove = null; render(); } }, 4000);
        return;
      }
      confirmRemove = null;
      send('remoteRevoke', { deviceId: id });
    });
    on('done', () => closeIt?.());
  }

  function open() {
    if (root || queued) return;
    queued = true;
    sheet('', (el, close) => {
      queued = false;
      root = el;
      root.classList.add('phone-mode');
      closeIt = () => {
        stopTick();
        el.classList.remove('phone-mode');
        root = null;
        closeIt = null;
        close();
      };
      render();
    });
    send('remoteStatus');
  }

  function handle(e) {
    const wasRequest = Boolean(st?.request);
    st = e;
    if (e.paired) paired = { name: e.paired.name, at: Date.now() };
    if (e.request && !wasRequest) {
      // A phone scanned the code: the approval cannot wait for someone to open the sheet.
      ding('ask');
      open();
    }
    renderButton();
    render();
  }

  if (button) button.onclick = open;
  renderButton();
  send('remoteStatus');
  // For apaki/scripts (CDP checks): the last status, read only.
  window.__apakiPhone = { status: () => st, open };
  return { handle, open, refresh: () => send('remoteStatus') };
}
