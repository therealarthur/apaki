/**
 * remote-page.js: before Apaki shows a pairing code, it checks the phone page
 * that code would open.
 *
 * Why (Arthur, 2026-10-10: "make it so its a trustless solution where other
 * users can use this to reach their remote computers after scanning the
 * mobile qr code"): the relay cannot read anything, but the phone runs
 * whatever code the website serves, and that is the one place a site
 * operator (us, a hijacked account, a bad DNS change) could get in. So the PC
 * does not take the site's word for it. The phone page is a reproducible
 * build of Apaki's own window code (apaki/scripts/build-web.mjs), and every
 * version is published at its own address that never changes
 * (<site>/v/<version>/). The PC builds the version it expects from its own
 * files, fetches each file of that version from the site, and compares
 * SHA-256 hashes. Only an exact match gets a pairing code, and the code opens
 * that exact version.
 *
 * What it cannot rule out (apaki/SECURITY.md 1.3): a site that serves the
 * right files to PCs and other files to browsers (a PC's fetch is easy to
 * tell from a phone's, by its TLS handshake if nothing else), and every page
 * load after pairing. The hourly re-check (remote.js recheckPages) narrows
 * the second: it fetches the versions this PC verified again with a phone
 * browser's User-Agent and headers, and turns phone access off on any
 * difference. It still runs from the PC's network and TLS stack.
 *
 * Fails closed (2026-10-10, SECURITY.md 5 item 1): 'unreachable' (no answer,
 * a timeout, or an HTTP error from the site) gets no pairing code either;
 * the Phone sheet offers "Pair without checking the page", labelled with
 * what it risks.
 *
 * checkPage({ web, relay, headers? }) -> { state, version, url, files, differs, missing, error, hashes, at }
 *   state: 'ok' (every file matches), 'differs' (some file is not what this
 *   Apaki would build), 'missing' (this version is not published there),
 *   'unreachable' (the PC could not reach the site, or the site answered
 *   with an error). hashes: the expected { path: sha256 } (what pages.json
 *   keeps for a verified version).
 */

import crypto from 'node:crypto';
import { expected } from '../scripts/build-web.mjs';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// The page a relay's build would be: built once per relay (about 0.1 s).
const builds = new Map();
export function expectedFor(relay) {
  if (!builds.has(relay)) builds.set(relay, expected({ relay }));
  return builds.get(relay);
}

/** The address a pairing code opens: <web>/v/<version>/ */
export function pageUrl(web, version) {
  const base = String(web || '').endsWith('/') ? String(web) : `${web}/`;
  return `${base}v/${version}/`;
}

/**
 * Phone browsers the hourly re-check looks like (2026-10-10, SECURITY.md 5
 * item 7): an iPhone with Safari and an Android phone with Chrome.
 */
export const PHONE_AGENTS = Object.freeze([
  { name: 'iPhone Safari', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1', extra: {} },
  { name: 'Android Chrome', ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36', extra: { 'sec-ch-ua': '"Chromium";v="141", "Google Chrome";v="141", "Not?A_Brand";v="99"', 'sec-ch-ua-mobile': '?1', 'sec-ch-ua-platform': '"Android"' } },
]);

/**
 * The request headers that phone browser would send for one file of the
 * page (what it accepts and why it asks, by the kind of file). Pass the
 * result as checkPage's `headers`.
 */
export function browserHeaders(agent = PHONE_AGENTS[0]) {
  return (rel) => {
    const name = String(rel || '');
    const base = { 'user-agent': agent.ua, 'accept-language': 'en-US,en;q=0.9', ...agent.extra };
    if (name === 'index.html' || name.endsWith('/index.html')) return { ...base, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', 'upgrade-insecure-requests': '1' };
    if (name === 'sw.js') return { ...base, accept: '*/*', 'sec-fetch-dest': 'serviceworker', 'sec-fetch-mode': 'same-origin', 'sec-fetch-site': 'same-origin', 'service-worker': 'script' };
    if (name.endsWith('.js')) return { ...base, accept: '*/*', 'sec-fetch-dest': 'script', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' };
    if (name.endsWith('.css')) return { ...base, accept: 'text/css,*/*;q=0.1', 'sec-fetch-dest': 'style', 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'same-origin' };
    if (/\.(png|svg|jpe?g|webp|gif|ico)$/i.test(name)) return { ...base, accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8', 'sec-fetch-dest': 'image', 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'same-origin' };
    if (name.endsWith('.woff2')) return { ...base, accept: '*/*', 'sec-fetch-dest': 'font', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' };
    if (name.endsWith('.webmanifest')) return { ...base, accept: '*/*', 'sec-fetch-dest': 'manifest', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' };
    return { ...base, accept: '*/*', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' };
  };
}

/**
 * Fetches every file of the expected version and compares hashes. Never throws.
 * headers: an object, or a function of the file's path, sent with every request (browserHeaders).
 * build: what to expect, (relay) -> { version, files }; a version verified before passes its own.
 */
export async function checkPage({ web, relay, fetch = globalThis.fetch, build = expectedFor, concurrency = 6, timeoutMs = 15000, headers = null } = {}) {
  const at = Date.now();
  let exp;
  try { exp = build(relay); } catch (e) { return { state: 'unreachable', version: null, url: null, files: 0, differs: [], missing: [], error: `could not build the expected page: ${e.message}`, hashes: null, at }; }
  const url = pageUrl(web, exp.version);
  const names = Object.keys(exp.files);
  const differs = [];
  const missing = [];
  let reached = 0;
  let error = null;
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const rel = names[next++];
      try {
        // A host serves a folder's index.html at the folder address (Cloudflare redirects the long form);
        // that address is what the phone opens, so it is the one checked. Redirects are refused.
        const at2 = rel === 'index.html' ? '' : rel.endsWith('/index.html') ? rel.slice(0, -'index.html'.length) : rel;
        const hdrs = typeof headers === 'function' ? headers(rel) : headers;
        const res = await fetch(url + at2, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store', redirect: 'error', ...(hdrs ? { headers: hdrs } : {}) });
        if (res.status === 404) { missing.push(rel); continue; }
        if (!res.ok) { error = `HTTP ${res.status} for ${rel}`; continue; }
        reached++;
        if (sha256(Buffer.from(await res.arrayBuffer())) !== exp.files[rel]) differs.push(rel);
      } catch (e) { error = e.message || String(e); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
  let state = 'unreachable';
  if (differs.length) state = 'differs';
  else if (missing.length === names.length) state = 'missing';
  else if (missing.length) state = 'differs'; // part of a version gone is not the version
  else if (reached === names.length) state = 'ok';
  return { state, version: exp.version, url, files: names.length, differs: differs.sort(), missing: missing.sort(), error, hashes: exp.files, at };
}

/** What the Phone sheet says about a check. */
export function pageText(p) {
  if (!p) return '';
  const host = (() => { try { return new URL(p.url).host; } catch { return 'the site'; } })();
  if (p.state === 'ok') return `Phone page checked: ${host} serves exactly the page this Apaki builds from its own code (version ${p.version}, ${p.files} files).`;
  if (p.state === 'differs') return `The phone page at ${host} is not the one this Apaki would build (${p.differs.length + p.missing.length} of ${p.files} files differ), so Apaki will not show a pairing code. Someone may have changed that site.`;
  if (p.state === 'missing') return `This Apaki's phone page (version ${p.version}) is not published at ${host} yet, so a phone would find nothing there.`;
  // Fails closed (2026-10-10): no check, no code. The sheet offers pairing without the check, saying what it risks.
  return `Apaki could not check the phone page at ${host}${p.error ? ` (${p.error})` : ''}, so it shows no pairing code. Try again in a moment.`;
}
