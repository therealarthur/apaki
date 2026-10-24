/** Invented Glass responses only. No installed Glass, provider login or network is used. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { Pane } from '../apaki/ui/pane.js';
import { build } from '../apaki/scripts/build-web.mjs';
import { glassAccount, glassView, glassProviderSettings, providerSettingsArgs, readProviderSettings } from '../apaki/engine/glass.js';
import { providerVisible, providerChoices, displayProviders, KIMI_LOGIN_HINT } from '../apaki/ui/glass-providers.js';
import { initGlassCard, heroRowHtml, accountItems } from '../apaki/ui/glasscard.js';
import { closeGlassPanel, glassPanelProvider } from '../apaki/ui/glasspanel.js';
import { heroFor, heroWindows, windowSeconds, windowsDetailHtml } from '../apaki/ui/usage-rings.js';
import { kimiBilling } from '../apaki/engine/kimi-map.js';
import { checkPhoneCommand, routeEvent, BROADCAST_EVENTS } from '../apaki/engine/remote-policy.js';

const fixture = () => JSON.parse(fs.readFileSync(new URL('../test-fixtures/glass-status.json', import.meta.url), 'utf8'));
const NOW = Date.UTC(2026, 10, 1, 12);
const flag = (name) => String.fromCharCode(45, 45) + name;
const statusEvent = (s) => ({ ev: 'glass', installed: true, ...glassView(s) });

test('old Glass stays quiet without Kimi or visibility metadata; API credits are preserved', () => {
  const old = fixture();
  delete old.visibleProviders; delete old.knownProviders;
  old.accounts = old.accounts.filter((a) => a.provider !== 'kimi');
  const view = glassView(old);
  assert.equal(view.kimi, null);
  assert.deepEqual(view.lists.kimi, []);
  assert.deepEqual(displayProviders(view), ['claude', 'codex']);
  assert.deepEqual(providerChoices(view), ['claude', 'codex', 'kimi']);
  assert.equal(view.lists.claude.find((a) => a.isKey).leftUsd, 160);
  assert.equal(glassView(null), null);
});

test('Kimi keeps every window, headroom, reset and alternate account without Workbook', () => {
  const view = glassView(fixture());
  assert.equal(view.mode.swapsEnabled, false);
  assert.equal(view.mode.lite, true);
  assert.equal(view.kimi.name, 'Moon fixture');
  assert.equal(view.kimi.headroom, 8);
  assert.deepEqual(view.kimi.windows.map((w) => w.label), ['5h', 'Monthly', 'Monthly coding']);
  assert.deepEqual(view.kimi.windows.map((w) => w.resetsAt), fixture().accounts[2].windows.map((w) => w.resetsAt));
  assert.equal(view.lists.kimi.length, 2);
  assert.equal(accountItems('kimi', view.lists.kimi)[0].heading, 'Kimi accounts');
  const repeated = { ...fixture().accounts[2], windows: [{ label: 'Monthly', percent: 15, resetsAt: '2026-11-10' }, { label: 'Monthly', percent: 15, resetsAt: '2026-11-20' }] };
  assert.equal(glassAccount(repeated).windows.length, 2, 'equal usage is not proof that limits are duplicates');
});

test('monthly rings never say 7d and the hero considers either monthly limit in either input order', () => {
  const windows = glassView(fixture()).kimi.windows;
  assert.equal(windowSeconds(windows[1]), 30 * 86400);
  const detail = windowsDetailHtml(windows, NOW);
  assert.equal((detail.match(/class="u-win"/g) || []).length, 3);
  assert.equal((detail.match(/resets /g) || []).length, 3);
  assert.equal((detail.match(/<b>mo<\/b>/g) || []).length, 2);
  assert.doesNotMatch(detail, /<b>7d<\/b>|style=/);
  for (const list of [windows, windows.toReversed()]) {
    assert.equal(heroWindows(list).inner.label, 'Monthly');
    assert.match(heroFor(list, { now: NOW }).line, /Monthly/);
    assert.match(heroFor(list, { now: NOW }).ring, /<b>92<\/b>/);
  }
  const coding = windows.map((w) => ({ ...w, percent: w.label === 'Monthly coding' ? 98 : w.percent }));
  assert.match(heroFor(coding, { now: NOW }).line, /Monthly coding/);
  assert.match(heroRowHtml('kimi', glassView(fixture()).kimi), /Kimi/);
});

test('visibility uses null, missing, empty and explicit allowlists while retaining all engine accounts', () => {
  for (const visibleProviders of [undefined, null, [], ['kimi'], ['future_ai', 'codex', 'codex']]) {
    const st = { ...fixture(), visibleProviders };
    const view = glassView(st);
    assert.equal(view.lists.claude.length, 2);
    assert.equal(view.lists.kimi.length, 2);
    assert.deepEqual(displayProviders(view), ['claude', 'codex', 'kimi'].filter((p) => visibleProviders == null || visibleProviders.includes(p)));
  }
  assert.deepEqual(providerChoices({ knownProviders: ['claude', 'kimi'], visibleProviders: ['future_ai', 'kimi'] }), ['claude', 'kimi', 'future_ai']);
  assert.equal(providerVisible({ visibleProviders: ['future_ai'] }, 'kimi'), false);
  assert.equal(kimiBilling({ ...fixture(), visibleProviders: [] }).glassVisible, false);
  assert.equal(kimiBilling({ ...fixture(), visibleProviders: [] }).name, 'Moon fixture', 'billing data remains available to engine callers');
});

function fakeGlass(initial = fixture()) {
  const state = structuredClone(initial);
  const calls = [];
  let failure = null;
  const exec = (cli, args, options, cb) => {
    calls.push({ cli, args, options });
    if (failure) { queueMicrotask(() => cb(new Error('exit 1'), JSON.stringify(failure), 'fixture failure')); return; }
    if (args.includes(flag('hide')) || args.includes(flag('show'))) {
      const id = args[3];
      const visible = new Set(state.visibleProviders ?? state.knownProviders);
      if (args[2] === flag('show')) visible.add(id); else visible.delete(id);
      state.visibleProviders = [...visible];
    }
    const output = { visibleProviders: state.visibleProviders, knownProviders: state.knownProviders };
    queueMicrotask(() => cb(null, JSON.stringify(output), ''));
  };
  return { state, calls, exec, fail: (e) => { failure = e; } };
}

test('settings read and single-provider round trip preserve unknown ids and consume Glass responses', async () => {
  const glass = fakeGlass({ ...fixture(), visibleProviders: ['claude', 'kimi', 'future_ai'] });
  const change = (c) => glassProviderSettings('fixture-glass', c, glass.exec);
  assert.deepEqual((await change({})).visibleProviders, ['claude', 'kimi', 'future_ai']);
  assert.deepEqual((await change({ provider: 'kimi', visible: false })).visibleProviders, ['claude', 'future_ai']);
  glass.state.visibleProviders.push('codex');
  assert.deepEqual((await change({ provider: 'kimi', visible: true })).visibleProviders, ['claude', 'future_ai', 'codex', 'kimi']);
  assert.deepEqual(glass.calls.map((c) => c.args), [
    ['settings', 'providers', flag('json')],
    ['settings', 'providers', flag('hide'), 'kimi', flag('json')],
    ['settings', 'providers', flag('show'), 'kimi', flag('json')],
  ]);
  assert.ok(glass.calls.every((c) => !c.options.shell));
  assert.throws(() => providerSettingsArgs({ provider: '../bad', visible: true }));
  assert.throws(() => providerSettingsArgs({ provider: 'kimi', visible: 'false' }));
  assert.throws(() => readProviderSettings({ visibleProviders: [] }));
});

test('offline, malformed and old Glass errors never fabricate a saved setting', async () => {
  const glass = fakeGlass();
  glass.fail({ error: 'NOT_RUNNING', message: 'Start Glass to save provider settings.' });
  await assert.rejects(glassProviderSettings('fixture-glass', { provider: 'kimi', visible: false }, glass.exec), /Start Glass/);
  assert.equal(glass.state.visibleProviders, null);
  for (const stdout of ['bad JSON', '{}', '{"visibleProviders":false,"knownProviders":[]}']) {
    await assert.rejects(glassProviderSettings('fixture-glass', {}, (cli, args, options, cb) => cb(null, stdout, '')), /did not return provider settings/);
  }
});

/** A small DOM double, like the other UI tests. Buttons retain their real handlers and data attributes. */
function dom(t) {
  const old = { document: globalThis.document, window: globalThis.window, setInterval: globalThis.setInterval };
  const nodes = [];
  const make = () => {
    const node = {
      dataset: {}, style: { setProperty() {} }, hidden: false, scrollTop: 0,
      classList: { add() {}, remove() {}, contains: () => false },
      getBoundingClientRect: () => ({ left: 8, top: 600, bottom: 700 }),
      contains: () => false, remove() { node.removed = true; }, focus() {},
      querySelectorAll(selector) {
        if (selector === '[data-a]') return node.buttons.filter((b) => b.dataset.a);
        if (selector === '.gc-row') return node.buttons.filter((b) => b.cls.includes('gc-row'));
        if (selector === '.gp-row') return node.rows;
        return [];
      },
      querySelector(selector) {
        if (selector === '.gp-body') return node.body;
        if (selector === '[data-settings]') return node.buttons.find((b) => b.settings);
        return null;
      },
      set innerHTML(html) {
        node.html = html; node.body = { scrollTop: 0 }; node.rows = []; node.buttons = [];
        for (const match of html.matchAll(/<div class="gp-row[^>]*data-id="([^"]+)"/g)) {
          node.rows.push({ dataset: { id: match[1] } });
        }
        for (const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
          const attrs = match[1], dataset = {};
          for (const m of attrs.matchAll(/data-([a-z-]+)="([^"]*)"/g)) dataset[m[1]] = m[2];
          const before = html.slice(0, match.index);
          const id = [...before.matchAll(/class="gp-row[^>]*data-id="([^"]+)"/g)].at(-1)?.[1];
          node.buttons.push({ dataset, cls: attrs.match(/class="([^"]*)"/)?.[1] || '', title: '', disabled: / disabled/.test(attrs),
            settings: /data-settings/.test(attrs), classList: { add() {} }, querySelector: () => ({}),
            closest: () => id ? { dataset: { id } } : null, focus() {},
          });
        }
      },
      get innerHTML() { return node.html; },
    };
    node.innerHTML = ''; return node;
  };
  globalThis.document = { visibilityState: 'visible', createElement: make, body: { append: (n) => nodes.push(n) } };
  globalThis.window = { innerWidth: 800, innerHeight: 900, addEventListener() {}, removeEventListener() {} };
  globalThis.setInterval = () => 0;
  t.after(() => { closeGlassPanel(); Object.assign(globalThis, old); });
  return { root: make(), panel: () => nodes.filter((n) => !n.removed).at(-1), click: (b) => { assert.ok(b, 'button exists'); assert.equal(b.disabled, false); b.onclick({ stopPropagation() {} }); } };
}

test('card and panel toggle round trip, external refresh, failure and all-hidden recovery', async (t) => {
  const d = dom(t), glass = fakeGlass(), pending = [];
  let card;
  card = initGlassCard({ root: d.root, send: (op, args = {}) => {
    assert.equal(op, 'glassProviders');
    pending.push(glassProviderSettings('fixture-glass', args, glass.exec).then((s) => card.handle({ ev: 'glass_providers', reqId: args.reqId, ok: true, ...s })).catch((e) => card.handle({ ev: 'glass_providers', reqId: args.reqId, ok: false, message: e.message })));
  } });
  const settle = async () => { while (pending.length) await pending.shift(); };
  card.handle(statusEvent(glass.state));
  assert.match(d.root.innerHTML, /data-p="kimi"/);
  d.click(d.root.buttons.find((b) => b.settings)); await settle();
  assert.equal(glassPanelProvider(), 'settings');
  d.click(d.panel().buttons.find((b) => b.dataset.provider === 'kimi')); await settle();
  assert.doesNotMatch(d.root.innerHTML, /data-p="kimi"/);
  assert.match(d.panel().innerHTML, /data-provider="kimi" aria-pressed="false"/);
  glass.state.visibleProviders = [];
  card.handle(statusEvent(glass.state));
  assert.doesNotMatch(d.root.innerHTML, /data-p=/);
  assert.match(d.root.innerHTML, /Settings/);
  d.click(d.panel().buttons.find((b) => b.dataset.provider === 'kimi')); await settle();
  assert.deepEqual(glass.state.visibleProviders, ['kimi']);
  assert.match(d.root.innerHTML, /data-p="kimi"/);
  glass.fail({ error: 'NOT_RUNNING', message: 'Glass is offline.' });
  d.click(d.panel().buttons.find((b) => b.dataset.provider === 'kimi')); await settle();
  assert.match(d.panel().innerHTML, /Glass is offline/);
  assert.equal(d.panel().buttons.find((b) => b.dataset.provider === 'kimi').disabled, false);
  assert.match(d.root.innerHTML, /data-p="kimi"/);
});

test('phone has all Kimi details and login hint; only Full access can swap; hiding an open provider clears it', (t) => {
  const d = dom(t), sent = [], state = statusEvent(fixture());
  let full = false;
  const card = initGlassCard({ root: d.root, readOnly: true, can: (op) => op !== 'glassSwap' || full, send: (...a) => sent.push(a) });
  card.handle(state);
  d.click(d.root.buttons.find((b) => b.dataset.p === 'kimi'));
  assert.match(d.panel().innerHTML, /Monthly coding/);
  assert.match(d.panel().innerHTML, /92% used · resets/);
  assert.match(d.panel().innerHTML, /8% left/);
  assert.match(d.panel().innerHTML, /\/login/);
  assert.doesNotMatch(d.panel().innerHTML, /data-a="use"|data-a="rename"|data-a="hide"/);
  d.click(d.panel().buttons.find((b) => b.dataset.a === 'add-login'));
  assert.equal(sent.length, 0, 'login is a hint, never Workbook or a subprocess');
  full = true; card.handle(state);
  d.click(d.panel().buttons.find((b) => b.dataset.a === 'use'));
  assert.deepEqual(sent[0], ['glassSwap', { provider: 'kimi', account: 'k2', reqId: 'glass1' }]);
  card.handle({ ...state, visibleProviders: ['claude'] });
  assert.equal(glassPanelProvider(), 'settings');
  assert.doesNotMatch(d.panel().innerHTML, /Moon fixture|Monthly coding/);
});

test('phone validates provider deltas, restricts swaps and routes results to the requester', () => {
  const deviceId = 'AbCdEfGhIjKlMnOpQrStUv';
  for (const cap of ['full', 'noshell', 'chat']) {
    const result = checkPhoneCommand({ op: 'glassProviders', provider: 'future_ai', visible: false, reqId: 'r1', extra: 'discard' }, { deviceId, cap });
    assert.equal(result.ok, true);
    assert.deepEqual(result.cmd, { op: 'glassProviders', provider: 'future_ai', visible: false, reqId: `phone:${deviceId}:r1` });
    assert.equal(checkPhoneCommand({ op: 'glass', refresh: true }, { deviceId, cap }).ok, true);
    assert.equal(checkPhoneCommand({ op: 'glassSwap', provider: 'kimi', account: 'k2' }, { deviceId, cap }).ok, cap === 'full');
  }
  for (const cmd of [{ provider: 'bad id', visible: true }, { provider: 'kimi', visible: 'false' }, { visible: true }]) {
    assert.equal(checkPhoneCommand({ op: 'glassProviders', ...cmd }, { deviceId }).ok, false);
  }
  assert.equal(checkPhoneCommand({ op: 'glassSwap', provider: 'future', account: 'k2' }, { deviceId }).ok, false);
  const routed = routeEvent({ ev: 'glass_providers', reqId: `phone:${deviceId}:r1`, ok: true, visibleProviders: [] });
  assert.equal(routed.deviceId, deviceId); assert.equal(routed.ev.reqId, 'r1');
  assert.ok(BROADCAST_EVENTS.has('glass'));
});

/** Execute the actual engine Glass handlers with injected process and credential boundaries. */
function engineHarness() {
  const source = fs.readFileSync(new URL('../apaki/engine/engine.js', import.meta.url), 'utf8');
  const handlers = source.slice(source.indexOf('  glass: (c)'), source.indexOf('  // A Console org', source.indexOf('  glass: (c)')));
  const functions = source.slice(source.indexOf('const glassProvider ='), source.indexOf('fs.watchFile(LIVE_LOGIN'));
  const glass = fakeGlass(), events = [], pendingStatus = [];
  let statusFailure = false;
  const ctx = vm.createContext({
    glassView, glassProviderSettings, KIMI_LOGIN_HINT, providerVisible, console,
    emit: (e) => events.push(e), fs: { existsSync: () => true }, GLASS_CLI: 'fixture-glass', GLASS_MISSING: 'Missing',
    glassSeen: null, glassReadVersion: 0, lastGlassStatus: null,
    glassCredential: () => ({ source: 'fixture', name: 'Fixture billing', follow: true }),
    defaults: { credential: { follow: true } }, panes: new Map(), kimi: { updateBilling: (s) => { ctx.billingStatus = s; } },
    execFile: (cli, args, opts, cb) => {
      if (args[0] === 'settings') return glass.exec(cli, args, opts, cb);
      if (args[0] === 'status') { const snapshot = JSON.stringify(glass.state); pendingStatus.push(() => cb(statusFailure ? new Error('offline') : null, snapshot, '')); return; }
      glass.calls.push({ cli, args, opts }); queueMicrotask(() => cb(null, '{"ok":true}', ''));
    },
  });
  vm.runInContext(`${functions}\nglobalThis.ops = { ${handlers} };`, ctx);
  return { ctx, glass, events, pendingStatus, failStatus: () => { statusFailure = true; }, flush: () => { while (pendingStatus.length) pendingStatus.shift()(); } };
}

test('engine settings and Kimi swaps refresh full status; stale reads cannot restore hidden data', async () => {
  const h = engineHarness();
  const first = h.ctx.ops.glass({}); h.flush(); await first;
  assert.equal(h.events.at(-1).kimi.name, 'Moon fixture');
  const stale = h.ctx.ops.glass({});
  const update = h.ctx.ops.glassProviders({ provider: 'kimi', visible: false, reqId: 'save' });
  await new Promise((r) => setImmediate(r));
  h.flush(); await Promise.all([stale, update]);
  assert.deepEqual(Array.from(h.events.at(-1).visibleProviders), ['claude', 'codex']);
  assert.equal(h.events.at(-1).lists.kimi.length, 2);
  assert.equal(h.ctx.billingStatus.accounts.filter((a) => a.provider === 'kimi').length, 2);
  const swap = h.ctx.ops.glassSwap({ provider: 'kimi', account: 'k2', reqId: 'swap' });
  await new Promise((r) => setImmediate(r)); h.flush(); await swap;
  assert.deepEqual(Array.from(h.glass.calls.at(-1).args).slice(0, 3), ['swap', 'kimi', 'k2']);
  assert.ok(h.glass.calls.at(-1).args.includes(flag('user-asked')));
  h.ctx.ops.glassLogin({ provider: 'kimi', reqId: 'login' });
  assert.equal(h.events.at(-1).message, KIMI_LOGIN_HINT);
});

test('a failed status read preserves the last visibility, including before the first successful status', async () => {
  const h = engineHarness(); h.failStatus();
  const change = h.ctx.ops.glassProviders({ provider: 'claude', visible: false });
  await new Promise((r) => setImmediate(r)); h.flush(); await change;
  assert.deepEqual(Array.from(h.events.at(-1).visibleProviders), ['codex', 'kimi']);
  const read = h.ctx.ops.glass({}); h.flush(); await read;
  assert.deepEqual(Array.from(h.events.at(-1).visibleProviders), ['codex', 'kimi']);
});

test('phone disconnection errors release the provider toggle without claiming it saved', (t) => {
  const d = dom(t), sent = [];
  const card = initGlassCard({ root: d.root, send: (op, args) => sent.push({ op, ...args }) });
  card.handle(statusEvent(fixture()));
  d.click(d.root.buttons.find((b) => b.settings));
  card.handle({ ev: 'glass_providers', reqId: sent.at(-1).reqId, ok: true, visibleProviders: null, knownProviders: ['claude', 'codex', 'kimi'] });
  d.click(d.panel().buttons.find((b) => b.dataset.provider === 'kimi'));
  assert.equal(d.panel().buttons.find((b) => b.dataset.provider === 'kimi').disabled, true);
  card.handle({ ev: 'error', reqId: sent.at(-1).reqId, message: 'The phone is disconnected.' });
  assert.match(d.panel().innerHTML, /phone is disconnected/);
  assert.equal(d.panel().buttons.find((b) => b.dataset.provider === 'kimi').disabled, false);
  assert.match(d.root.innerHTML, /data-p="kimi"/);
});

test('Glass-derived billing chips follow visibility and recover their name and headroom when shown', () => {
  const chip = { textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
  const p = Object.assign(Object.create(Pane.prototype), { kind: 'kimi', $: { billing: chip }, billing: kimiBilling(fixture()) });
  p.renderBilling();
  assert.equal(chip.hidden, false); assert.match(chip.textContent, /Moon fixture · 8% left/);
  p.billing = kimiBilling({ ...fixture(), visibleProviders: [] }); p.renderBilling();
  assert.equal(chip.hidden, true); assert.equal(chip.textContent, '');
  assert.equal(chip.attrs['aria-description'], undefined);
  p.billing = kimiBilling(fixture()); p.renderBilling();
  assert.equal(chip.hidden, false); assert.match(chip.textContent, /8% left/);
});

test('phone build ships the same Glass provider helper, panels and event wiring', (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-glass-phone-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  build({ relay: 'wss://relay.example', out });
  for (const file of ['glass-providers.js', 'glasscard.js', 'glasspanel.js', 'usage-rings.js']) {
    assert.equal(fs.readFileSync(path.join(out, file), 'utf8').replace(/\r\n/g, '\n'), fs.readFileSync(new URL(`../apaki/ui/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n'));
  }
  assert.match(fs.readFileSync(path.join(out, 'app.js'), 'utf8'), /case 'glass_providers':/);
});
