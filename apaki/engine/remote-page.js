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
 * What it cannot rule out: a site that serves the right files to the PC and
 * other files to one particular phone. That needs the site to single the
 * phone out, and every PC checking the same address makes a general swap
 * visible at once. See relay/README.md.
 *
 * checkPage({ web, relay }) -> { state, version, url, files, differs, missing, error, at }
 *   state: 'ok' (every file matches), 'differs' (some file is not what this
 *   Apaki would build), 'missing' (this version is not published there),
 *   'unreachable' (the PC could not reach the site; a phone may still).
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

/** Fetches every file of the expected version and compares hashes. Never throws. */
export async function checkPage({ web, relay, fetch = globalThis.fetch, build = expectedFor, concurrency = 6, timeoutMs = 15000 } = {}) {
  const at = Date.now();
  let exp;
  try { exp = build(relay); } catch (e) { return { state: 'unreachable', version: null, url: null, files: 0, differs: [], missing: [], error: `could not build the expected page: ${e.message}`, at }; }
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
        const res = await fetch(url + at2, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store', redirect: 'error' });
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
  return { state, version: exp.version, url, files: names.length, differs: differs.sort(), missing: missing.sort(), error, at };
}

/** What the Phone sheet says about a check. */
export function pageText(p) {
  if (!p) return '';
  const host = (() => { try { return new URL(p.url).host; } catch { return 'the site'; } })();
  if (p.state === 'ok') return `Phone page checked: ${host} serves exactly the page this Apaki builds from its own code (version ${p.version}, ${p.files} files).`;
  if (p.state === 'differs') return `The phone page at ${host} is not the one this Apaki would build (${p.differs.length + p.missing.length} of ${p.files} files differ), so Apaki will not show a pairing code. Someone may have changed that site.`;
  if (p.state === 'missing') return `This Apaki's phone page (version ${p.version}) is not published at ${host} yet, so a phone would find nothing there.`;
  return `Apaki could not reach ${host} to check the phone page${p.error ? ` (${p.error})` : ''}. A phone may still reach it.`;
}
