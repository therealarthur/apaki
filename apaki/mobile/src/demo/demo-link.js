/**
 * demo-link.js: link.js for the Apaki app's debug demo mode (apaki/mobile,
 * 2026-10-10). In a demo build, build-app.mjs puts a link.js that exports
 * this Link instead of the real one, so the page talks to demo-engine.js in
 * memory: no socket, no relay, no PC, no keys. Release builds never contain it.
 *
 * Same surface as apaki/web/src/link.js where boot.js, shim.js and
 * account.js use it: state, pcName, relayHost, pairing, hello, device,
 * roomId, relay, onEvent, onReopen, start, wake, restart, stop, send,
 * request, supports.
 *
 *   pairing (a scanned QR)   connecting -> pairing -> sas: shows the 6-digit
 *                            code screen and stays there (the PC would approve)
 *   reconnect (a saved PC)   connecting -> handshake -> open, then the engine
 */

import { createDemoEngine, DEMO_PC } from './demo-engine.js';

export const DEMO_SAS = '482913';

export class Link {
  constructor({ device, offer = null, pairing = null, name = '', on = {} }) {
    this.device = device;
    this.offer = offer;
    this.pairing = pairing;
    this.name = name;
    this.on = on;
    const ref = pairing || offer;
    this.relay = ref.relay;
    this.roomId = ref.roomId;
    this.state = 'idle';
    this.hello = null;
    this.stopped = false;
    this.onEvent = null;
    this.onReopen = null;
    this.engine = createDemoEngine();
    this.timers = new Set();
    this.wake = this.wake.bind(this);
  }

  get pcName() {
    return this.hello?.pcName || this.pairing?.pcName || this.offer?.name || 'your PC';
  }

  get relayHost() {
    try { return new URL(this.relay).host; } catch { return String(this.relay); }
  }

  later(ms, fn) {
    const t = setTimeout(() => { this.timers.delete(t); if (!this.stopped) fn(); }, ms);
    this.timers.add(t);
  }

  setState(state, info = {}) {
    this.state = state;
    this.on.state?.(state, info);
  }

  start() {
    this.setState('connecting');
    if (this.offer) {
      this.later(350, () => this.setState('pairing'));
      this.later(900, () => { this.setState('sas'); this.on.sas?.(DEMO_SAS); });
      return;
    }
    this.later(250, () => this.setState('handshake'));
    this.later(500, () => this.open());
  }

  open() {
    this.setState('open');
    this.on.open?.(true);
    this.hello = { t: 'hello', v: 1, pcName: this.pairing?.pcName || DEMO_PC, ops: ['sessions', 'search', 'open', 'attach', 'send', 'interrupt', 'answer', 'model', 'effort', 'mode', 'commands', 'close'], features: [] };
    this.on.hello?.(this.hello);
    this.later(30, () => this.onEvent?.(this.engine.ready()));
  }

  wake() {}

  restart() {
    if (this.state !== 'open') return;
    this.setState('connecting');
    this.later(400, () => { this.setState('open'); this.onReopen?.(); });
  }

  supports() {
    return false;
  }

  request() {
    return Promise.reject(new Error('Not in the demo.'));
  }

  send(cmd) {
    if (this.state !== 'open') return Promise.reject(new Error(`Not connected to ${this.pcName} right now.`));
    for (const { delay, ev } of this.engine.handle(cmd)) this.later(delay, () => this.onEvent?.(ev));
    return Promise.resolve();
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
