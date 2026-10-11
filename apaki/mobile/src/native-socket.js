/**
 * native-socket.js: the WebSocket the Apaki app's page uses for the relay
 * (apaki/mobile, 2026-10-10).
 *
 * link.js does `new WebSocket(roomUrl(...), relaySubprotocols('phone'))`.
 * In the app that socket is opened by the native side (ApakiNet, a
 * URLSessionWebSocketTask on iOS), for three reasons:
 *   - The relay accepts phone sockets only from the phone page's origin
 *     (relay ALLOWED_ORIGINS, "stops other websites from using their
 *     visitors' browsers"). The app's page is capacitor://localhost, so the
 *     native side sends the site's own origin, https://apaki.myrlin.io: the
 *     app is that page, built from the same commit and shipped inside it.
 *   - The native side enforces where the app may connect
 *     (wss://apaki.myrlin.io/v1/rooms/<id>/phone and nothing else), whatever
 *     the page asks for.
 *   - On return to the foreground it pings every socket and reports a dead
 *     one at once, so link.js reconnects in about a second instead of
 *     waiting for a timeout.
 * The frames stay end-to-end encrypted by protocol.js; the native side only
 * moves bytes (base64 over Capacitor's bridge).
 *
 * makeSocketClass(Net, allowed) returns a class with the parts of WebSocket
 * that link.js uses: readyState, protocol, binaryType, send, close, and
 * onopen / onmessage / onclose / onerror.
 */

import { b64d, b64e } from './codec.js';

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

export function makeSocketClass(Net, allowed) {
  const sockets = new Map();
  let seq = 0;
  let listening = null;
  // One listener for every socket's events, added before the first socket opens.
  const listen = () => (listening ||= Net.addListener('socket', (ev) => sockets.get(ev.id)?._event(ev)));

  class NativeWebSocket {
    static CONNECTING = CONNECTING;
    static OPEN = OPEN;
    static CLOSING = CLOSING;
    static CLOSED = CLOSED;

    constructor(url, protocols = []) {
      const href = String(url);
      // Like a Content-Security-Policy refusal in a browser: a synchronous SecurityError.
      if (!allowed(href)) throw new DOMException(`Refused to connect to ${href}: the app connects to the Apaki relay only.`, 'SecurityError');
      this.url = href;
      this.protocol = '';
      this.extensions = '';
      this.binaryType = 'blob';
      this.bufferedAmount = 0;
      this.readyState = CONNECTING;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      this._id = `s${++seq}`;
      sockets.set(this._id, this);
      const list = (Array.isArray(protocols) ? protocols : [protocols]).filter(Boolean).map(String);
      Promise.resolve(listen())
        .then(() => Net.socketOpen({ id: this._id, url: href, protocols: list }))
        .catch((e) => { this._event({ type: 'error', message: e?.message }); this._event({ type: 'close', code: 1006, reason: e?.message || 'could not open' }); });
    }

    send(data) {
      if (this.readyState === CONNECTING) throw new DOMException('Still connecting.', 'InvalidStateError');
      if (this.readyState !== OPEN) return;
      const msg = typeof data === 'string' ? { id: this._id, text: data } : { id: this._id, data: b64e(data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) };
      Net.socketSend(msg).catch(() => { /* a close event follows */ });
    }

    close(code = 1000, reason = '') {
      if (this.readyState === CLOSING || this.readyState === CLOSED) return;
      this.readyState = CLOSING;
      Net.socketClose({ id: this._id, code, reason: String(reason).slice(0, 120) }).catch(() => { this._event({ type: 'close', code, reason }); });
    }

    addEventListener(type, fn) { this[`on${type}`] = fn; }

    _event(ev) {
      if (ev.type === 'open') {
        if (this.readyState !== CONNECTING) return;
        this.readyState = OPEN;
        this.protocol = ev.protocol || '';
        this.onopen?.({ type: 'open', target: this });
      } else if (ev.type === 'message') {
        if (this.readyState !== OPEN) return;
        let data = ev.text;
        if (data == null) {
          const bytes = b64d(ev.data || '');
          data = this.binaryType === 'arraybuffer' ? bytes.buffer : new Blob([bytes]);
        }
        this.onmessage?.({ type: 'message', data, target: this });
      } else if (ev.type === 'error') {
        this.onerror?.({ type: 'error', message: ev.message || '', target: this });
      } else if (ev.type === 'close') {
        if (this.readyState === CLOSED) return;
        this.readyState = CLOSED;
        sockets.delete(this._id);
        this.onclose?.({ type: 'close', code: ev.code ?? 1006, reason: ev.reason || '', wasClean: ev.code === 1000, target: this });
      }
    }
  }

  return NativeWebSocket;
}
