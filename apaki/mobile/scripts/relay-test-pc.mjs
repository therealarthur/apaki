#!/usr/bin/env node
/**
 * relay-test-pc.mjs: a stand-in PC for testing the Apaki app against the
 * real relay (apaki/mobile, 2026-10-10). Not Apaki and not anyone's PC: a
 * throwaway PC identity and room made for the run, speaking
 * apaki/remote/protocol.js and wire.js through wss://apaki.myrlin.io the
 * way apaki/engine/remote.js does, with just enough of an engine to answer
 * the session list.
 *
 *   node apaki/mobile/scripts/relay-test-pc.mjs [--seconds 240] [--approve] [--state <file>] [--links <file>]
 *
 * It prints the pairing link (https form and the app's apaki:// form, for
 * `xcrun simctl openurl`), then the 6-digit code the phone must show. By
 * default it stops there, like a PC user who has not clicked Allow. With
 * --approve it allows the phone (only ever this stand-in's own room) and
 * then answers reconnects, which is how the app's Keychain pairing and
 * reconnect are tested end to end. --state keeps the identity, room and
 * paired devices in a JSON file between runs: it holds secrets, so keep it
 * in a temp folder and delete it after the test.
 */

import fs from 'node:fs';

import { PcSession, createPairingOffer, createPcIdentity, createRoom, decodePcFrame, encodePcFrame, exportIdentity, importIdentity, parseRelayControl, relaySubprotocols, roomUrl } from '../../remote/protocol.js';
import { Inbox, Outbox, WIRE_VERSION } from '../../remote/wire.js';

const RELAY = 'wss://apaki.myrlin.io';
const WEB = 'https://apaki.myrlin.io/';
const NAME = 'Relay test PC';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const approve = args.includes('--approve');
const seconds = Number(opt('seconds', 240));
const stateFile = opt('state', null);
const linksFile = opt('links', null);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function loadState() {
  if (stateFile && fs.existsSync(stateFile)) {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    // Device records are JSON already (protocol.js PcSession: id, pub, psk, name, pairedAt as strings).
    return { identity: await importIdentity(s.identity), room: s.room, devices: new Map(s.devices.map((d) => [d.id, d])) };
  }
  return { identity: await createPcIdentity(), room: await createRoom(), devices: new Map() };
}

async function saveState(st) {
  if (!stateFile) return;
  const devices = [...st.devices.values()];
  fs.writeFileSync(stateFile, JSON.stringify({ identity: await exportIdentity(st.identity), room: st.room, devices }), { mode: 0o600 });
}

const st = await loadState();
const offer = createPairingOffer({ identity: st.identity, relay: RELAY, roomId: st.room.roomId, name: NAME, web: WEB, ttlMs: Math.min(seconds, 300) * 1000 });
const payload = offer.url.split('#p=')[1];
log(`room ${st.room.roomId}; paired devices kept: ${st.devices.size}`);
log(`pairing link: ${offer.url}`);
log(`app link: apaki://pair#p=${payload}`);
if (linksFile) fs.writeFileSync(linksFile, `apaki://pair#p=${payload}\n`, { mode: 0o600 });

const conns = new Map();
const ws = new WebSocket(roomUrl(RELAY, st.room.roomId, 'pc'), relaySubprotocols('pc', st.room.token));
ws.binaryType = 'arraybuffer';

function conn(id) {
  if (conns.has(id)) return conns.get(id);
  const session = new PcSession({ identity: st.identity, roomId: st.room.roomId, getOffer: () => offer, getDevice: (d) => st.devices.get(d) ?? null });
  const c = { id, session, chain: Promise.resolve(), outbox: null, inbox: new Inbox() };
  conns.set(id, c);
  return c;
}

const write = (c) => (frame) => { if (ws.readyState === 1) ws.send(encodePcFrame(c.id, frame)); };

function opened(c) {
  c.outbox = new Outbox({ session: c.session, write: write(c), onError: (e) => log('outbox', e.message) });
  c.outbox.send({ t: 'hello', v: WIRE_VERSION, pcName: NAME, ops: ['sessions', 'open', 'send', 'close'], features: [] });
  c.outbox.push({ ev: 'ready', model: 'claude-opus-5-5', effort: 'xhigh', mode: 'default', pid: 0, voice: false });
  log(`conn ${c.id}: channel open`);
}

function onCommand(c, cmd) {
  log(`conn ${c.id}: command ${cmd?.op}`);
  if (cmd?.op === 'sessions') {
    const now = Date.now();
    c.outbox.push({ ev: 'sessions', reqId: cmd.reqId, folders: [], items: [{ id: '00000000-0000-4000-8000-00000000test', title: 'Reached through the real relay', firstPrompt: '', cwd: 'C:\\relay-test', branch: '', lastModified: now, size: 0, codex: false, terminal: null, folder: null, headless: false, bare: false, warm: false, subagents: 0 }] });
  }
}

async function onFrame(c, bytes) {
  const step = await c.session.receive(bytes);
  for (const f of step.send) write(c)(f);
  for (const ev of step.events) {
    if (ev.type === 'pair-request') {
      log(`conn ${c.id}: PAIRING REQUEST from "${ev.device.name}", code ${ev.sas.slice(0, 3)} ${ev.sas.slice(3)}`);
      if (!approve) { log('not approving (run with --approve to allow)'); continue; }
      const r = await c.session.approve();
      st.devices.set(r.device.id, r.device);
      await saveState(st);
      for (const f of r.send) write(c)(f);
      log(`conn ${c.id}: approved device ${r.device.id}`);
      opened(c);
    } else if (ev.type === 'open') {
      opened(c);
    } else if (ev.type === 'json') {
      const m = c.inbox.json(ev.value);
      if (m?.t === 'cmd') onCommand(c, m.cmd);
    } else if (ev.type === 'error' || ev.type === 'alert') {
      log(`conn ${c.id}: ${ev.type} ${ev.code} ${ev.message || ''}`);
    }
  }
}

ws.addEventListener('open', () => { ws.send('ping'); log('connected to the relay as the PC'); });
setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, 25_000).unref();
ws.addEventListener('message', (e) => {
  if (typeof e.data === 'string') {
    const m = parseRelayControl(e.data);
    if (!m || m.t === 'pong') return;
    if (m.t === 'join') { conns.delete(m.conn); conn(m.conn); log(`phone connection ${m.conn} joined`); }
    if (m.t === 'leave') { conns.get(m.conn)?.outbox?.close(); conns.delete(m.conn); log(`phone connection ${m.conn} left`); }
    if (m.t === 'ready') log(`relay ready; phones already here: ${(m.phones || []).length}`);
    if (m.t === 'bye') log(`relay says bye: ${m.code} ${m.reason || ''}`);
    return;
  }
  const f = decodePcFrame(new Uint8Array(e.data));
  const c = conn(f.connId);
  c.chain = c.chain.then(() => onFrame(c, f.payload)).catch((err) => log(`conn ${c.id}: ${err.message}`));
});
ws.addEventListener('close', (e) => { log(`relay socket closed ${e.code}`); process.exit(0); });
setTimeout(() => { log(`done after ${seconds} s`); try { ws.close(); } catch { /* gone */ } process.exit(0); }, seconds * 1000);
