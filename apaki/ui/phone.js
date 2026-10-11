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
 *   - (2026-10-10) how long a phone stays paired: Forever by default, or
 *     30, 7 or 1 days, chosen beside Allow; each paired phone says when it
 *     expires (or that it never does) and the time can be changed there.
 *     Start over shows only when the PC's saved keys cannot be opened.
 *   - (2026-10-10, apaki/SECURITY.md 4.4 item 5) Connected or Private: the
 *     mode switch (Connected is the default, Arthur's call; Private turns
 *     Apaki accounts away, offering to remove the ones linked); what each
 *     phone may make Claude do (Full, No shell, Chat only), chosen beside
 *     Allow and changeable on each phone; the card for an Apaki account a
 *     phone asks to link (nothing is added without Allow here); no code
 *     when the phone page cannot be checked, with "Pair without checking
 *     the page" saying what it risks; and why phone access went off when
 *     the hourly page check found a change.
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

/** What each access lets a phone do, as the Allow card and each phone's row say it (remote-policy.js CAPS). */
const CAPS = ['full', 'noshell', 'chat'];
const CAP_LABEL = { full: 'Full', noshell: 'No shell', chat: 'Chat only' };
const CAP_TEXT = {
  full: 'It can then run Claude Code on this PC, including commands and file edits, and read its conversations, billed to this PC\'s accounts.',
  noshell: 'It can then use Claude Code on this PC to read its conversations, search and answer, but Claude cannot run commands, edit files or use the browser for it. Billed to this PC\'s accounts.',
  chat: 'It can then read this PC\'s conversations and chat with Claude Code in plan mode only: nothing runs and nothing changes. Billed to this PC\'s accounts.',
};

/** The access switch (Apaki's .seg): on is the chosen access. */
function capSeg(on, k, id = '', caps = CAPS) {
  const opt = (v) => `<button type="button" role="radio" aria-checked="${on === v}" class="${on === v ? 'on' : ''}" data-k="${k}" data-cap="${v}"${id ? ` data-id="${esc(id)}"` : ''}>${CAP_LABEL[v] || esc(v)}</button>`;
  return `<div class="seg ph-cap" role="radiogroup" aria-label="What it may make Claude do">${caps.map(opt).join('')}</div>`;
}

/** The host of an address, for the sheet's words. */
const hostIn = (url, fallback = 'apaki.myrlin.io') => { try { return new URL(url).host || fallback; } catch { return fallback; } };

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

/** The lifetimes besides forever, in days (the engine's list when it sends one). */
const LIFETIMES = [30, 7, 1];

/** When a pairing runs out, in words: "never expires", "expires in 6 days", "expires in 5 h". */
function lifeText(iso) {
  const t = Date.parse(iso || '');
  if (!t) return 'never expires';
  const s = (t - Date.now()) / 1000;
  if (s <= 0) return 'expired';
  if (s < 3600) return 'expires within the hour';
  if (s < 86400 * 1.5) return `expires in ${Math.round(s / 3600)} h`;
  return `expires in ${Math.round(s / 86400)} days`;
}

/** The lifetime switch (Apaki's .seg): Forever, then each limit. on: the chosen value ('' is forever, null none). */
function lifeSeg(on, k, id = '', days = LIFETIMES) {
  const opt = (v, label) => `<button type="button" role="radio" aria-checked="${on === v}" class="${on === v ? 'on' : ''}" data-k="${k}" data-life="${v}"${id ? ` data-id="${esc(id)}"` : ''}>${label}</button>`;
  return `<div class="seg ph-life" role="radiogroup" aria-label="How long it stays paired">${opt('', 'Forever')}${days.map((d) => opt(String(d), `${d} day${d === 1 ? '' : 's'}`)).join('')}</div>`;
}

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
  // The lifetime chosen for the phone waiting at Allow ('' is forever), the phone whose lifetime row is open, and Start over's second step.
  let life = '';
  let editLife = null;
  let confirmReset = false;
  // 2026-10-10: the access chosen at Allow, the phone whose access row is open, the account card's choices, and the Private step.
  let cap = 'full';
  let editCap = null;
  let linkCap = null;
  let linkLife = '';
  let toPrivate = false;
  const days = () => (Array.isArray(st?.lifetimes) && st.lifetimes.length ? st.lifetimes : LIFETIMES);

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
        <p>Allow it only if your phone shows the same code. ${CAP_TEXT[cap] || CAP_TEXT.full}</p>
        <div class="ph-life-row"><span>It may</span>${capSeg(cap, 'cap-pick')}</div>
        <div class="ph-life-row"><span>Stays paired</span>${lifeSeg(life, 'life-pick', '', days())}</div>
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
          ${p.unchecked ? '<p class="ph-warn">Not checked: you chose to pair without checking the phone page.</p>' : ''}
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
      // An Apaki account (ACCOUNTS.md): any phone signed in to it connects as this one device.
      const acct = d.kind === 'account';
      const via = acct && d.via?.length ? ` from ${esc(d.via.join(', '))}` : '';
      const meta = d.connected
        ? `<span class="ph-live">Connected now${via}</span>${d.panes ? ` · ${d.panes} conversation${d.panes === 1 ? '' : 's'} open` : ''}`
        : `Last seen ${esc(ago(d.lastSeen) || 'never')}${acct && d.by ? ` · linked from ${esc(d.by)}` : d.pairedAt ? ` · paired ${esc(day(d.pairedAt))}` : ''}`;
      // How long it stays paired: a quiet link that opens the same switch as at Allow (counted from now).
      const editing = editLife === d.id;
      const lifeLink = ` · <button type="button" class="ph-life-btn" data-k="life-edit" data-id="${esc(d.id)}" aria-expanded="${editing}" title="Change how long it stays paired">${esc(lifeText(d.expiresAt))}</button>`;
      const lifeRow = editing ? lifeSeg(d.expiresAt ? null : '', 'life-set', d.id, days()) : '';
      // What it may make Claude do: the same quiet link, opening the access switch (applies at once).
      const dcap = d.cap || 'full';
      const capLink = ` · <button type="button" class="ph-life-btn" data-k="cap-edit" data-id="${esc(d.id)}" aria-expanded="${editCap === d.id}" title="Change what it may make Claude do">${esc(CAP_LABEL[dcap] || dcap)}</button>`;
      const capRow = editCap === d.id ? capSeg(dcap, 'cap-set', d.id, st?.caps || CAPS) : '';
      const paused = acct && d.paused ? ' · <span class="ph-paused">Paused: Private mode</span>' : '';
      const sure = confirmRemove === d.id;
      const title = acct ? `Removes the account from this PC: every phone signed in to ${d.account || 'it'} stops reaching it` : 'Removes this phone: it can never reconnect';
      return `<li class="ph-dev${d.connected ? ' live' : ''}${acct ? ' acct' : ''}">${phoneGlyph(d.connected)}<div class="ph-dev-t"><div class="ph-dev-n">${esc(d.name || 'Phone')}</div><div class="ph-dev-m">${meta}${paused}${capLink}${lifeLink}</div>${capRow}${lifeRow}</div><button class="ph-remove${sure ? ' sure' : ''}" data-k="revoke" data-id="${esc(d.id)}" title="${esc(title)}">${sure ? 'Remove for good' : 'Remove'}</button></li>`;
    }).join('');
    const heading = list.some((d) => d.kind === 'account') ? 'Paired phones and accounts' : 'Paired phones';
    // Connected and no account yet: how to reach this PC from any device (Arthur, 2026-10-10).
    const hint = st?.mode === 'connected' && !list.some((d) => d.kind === 'account') ? `<p class="ph-hint">Sign in at ${esc(hostIn(st?.web))} on your phone to reach this PC from any device.</p>` : '';
    return `<div class="ph-devices"><div class="ph-sec"><span>${heading}</span><span class="ph-sec-n">${list.length || ''}</span></div>${list.length ? `<ul>${rows}</ul>` : '<p class="ph-empty">No phones yet.</p>'}${hint}</div>`;
  }

  /** Connected or Private, what each means, and the step that offers to remove linked accounts. */
  function modeBlock() {
    const s = st || {};
    if (!s.mode) return '';
    const host = hostIn(s.web);
    const accounts = (s.devices || []).filter((d) => d.kind === 'account');
    const opt = (v, label) => `<button type="button" role="radio" aria-checked="${s.mode === v}" class="${s.mode === v ? 'on' : ''}" data-k="mode" data-mode="${v}">${label}</button>`;
    const line = s.mode === 'private'
      ? `Private: only phones paired with this PC's code reach it. Apaki accounts cannot be added, and phones never tell our servers which PCs they know. Phones still run the page from ${esc(host)}, which this PC checks before each code.`
      : `Connected: phones signed in to an Apaki account can reach this PC too, once you allow that account here. Accounts live on ${esc(host)}, encrypted with your passkey.`;
    const n = accounts.length;
    const confirm = toPrivate ? `<div class="ph-sas ph-confirm">
        <div class="ph-step">Switch to Private</div>
        <p>${n} Apaki account${n === 1 ? ' is' : 's are'} linked to this PC. In Private mode ${n === 1 ? 'it' : 'they'} cannot connect. Remove ${n === 1 ? 'it' : 'them'}, or keep ${n === 1 ? 'it' : 'them'} paused until you switch back.</p>
        <div class="ph-actions"><button data-k="mode-cancel">Cancel</button><button data-k="mode-keep">Keep, paused</button><button class="primary" data-k="mode-remove">Remove ${n === 1 ? 'it' : 'them'}</button></div>
      </div>` : '';
    return `<div class="ph-mode"><div class="seg" role="radiogroup" aria-label="Phone access mode">${opt('connected', 'Connected')}${opt('private', 'Private')}</div><p class="ph-mode-t">${line}</p></div>${confirm}`;
  }

  /** An Apaki account a phone asks to link: nothing is added until Allow here. */
  function linkBlock() {
    const r = st?.linkRequest;
    if (!r) return '';
    const c = linkCap || r.cap || 'full';
    const who = `${r.by || 'A phone'}${r.via ? ` (${r.via})` : ''}`;
    return `<div class="ph-sas ph-link">
        <div class="ph-step"><b>${esc(who)}</b> wants to add the Apaki account <b>${esc(r.account || 'Apaki account')}</b></div>
        <p>Every phone signed in to that account could then reach this PC, without a code. ${CAP_TEXT[c] || CAP_TEXT.full} Allow it only if you asked for this.</p>
        <div class="ph-life-row"><span>It may</span>${capSeg(c, 'linkcap-pick')}</div>
        <div class="ph-life-row"><span>Stays linked</span>${lifeSeg(linkLife, 'linklife-pick', '', days())}</div>
        <div class="ph-actions"><button data-k="link-deny">Deny</button><button class="primary" data-k="link-allow">Allow</button></div>
      </div>`;
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
      ${s.keysProblem ? `<div class="ph-actions"><button data-k="reset" class="${confirmReset ? 'ph-remove sure' : ''}" title="Sets the saved keys aside (renamed, kept) and makes new ones: every phone pairs again">${confirmReset ? 'Start over: every phone pairs again' : 'Start over'}</button></div>` : ''}
      ${s.pageAlarm ? `<div class="ph-page ph-alarm" data-state="differs">${esc(s.pageAlarm.text)}${s.pageAlarm.at ? ` (${esc(new Date(s.pageAlarm.at).toLocaleString())})` : ''}</div>` : ''}
      ${modeBlock()}
      ${s.page?.text ? `<div class="ph-page" data-state="${esc(s.page.state)}" title="${esc(s.page.url || '')}">${esc(s.page.text)}</div>` : ''}
      ${s.page?.canSkip && s.enabled && !s.pairing && !s.request ? `<div class="ph-skip"><button data-k="pair-unchecked">Pair without checking the page</button><span>Your phone would run whatever ${esc(hostIn(s.page.url || s.web, 'the site'))} serves now, unverified. If that page was changed, it could use this pairing to do anything this phone is allowed to do on this PC.</span></div>` : ''}
      ${linkBlock()}
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
    // lifetime: whole days, or null for forever (what an older engine assumes when it gets none).
    on('allow', () => send('remotePairDecision', { approve: true, lifetime: life ? Number(life) : null, cap }));
    on('cap-pick', (b) => { cap = b.dataset.cap || 'full'; render(); });
    on('cap-edit', (b) => { editCap = editCap === b.dataset.id ? null : b.dataset.id; render(); });
    on('cap-set', (b) => { editCap = null; send('remoteDeviceCap', { deviceId: b.dataset.id, cap: b.dataset.cap }); });
    on('pair-unchecked', () => send('remotePairStart', { unchecked: true }));
    on('linkcap-pick', (b) => { linkCap = b.dataset.cap || 'full'; render(); });
    on('linklife-pick', (b) => { linkLife = b.dataset.life || ''; render(); });
    on('link-allow', () => send('remoteLinkDecision', { approve: true, cap: linkCap || st?.linkRequest?.cap || 'full', lifetime: linkLife ? Number(linkLife) : null }));
    on('link-deny', () => send('remoteLinkDecision', { approve: false }));
    on('mode', (b) => {
      const m = b.dataset.mode;
      if (m === st?.mode) return;
      // To Private with accounts linked: ask what to do with them first.
      if (m === 'private' && (st?.devices || []).some((d) => d.kind === 'account')) { toPrivate = true; render(); return; }
      send('remoteMode', { mode: m });
    });
    on('mode-cancel', () => { toPrivate = false; render(); });
    on('mode-keep', () => { toPrivate = false; send('remoteMode', { mode: 'private', removeAccounts: false }); });
    on('mode-remove', () => { toPrivate = false; send('remoteMode', { mode: 'private', removeAccounts: true }); });
    on('deny', () => send('remotePairDecision', { approve: false }));
    on('life-pick', (b) => { life = b.dataset.life || ''; render(); });
    on('life-edit', (b) => { editLife = editLife === b.dataset.id ? null : b.dataset.id; render(); });
    on('life-set', (b) => {
      editLife = null;
      send('remoteDeviceLifetime', { deviceId: b.dataset.id, lifetime: b.dataset.life ? Number(b.dataset.life) : null });
    });
    on('reset', () => {
      if (!confirmReset) {
        confirmReset = true;
        render();
        setTimeout(() => { if (confirmReset) { confirmReset = false; render(); } }, 4000);
        return;
      }
      confirmReset = false;
      send('remoteReset');
    });
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
    const wasLink = Boolean(st?.linkRequest);
    st = e;
    if (e.linkRequest && !wasLink) {
      // A phone asks to add an Apaki account: like a pairing, it cannot wait for someone to open the sheet.
      linkCap = null;
      linkLife = '';
      ding('ask');
      open();
    }
    if (e.paired) paired = { name: e.paired.name, at: Date.now() };
    if (e.request && !wasRequest) {
      // A phone scanned the code: the approval cannot wait for someone to open the sheet.
      // Every new request starts at Forever (Arthur, 2026-10-10: a paired phone is good to go for good), and at Full.
      life = '';
      cap = 'full';
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
