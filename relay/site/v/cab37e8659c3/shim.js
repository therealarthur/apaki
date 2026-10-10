/**
 * shim.js: the part of window.__TAURI__ that Apaki's window code uses
 * (apaki/ui/app.js and pane.js), provided over the relay instead of by the
 * Tauri shell, so the phone runs Apaki's own UI unchanged (Track B part 2,
 * 2026-10-09).
 *
 *   core.invoke('engine_send', { msg })  -> one engine command to the PC
 *   event.listen('engine', cb)           -> every engine event from the PC
 *   window.getCurrentWindow()            -> minimize, maximize and close do
 *                                           nothing (a browser tab has none)
 *
 * It also remembers which panes this phone has open, so after a reconnect
 * it re-attaches each one (engine op attach: same pane, same Claude Code
 * process, history sent again) instead of restarting it.
 */

export function installShim(link) {
  const listeners = new Set();
  const early = [];
  /** paneId -> { sessionId, cwd } for the panes this phone has open. */
  const panes = new Map();
  let seq = 0;

  const deliver = (ev) => {
    if (!listeners.size) { early.push(ev); return; }
    for (const cb of listeners) cb({ event: 'engine', id: 0, payload: ev });
  };

  const sent = (msg) => {
    if (!msg?.paneId) return;
    if (msg.op === 'open' || msg.op === 'attach') panes.set(msg.paneId, { sessionId: msg.sessionId || null, cwd: msg.cwd || null });
    if (msg.op === 'close') panes.delete(msg.paneId);
  };

  const seen = (ev) => {
    const p = ev.paneId && panes.get(ev.paneId);
    if (!p) return;
    if (ev.ev === 'opened' || ev.ev === 'session_id') p.sessionId = ev.sessionId || null;
    if (ev.ev === 'opened' && ev.cwd) p.cwd = ev.cwd;
    if (ev.ev === 'closed') panes.delete(ev.paneId);
  };

  link.onEvent = (ev) => { seen(ev); deliver(ev); };
  link.onReopen = () => {
    for (const [paneId, p] of panes) link.send({ op: 'attach', reqId: `re${++seq}`, paneId, sessionId: p.sessionId, cwd: p.cwd }).catch(() => {});
    link.send({ op: 'sessions', reqId: `re${++seq}` }).catch(() => {});
  };

  async function invoke(cmd, args = {}) {
    if (cmd !== 'engine_send') throw new Error(`${cmd} is not available on the phone`);
    const msg = args.msg || {};
    sent(msg);
    try {
      await link.send(msg);
    } catch (e) {
      // Not connected: answer like the engine would, so a pane does not stay
      // "working" on a message that never left. The periodic list refresh
      // just waits for the next one.
      if (msg.op !== 'sessions') deliver({ ev: 'error', reqId: msg.reqId, paneId: msg.paneId || null, message: e.message });
    }
  }

  async function listen(name, cb) {
    if (name !== 'engine') return () => {};
    listeners.add(cb);
    for (const ev of early.splice(0)) cb({ event: 'engine', id: 0, payload: ev });
    return () => listeners.delete(cb);
  }

  const noop = async () => {};
  const win = { minimize: noop, toggleMaximize: noop, close: noop, isMaximized: async () => false, onResized: async () => () => {} };

  window.__TAURI__ = Object.freeze({
    core: Object.freeze({ invoke }),
    event: Object.freeze({ listen }),
    window: Object.freeze({ getCurrentWindow: () => win }),
  });
}
