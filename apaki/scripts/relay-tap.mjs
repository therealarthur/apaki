#!/usr/bin/env node
/**
 * relay-tap.mjs: a recording proxy in front of a local Apaki relay, to check
 * what the relay actually sees (Track B part 2, 2026-10-09). Clients connect
 * to the tap exactly as they would to the relay; the tap forwards every
 * frame both ways and writes each one (direction, room path, size, bytes in
 * base64) to a JSON-lines dump. Then:
 *
 *   node apaki/scripts/relay-tap.mjs --listen 8788 --relay ws://127.0.0.1:8787 --dump frames.jsonl
 *   node apaki/scripts/relay-tap.mjs --check frames.jsonl --marker SOME-TEXT [--marker ...]
 *
 * --check reads a dump and reports, for each marker, whether it appears in
 * any frame as UTF-8, UTF-16 or base64 of either (it must not: everything
 * between the PC and a phone is end-to-end encrypted), plus frame counts by
 * kind. It exits 1 if a marker is found. Uses the `ws` package from relay/'s
 * own dev dependencies (cd relay; npm install).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const relayDir = path.resolve(here, '..', '..', 'relay');

function args(argv) {
  const o = { marker: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    const v = argv[i + 1];
    if (k === 'marker') { o.marker.push(v); i++; } else { o[k] = v; i++; }
  }
  return o;
}

const o = args(process.argv.slice(2));

if (o.check) {
  const lines = fs.readFileSync(o.check, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const kinds = {};
  let bytes = 0;
  const blobs = lines.map((f) => {
    const b = Buffer.from(f.b64, 'base64');
    bytes += b.length;
    const kind = f.binary ? `binary first byte 0x${(f.dir === 'down' && f.role === 'pc' ? b[4] : f.dir === 'up' && f.role === 'pc' ? b[4] : b[0])?.toString(16).padStart(2, '0')}` : 'text';
    kinds[`${f.role} ${f.dir} ${kind}`] = (kinds[`${f.role} ${f.dir} ${kind}`] || 0) + 1;
    return b;
  });
  const all = Buffer.concat(blobs);
  const texts = lines.filter((f) => !f.binary).map((f) => Buffer.from(f.b64, 'base64').toString('utf8'));
  let found = false;
  for (const m of o.marker) {
    const needles = [
      ['utf8', Buffer.from(m, 'utf8')],
      ['utf16le', Buffer.from(m, 'utf16le')],
      ['base64 of utf8', Buffer.from(Buffer.from(m, 'utf8').toString('base64').slice(0, -4), 'utf8')],
      ['lowercase utf8', Buffer.from(m.toLowerCase(), 'utf8')],
    ];
    const hits = needles.filter(([, n]) => all.indexOf(n) >= 0).map(([k]) => k);
    const inText = texts.some((t) => t.toLowerCase().includes(m.toLowerCase()));
    if (hits.length || inText) found = true;
    process.stdout.write(`marker ${JSON.stringify(m)}: ${hits.length || inText ? `FOUND (${[...hits, inText ? 'text frame' : ''].filter(Boolean).join(', ')})` : 'not in any frame'}\n`);
  }
  process.stdout.write(`${lines.length} frames, ${bytes} bytes\n`);
  for (const [k, n] of Object.entries(kinds).sort()) process.stdout.write(`  ${n.toString().padStart(5)}  ${k}\n`);
  process.exit(found ? 1 : 0);
}

const require = createRequire(path.join(relayDir, 'package.json'));
const { WebSocketServer, WebSocket } = require('ws');
const port = Number(o.listen || 8788);
const upstream = String(o.relay || 'ws://127.0.0.1:8787').replace(/\/+$/, '');
const dump = fs.createWriteStream(o.dump || 'relay-frames.jsonl', { flags: 'a' });
let seq = 0;

const wss = new WebSocketServer({
  host: '127.0.0.1',
  port,
  handleProtocols: (protocols) => (protocols.has('apaki.v1') ? 'apaki.v1' : false),
});

wss.on('connection', (client, req) => {
  const id = ++seq;
  const role = /\/pc$/.test(req.url) ? 'pc' : 'phone';
  const offered = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const up = new WebSocket(`${upstream}${req.url}`, offered, { headers: req.headers.origin ? { origin: req.headers.origin } : {} });
  const pending = [];
  const record = (dir, data, binary) => {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
    dump.write(`${JSON.stringify({ t: Date.now(), conn: id, role, path: req.url, dir, binary, len: b.length, b64: b.toString('base64') })}\n`);
  };
  client.on('message', (data, binary) => {
    record('up', data, binary);
    if (up.readyState === WebSocket.OPEN) up.send(data, { binary }); else pending.push([data, binary]);
  });
  up.on('open', () => { for (const [d, b] of pending.splice(0)) up.send(d, { binary: b }); });
  up.on('message', (data, binary) => {
    record('down', data, binary);
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
  });
  up.on('unexpected-response', (_req, res) => { process.stdout.write(`tap ${id} ${role}: relay answered HTTP ${res.statusCode}\n`); client.close(4403, `relay said ${res.statusCode}`); });
  up.on('close', (code, reason) => { try { client.close(code >= 4000 || code === 1000 ? code : 1000, reason); } catch { client.terminate(); } });
  up.on('error', () => client.terminate());
  client.on('close', (code, reason) => { try { up.close(code >= 4000 || code === 1000 ? code : 1000, reason); } catch { up.terminate(); } });
  process.stdout.write(`tap ${id} ${role} ${req.url}\n`);
});

wss.on('listening', () => process.stdout.write(`relay tap on ws://127.0.0.1:${port} -> ${upstream}, dumping to ${o.dump || 'relay-frames.jsonl'}\n`));
