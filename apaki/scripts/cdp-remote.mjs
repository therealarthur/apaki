#!/usr/bin/env node
/**
 * cdp-remote.mjs: phone access end to end on one PC, with nothing deployed
 * (Track B part 2, 2026-10-09). Drives two browsers over CDP:
 *   - the Apaki window (a dev build started with
 *     WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<desktop>,
 *     APAKI_RELAY_URL pointing at a local relay or relay-tap.mjs, and
 *     APAKI_WEB_URL at the served apaki/web/dist);
 *   - a headless Chromium (Edge or Chrome) as the phone, at 390x844.
 *
 * It turns phone access on, shows the QR, opens the QR's link on the phone,
 * checks both screens show the same code, allows it on the desktop, waits
 * for the session list on the phone, opens one idle session there, and (with
 * --send) starts a new conversation on the phone, bills it to a vault key
 * (--billing, from the desktop: a phone cannot change billing), switches it
 * to Haiku at low effort and sends ONE message asking for --marker back.
 * With --revoke it then removes the phone on the desktop and checks the
 * phone says so. Screenshots (all at most 1320x860) go to <out>-*.png.
 *
 *   node apaki/scripts/cdp-remote.mjs --out shots/remote [--desktop 9342] [--phone 9343]
 *        [--send --marker APAKI-XYZ --billing myrlin.io] [--revoke]
 *
 * Prints a JSON summary, including the id of any session it created (delete
 * its transcript afterwards).
 */

import fs from 'node:fs';

const A = { desktop: 9342, phone: 9343, out: 'apaki-remote', billing: 'myrlin.io', marker: `APAKI-MARK-${Date.now().toString(36).toUpperCase()}` };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i].replace(/^--/, '');
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) A[k] = true; else { A[k] = v; i++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = { marker: A.marker, steps: [] };
const step = (s) => { R.steps.push(`${new Date().toISOString().slice(11, 19)} ${s}`); process.stderr.write(`${s}\n`); };

async function cdp(port, { pick = (t) => t.type === 'page' } = {}) {
  let ws;
  for (let i = 0; i < 120 && !ws; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const t = list.find(pick);
      if (t) ws = new WebSocket(t.webSocketDebuggerUrl);
    } catch { /* not up yet */ }
    if (!ws) await sleep(250);
  }
  if (!ws) throw new Error(`no page on CDP port ${port}`);
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (m) => { const j = JSON.parse(m.data); if (pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } });
  const call = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (expr) => {
    const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(`${expr.slice(0, 80)}: ${r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text}`);
    return r.result?.result?.value;
  };
  const waitFor = async (expr, ms = 30000, what = expr) => {
    for (let t = 0; t < ms; t += 250) { try { const v = await ev(expr); if (v) return v; } catch { /* page busy */ } await sleep(250); }
    throw new Error(`timed out waiting for ${what.slice(0, 120)}`);
  };
  const shot = async (name, w, h) => {
    const s = await call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
    await sleep(350); // let entrances (150 to 240 ms) finish
  const file = `${A.out}-${name}.png`;
    fs.writeFileSync(file, Buffer.from(s.result.data, 'base64'));
    return file;
  };
  return { call, ev, waitFor, shot, close: () => ws.close() };
}

const desk = await cdp(A.desktop);
await desk.call('Emulation.setDeviceMetricsOverride', { width: 1320, height: 860, deviceScaleFactor: 1, mobile: false });
await desk.waitFor('!!window.__apakiPhone && !!window.__apaki', 30000, 'the desktop app');
const theme = (c, t) => c.ev(`window.apakiTheme.set(${JSON.stringify(t)})`).then(() => sleep(450));
const deskShot = (name) => desk.shot(name, 1320, 860);
R.shots = [];

// Phone access on, then a QR. (An empty message box first: the window may
// have caught a stray key press when it opened.)
await desk.ev('(() => { const p = window.__apaki.focusedPane(); if (p) { p.$.input.value = ""; p.autosize(); } })()');
await theme(desk, 'light');
await desk.ev('window.__apakiPhone.open()');
await desk.waitFor('document.querySelector(".phone-sheet")', 10000, 'the Phone sheet');
if (!(await desk.ev('window.__apakiPhone.status()?.enabled'))) {
  await desk.ev('document.querySelector(".phone-sheet [data-k=toggle]").click()');
}
await desk.waitFor('window.__apakiPhone.status()?.state === "online"', 20000, 'phone access online');
step('phone access is on and the relay connection is up');
await desk.ev('document.querySelector(".phone-sheet [data-k=pair]")?.click()');
const url = await desk.waitFor('window.__apakiPhone.status()?.pairing?.url', 10000, 'the QR');
await desk.waitFor('document.querySelector(".ph-qr svg")', 5000, 'the QR drawn');
await sleep(400);
R.shots.push(await deskShot('desktop-qr-light'));
await theme(desk, 'dark');
R.shots.push(await deskShot('desktop-qr-dark'));
await theme(desk, 'light');
R.qrUrlLength = url.length;
R.qrUrlBase = url.split('#')[0];
step(`QR shows ${R.qrUrlBase}#p=<${url.split('#p=')[1].length} chars>`);

// The phone opens the QR's link, as the camera app would.
const phone = await cdp(A.phone);
await phone.call('Emulation.setUserAgentOverride', {
  userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  userAgentMetadata: { brands: [{ brand: 'Chromium', version: '141' }], fullVersion: '141.0.0.0', platform: 'Android', platformVersion: '15.0.0', architecture: '', model: 'Pixel 9', mobile: true },
});
await phone.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await phone.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await phone.call('Page.enable');
// A phone that never saw Apaki: no saved pairing, no service worker or cache from an earlier run.
await phone.call('Page.navigate', { url: 'about:blank' });
await sleep(300);
await phone.call('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'all' });
await phone.call('Page.navigate', { url });
await phone.waitFor('!!window.apakiTheme', 10000, 'the phone page');
await theme(phone, 'light');
const phoneSas = await phone.waitFor('document.querySelector(".pair-code")?.dataset.sas', 20000, 'the code on the phone');
const deskReq = await desk.waitFor('window.__apakiPhone.status()?.request', 10000, 'the request on the desktop');
R.sas = { phone: phoneSas, desktop: deskReq.sas, same: phoneSas === deskReq.sas, deviceName: deskReq.name };
R.phoneAddressBar = await phone.ev('location.href');
step(`codes: phone ${phoneSas}, desktop ${deskReq.sas} (${deskReq.name}); phone address bar now ${R.phoneAddressBar}`);
await desk.waitFor('document.querySelector(".ph-sas")', 5000, 'the approval step');
await sleep(300);
R.shots.push(await deskShot('desktop-sas-light'));
R.shots.push(await phone.shot('phone-sas-light', 390, 844));
if (!R.sas.same) throw new Error('the codes differ');
await desk.ev('document.querySelector(".phone-sheet [data-k=allow]").click()');

// Paired: Apaki's own UI runs on the phone, with the session list.
await phone.waitFor('document.body.classList.contains("linked") && !!window.__apaki && document.querySelectorAll("#sessions li[data-id]").length > 0', 30000, 'the session list on the phone');
R.phoneSessions = await phone.ev('window.__apaki.S.sessions.length');
step(`paired; the phone lists ${R.phoneSessions} sessions`);
await sleep(500);
await theme(phone, 'light');
R.shots.push(await phone.shot('phone-drawer-light', 390, 844));
await theme(phone, 'dark');
R.shots.push(await phone.shot('phone-drawer-dark', 390, 844));
await theme(phone, 'light');
await desk.waitFor('window.__apakiPhone.status()?.devices?.some((d) => d.connected)', 10000, 'connected on the desktop');
await sleep(400);
R.shots.push(await deskShot('desktop-paired-light'));
await theme(desk, 'dark');
R.shots.push(await deskShot('desktop-paired-dark'));
await theme(desk, 'light');
R.deviceId = await desk.ev('window.__apakiPhone.status().devices.find((d) => d.connected).id');

// Open one idle session on the phone (tap it in the drawer).
const opened = await phone.ev(`(async () => {
  const now = Date.now();
  const S = window.__apaki.S;
  const want = ${JSON.stringify(typeof A.open === 'string' ? A.open : null)};
  const pool = want ? S.sessions.filter((x) => x.id === want) : S.sessions.filter((x) => x.id && !x.terminal && !x.codex && (now - (x.lastModified || now)) > 6 * 3600e3 && (x.title || '').length < 60).slice(0, 4);
  for (const s of pool) {
    const li = document.querySelector('#sessions li[data-id="' + s.id + '"]');
    if (!li) continue;
    li.click();
    for (let t = 0; t < 60; t++) {
      await new Promise((r) => setTimeout(r, 250));
      const p = window.__apaki.focusedPane();
      if (p?.sessionId === s.id && p.$.T.querySelector('.turn-assistant')) return { id: s.id, title: s.title, turns: p.$.T.querySelectorAll('.turn-assistant, .turn-user').length };
      if (p?.$.T.querySelector('.takeover')) break;
    }
  }
  return null;
})()`);
R.openedOnPhone = opened;
step(opened ? `opened "${opened.title}" on the phone (${opened.turns} turns drawn)` : 'no idle session could be opened on the phone');
await sleep(600);
R.shots.push(await phone.shot('phone-session-light', 390, 844));
await theme(phone, 'dark');
R.shots.push(await phone.shot('phone-session-dark', 390, 844));
await theme(phone, 'light');

if (A.takeover && opened) {
  // The same session on the desktop: the card says the phone has it; take it
  // over there, then take it back on the phone (no message is sent).
  await desk.ev('document.querySelector(".phone-sheet [data-k=done]")?.click()');
  await desk.ev(`window.__apaki.dropSession({ id: ${JSON.stringify(opened.id)}, cwd: '', title: ${JSON.stringify(opened.title)} }, 'right')`);
  const deskCard = await desk.waitFor('(() => { const c = [...document.querySelectorAll(".pane .takeover")].pop(); return c ? c.querySelector("h3").textContent : null; })()', 15000, 'the desktop "in use" card');
  step(`desktop card: "${deskCard}"`);
  R.shots.push(await deskShot('desktop-inuse-light'));
  await desk.ev('[...document.querySelectorAll(".pane .takeover .tk-go")].pop().click()');
  const phoneCard = await phone.waitFor('(() => { const c = document.querySelector(".pane .takeover"); return c ? c.querySelector("h3").textContent : null; })()', 15000, 'the phone "taken over" card');
  step(`phone card after the desktop took over: "${phoneCard}"`);
  R.shots.push(await phone.shot('phone-takenover-light', 390, 844));
  await phone.ev('document.querySelector(".pane .takeover .tk-go").click()');
  const backCard = await desk.waitFor('(() => { const c = [...document.querySelectorAll(".pane .takeover")].pop(); return c && /took/.test(c.querySelector("h3").textContent) ? c.querySelector("h3").textContent : null; })()', 15000, 'the desktop "taken over" card');
  await phone.waitFor('(() => { const p = window.__apaki.focusedPane(); return p.sessionId && !p.$.T.querySelector(".takeover") && p.$.T.querySelector(".turn-assistant"); })()', 20000, 'the session back on the phone');
  step(`desktop card after the phone took it back: "${backCard}"`);
  R.takeover = { desktopSaw: deskCard, phoneSaw: phoneCard, desktopAfter: backCard };
  // Close the desktop pane again, back to one pane.
  await desk.ev('(() => { const A = window.__apaki; const ids = A.L.ids(A.activeTab().root); if (ids.length > 1) { const p = A.S.panes.get(ids[ids.length - 1]); p.$.close.click(); } })()');
  await desk.ev('window.__apakiPhone.open()');
}

if (A.reconnect && opened) {
  // Drop the phone's connection: it comes back by itself and re-attaches its pane.
  const before = await phone.ev('window.__apaki.focusedPane().sessionId');
  await phone.ev('window.__apakiLink.drop()');
  await phone.waitFor('window.__apakiLink.state() !== "open"', 5000, 'the link dropping');
  await phone.waitFor('window.__apakiLink.state() === "open"', 30000, 'the link coming back');
  await phone.waitFor(`(() => { const p = window.__apaki.focusedPane(); return p.sessionId === ${JSON.stringify(before)} && p.$.T.querySelector('.turn-assistant'); })()`, 20000, 'the pane re-attached');
  R.reconnect = { sameSession: true };
  step('dropped the phone connection; it reconnected and re-attached its pane');
}

if (A.send) {
  // A new conversation on the phone, billed to the vault key from the desktop.
  await phone.ev('document.getElementById("new").click()');
  await phone.waitFor('(() => { const p = window.__apaki.focusedPane(); return p && !p.sessionId && p.title === "New conversation"; })()', 15000, 'a new conversation on the phone');
  const local = await phone.ev('window.__apaki.focusedPane().id');
  const enginePane = `phone:${R.deviceId}:${local}`;
  await desk.ev(`window.__TAURI__.core.invoke('engine_send', { msg: { op: 'billing', reqId: 'billing-test', paneId: ${JSON.stringify(enginePane)}, value: ${JSON.stringify(A.billing)} } })`);
  R.billing = await phone.waitFor(`(() => { const b = window.__apaki.focusedPane().billing; return b && /${A.billing.replace(/[.]/g, '\\.')}/i.test(b.name) ? b.name : null; })()`, 15000, 'the vault billing on the phone');
  step(`the phone pane bills to ${R.billing}`);
  // Haiku at low effort, picked from the chips like a person would.
  await phone.ev('window.__apaki.focusedPane().$.model.click()');
  await phone.waitFor('[...document.querySelectorAll(".menu .menu-item")].some((b) => /Haiku/.test(b.textContent))', 5000, 'the model menu');
  await phone.ev('[...document.querySelectorAll(".menu .menu-item")].find((b) => /Haiku/.test(b.textContent)).click()');
  await sleep(400);
  await phone.ev('window.__apaki.focusedPane().$.effort.click()');
  await phone.waitFor('[...document.querySelectorAll(".menu .menu-item")].some((b) => b.textContent.includes("low"))', 5000, 'the effort menu');
  await phone.ev('[...document.querySelectorAll(".menu .menu-item")].find((b) => b.querySelector(".ml")?.textContent === "low").click()');
  await phone.waitFor('(() => { const p = window.__apaki.focusedPane(); return p.model === "claude-haiku-5-5" && p.effort === "low"; })()', 10000, 'Haiku at low effort');
  await sleep(1500);
  const text = `Reply with exactly this code and nothing else: ${A.marker}`;
  await phone.ev(`(() => { const p = window.__apaki.focusedPane(); p.$.input.value = ${JSON.stringify(text)}; p.autosize(); p.$.send.click(); })()`);
  step('sent one message from the phone');
  const t0 = Date.now();
  const done = await phone.waitFor(`(() => { const p = window.__apaki.focusedPane(); if (p.busy || !p.$.T.querySelector('.foot')) return null; const a = [...p.$.T.querySelectorAll('.turn-assistant')].pop(); return { reply: a ? a.textContent.trim() : '', foot: p.$.T.querySelector('.foot').textContent, sessionId: p.sessionId, errors: [...p.$.T.querySelectorAll('.note.error')].map((n) => n.textContent) }; })()`, 180000, 'the reply on the phone');
  R.turn = { ...done, seconds: Math.round((Date.now() - t0) / 100) / 10, markerInReply: done.reply.includes(A.marker) };
  step(`reply on the phone in ${R.turn.seconds}s: "${done.reply.slice(0, 80)}" (${done.foot})`);
  await sleep(400);
  R.shots.push(await phone.shot('phone-reply-light', 390, 844));
  await theme(phone, 'dark');
  R.shots.push(await phone.shot('phone-reply-dark', 390, 844));
  await theme(phone, 'light');
}

// The desktop's view of it now: connected, with its conversations.
await sleep(300);
R.desktopDevice = await desk.ev('window.__apakiPhone.status().devices.find((d) => d.connected) || null');
R.shots.push(await deskShot('desktop-connected-light'));
await theme(desk, 'dark');
R.shots.push(await deskShot('desktop-connected-dark'));
await theme(desk, 'light');

if (A.revoke) {
  await desk.ev(`document.querySelector('.phone-sheet [data-k=revoke][data-id="${R.deviceId}"]').click()`);
  await sleep(200);
  await desk.ev(`document.querySelector('.phone-sheet [data-k=revoke][data-id="${R.deviceId}"]').click()`);
  await desk.waitFor('window.__apakiPhone.status().devices.length === 0', 10000, 'the phone removed on the desktop');
  const said = await phone.waitFor('(() => { const s = document.getElementById("pairScreen"); return !s.hidden && !document.body.classList.contains("linked") && /removed/i.test(s.textContent) ? s.querySelector("h1").textContent : null; })()', 20000, 'the phone saying it was removed');
  R.revoked = { phoneSays: said };
  step(`removed on the desktop; the phone says "${said}"`);
  R.shots.push(await phone.shot('phone-removed-light', 390, 844));
}

await desk.ev('document.querySelector(".phone-sheet [data-k=done]")?.click()');
desk.close();
phone.close();
process.stdout.write(`${JSON.stringify(R, null, 2)}\n`);
