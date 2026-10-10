/**
 * account.js: Apaki accounts on the relay (contract: apaki/remote/ACCOUNTS.md).
 *
 * A passkey-only account lets a browser that was never paired sign in, fetch
 * one encrypted vault (which only the user's passkey can open, through the
 * WebAuthn PRF extension, on the phone) and connect to the user's PCs with
 * the normal reconnect handshake. The relay keeps, per account: a display
 * name, the passkeys' public keys and counters, the vault blob, a session
 * generation, and spent challenges until they expire. Nothing it holds opens
 * the vault or names a PC.
 *
 * Split of work:
 *   - handleAccount (the Worker): routes, the Origin rule, ACCOUNT_KEY, the
 *     per-IP limit (key "acct:<ip>", so sign-ins do not eat the socket budget),
 *     the daily budget, JSON bodies with size caps, input shapes, and token MACs.
 *   - Account (one Durable Object per account id, SQLite backed): every WebAuthn
 *     check (webauthn.js) and every state change, one at a time.
 *   - handlePresence: GET /v1/rooms/<roomId>/presence asks the Room object
 *     whether its PC socket is up, without touching any socket.
 *
 * Nothing here logs: no bodies, no tokens, no keys.
 */

import { DurableObject } from 'cloudflare:workers';
import { costOf, ROLE_HEADER, clientKey, nextUtcMidnight, utcDay } from './lib.js';
import { verifyRegistration, verifyAssertion, counterOk, WebAuthnError, MAX_CREDENTIAL_ID } from './webauthn.js';
import {
  LIMITS, PURPOSES, accountConfig, loadKey, signToken, readChallengeToken, readSessionToken, challengeClaims, sessionClaims,
  bearerOf, cleanName, checkCredential, checkVault, b64uField, newAccountId, newChallenge, nowSeconds,
  passkeyLabel, accountView, vaultView, isPlainObject, fail, ok,
} from './account-lib.js';

/* ===== answers ===== */

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  // Account answers carry sessions and vaults: never cached anywhere.
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
});

function respond({ status, body }, headers = {}) {
  const extra = status === 401 ? { 'www-authenticate': 'Bearer', ...headers } : headers;
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function hoursToMidnight(day) {
  return Math.ceil((Date.parse(`${day}T00:00:00Z`) + 86_400_000 - Date.now()) / 3_600_000);
}

/* ===== guards ===== */

/** The Origin rule: absent (same-origin GETs, non-browser clients) or exactly the account origin. */
function originRefused(request, cfg) {
  const origin = request.headers.get('Origin');
  return origin !== null && origin !== cfg.origin;
}

/**
 * The per-IP limit with its own key prefix; skipped when the binding is absent or IP_LIMIT is off.
 * Since 2026-10-10 an IPv6 client is counted per /64 (lib.js clientKey), like the sockets.
 */
async function ipLimited(request, env, prefix) {
  if (!env.CONNECTS || env.IP_LIMIT === 'off') return false;
  const ip = clientKey(request.headers.get('CF-Connecting-IP'));
  const { success } = await env.CONNECTS.limit({ key: `${prefix}${ip}` });
  return !success;
}

/**
 * Today's budget and this address's share of it (budget fairness, 2026-10-10):
 * `usd` is added to both in parallel. Returns null when the request may go on,
 * else the answer: 503 budget (the whole relay's day is spent) or 429 share
 * (only this address's). Without a gate (an older caller) only the budget counts.
 */
async function budgetRefusal(request, env, usd, { spend, gate }, what) {
  const addr = clientKey(request.headers.get('CF-Connecting-IP'));
  const [budget, mine] = await Promise.all([spend(env, usd), gate ? gate(env, addr, { add: usd }) : null]);
  if (budget.over) return respond(fail(503, 'budget', `The Apaki relay has used today's budget; ${what} again after 00:00 UTC (in about ${hoursToMidnight(budget.day)} h).`), { 'retry-after': '1800' });
  if (mine?.over) {
    const retry = String(Math.max(60, Math.ceil((nextUtcMidnight() - Date.now()) / 1000)));
    return respond(fail(429, 'share', `This address has used its share of today's Apaki relay budget; ${what} again after 00:00 UTC (in about ${hoursToMidnight(mine.day || utcDay())} h).`), { 'retry-after': retry });
  }
  return null;
}

/**
 * Reads a JSON object body of at most `cap` bytes. The body is streamed, so a
 * client that lies about (or omits) content-length cannot make the Worker
 * buffer more than the cap. Returns { body } or { error } (an answer).
 */
async function readJson(request, cap) {
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return { error: fail(415, 'content-type', 'send content-type: application/json') };
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) return { error: fail(413, 'too-large', `the body is larger than ${cap} bytes`) };
  if (!request.body) return { error: fail(400, 'bad-json', 'the body is empty') };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await drain(reader, size);
      return { error: fail(413, 'too-large', `the body is larger than ${cap} bytes`) };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { bytes.set(c, o); o += c.byteLength; }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return { error: fail(400, 'bad-json', 'the body is not JSON') }; }
  if (!isPlainObject(body)) return { error: fail(400, 'bad-json', 'the body must be a JSON object') };
  return { body };
}

/* ===== routes ===== */

/**
 * The route table: path pattern, then a handler per method. Each handler gets
 * a context { request, env, key, cfg, params } and returns an answer object.
 */
const ROUTES = [
  { re: /^\/v1\/account$/, methods: { GET: getAccount, DELETE: deleteAccount } },
  { re: /^\/v1\/account\/challenge$/, methods: { POST: challenge } },
  { re: /^\/v1\/account\/register$/, methods: { POST: register } },
  { re: /^\/v1\/account\/signin$/, methods: { POST: signin } },
  { re: /^\/v1\/account\/vault$/, methods: { PUT: putVault } },
  { re: /^\/v1\/account\/passkeys$/, methods: { POST: addPasskey } },
  { re: /^\/v1\/account\/passkeys\/([A-Za-z0-9_-]{1,1400})$/, methods: { DELETE: removePasskey } },
  { re: /^\/v1\/account\/rename$/, methods: { POST: rename } },
  { re: /^\/v1\/account\/signout-all$/, methods: { POST: signoutAll } },
];

/**
 * Every /v1/account request. Order: route, Origin, configuration and key,
 * per-IP limit, daily budget, then the handler (which reads and checks the body).
 * @param {{ spend: (env: object, usd: number) => Promise<{ day: string, over: boolean }>, gate?: (env: object, addr: string, op: object) => Promise<{ over: boolean }> }} deps
 *   the Worker's budget guard, and (since 2026-10-10) its per-address share
 */
export async function handleAccount(request, env, url, deps) {
  const answer = await accountAnswer(request, env, url, deps);
  await releaseBody(request);
  return answer;
}

/** Unread request bytes the Worker reads and drops before answering; past this it cancels the upload. */
const DRAIN_MAX = 256 * 1024;

/**
 * Reads and drops `reader`'s remaining bytes up to DRAIN_MAX in all (counting
 * `already`), then cancels. Seen with wrangler 4.149 locally: answering
 * without consuming a large body (some 90 KB) loses the next request on the
 * same connection, and cancelling outright resets the connection, so the
 * relay drains what a real client might send and only cuts off abuse.
 */
async function drain(reader, already = 0) {
  let size = already;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      size += value.byteLength;
      if (size > DRAIN_MAX) { await reader.cancel(); return; }
    }
  } catch { /* the client went away */ }
}

/** Drains a request body nobody read (an early 4xx/5xx, or a route that takes no body). */
async function releaseBody(request) {
  if (!request.body || request.bodyUsed) return;
  await drain(request.body.getReader());
}

async function accountAnswer(request, env, url, { spend, gate }) {
  try {
    const route = ROUTES.find((r) => r.re.test(url.pathname));
    if (!route) return respond(fail(404, 'not-found', 'no such account route'));
    // Own properties only: a method named like an Object.prototype member must not resolve to it.
    const handler = Object.hasOwn(route.methods, request.method) ? route.methods[request.method] : null;
    if (!handler) return respond(fail(405, 'method', 'method not allowed'), { allow: Object.keys(route.methods).join(', ') });

    const cfg = accountConfig(env);
    if (!cfg) return respond(fail(503, 'config', 'accounts are misconfigured on this relay (ACCOUNT_ORIGIN)'));
    if (originRefused(request, cfg)) return respond(fail(403, 'origin', 'this origin may not use accounts'));
    const key = await loadKey(env);
    if (!key) return respond(fail(503, 'no-key', 'accounts are not set up on this relay (ACCOUNT_KEY)'));

    if (await ipLimited(request, env, 'acct:')) return respond(fail(429, 'rate', 'too many account requests from this address; try again in a minute'), { 'retry-after': '60' });
    // Today's budget (503 budget) and, since 2026-10-10, this address's share of it (429 share).
    const refusal = await budgetRefusal(request, env, costOf({ accountOps: 1 }), { spend, gate }, 'accounts work');
    if (refusal) return refusal;

    const params = route.re.exec(url.pathname).slice(1);
    return respond(await handler({ request, env, key, cfg, params }));
  } catch {
    return respond(fail(500, 'internal', 'internal error'));
  }
}

function accountStub(env, accountId) {
  return env.ACCOUNTS.get(env.ACCOUNTS.idFromName(accountId));
}

async function sessionOf(ctx) {
  const s = await readSessionToken(ctx.key, bearerOf(ctx.request));
  return s ? { s } : { error: fail(401, 'bad-session', 'sign in again (the session is missing, expired or not valid)') };
}

/** Signs a session for an answer from the Account object that says { issue: { a, g } }. */
async function withSession(ctx, r) {
  if (r.status !== 200) return { status: r.status, body: r.body };
  const session = await signToken(ctx.key, sessionClaims(r.issue.a, r.issue.g));
  return ok({ session, ...r.body });
}

/** POST /v1/account/challenge { purpose } */
async function challenge(ctx) {
  const { body, error } = await readJson(ctx.request, LIMITS.BODY_MAX);
  if (error) return error;
  const purpose = body.purpose;
  if (!PURPOSES.includes(purpose)) return fail(400, 'bad-purpose', `purpose is one of ${PURPOSES.join(', ')}`);
  const c = newChallenge();
  const base = { challenge: c, rpId: ctx.cfg.rpId, rpName: ctx.cfg.rpName };
  if (purpose === 'register') {
    const a = newAccountId();
    return ok({ ...base, token: await signToken(ctx.key, challengeClaims('register', c, a)), accountId: a });
  }
  if (purpose === 'signin') return ok({ ...base, token: await signToken(ctx.key, challengeClaims('signin', c)) });
  // add: a passkey for the signed-in account; the object checks the session and lists what to exclude.
  const { s, error: se } = await sessionOf(ctx);
  if (se) return se;
  const r = await accountStub(ctx.env, s.a).exclude(s);
  if (r.status !== 200) return r;
  return ok({ ...base, token: await signToken(ctx.key, challengeClaims('add', c, s.a)), accountId: s.a, exclude: r.body.exclude });
}

/** POST /v1/account/register { token, name, credential } */
async function register(ctx) {
  const { body, error } = await readJson(ctx.request, LIMITS.BODY_MAX);
  if (error) return error;
  const t = await readChallengeToken(ctx.key, body.token, 'register');
  if (!t) return fail(401, 'bad-token', 'the challenge is missing, expired or not valid; ask for a new one');
  const name = cleanName(body.name);
  if (!name) return fail(400, 'bad-name', `the name must be 1 to ${LIMITS.NAME_MAX} characters, without control characters`);
  const credential = checkCredential(body.credential, 'create');
  if (!credential) return fail(400, 'bad-credential', 'the credential is malformed');
  return withSession(ctx, await accountStub(ctx.env, t.a).register({ a: t.a, challenge: t.c, exp: t.exp, name, credential }));
}

/** POST /v1/account/signin { token, credential }: the userHandle names the account. */
async function signin(ctx) {
  const { body, error } = await readJson(ctx.request, LIMITS.BODY_MAX);
  if (error) return error;
  const t = await readChallengeToken(ctx.key, body.token, 'signin');
  if (!t) return fail(401, 'bad-token', 'the challenge is missing, expired or not valid; ask for a new one');
  const credential = checkCredential(body.credential, 'get');
  if (!credential) return fail(400, 'bad-credential', 'the credential is malformed (it needs id, clientDataJSON, authenticatorData, signature and a 16-byte userHandle)');
  return withSession(ctx, await accountStub(ctx.env, credential.userHandle).signin({ a: credential.userHandle, challenge: t.c, exp: t.exp, credential }));
}

/** GET /v1/account */
async function getAccount(ctx) {
  const { s, error } = await sessionOf(ctx);
  if (error) return error;
  return accountStub(ctx.env, s.a).view(s);
}

/** PUT /v1/account/vault { ver, vault } */
async function putVault(ctx) {
  const { s, error } = await sessionOf(ctx);
  if (error) return error;
  const { body, error: be } = await readJson(ctx.request, LIMITS.VAULT_BODY_MAX);
  if (be) return be;
  if (!Number.isSafeInteger(body.ver) || body.ver < 0) return fail(400, 'bad-vault', 'ver must be the vault version you read (0 when there is none)');
  const vault = checkVault(body.vault);
  if (!vault) return fail(400, 'bad-vault', 'the vault must be { iv, ct, wraps: { <credId>: { iv, ct } } } in base64url, with 12-byte ivs');
  return accountStub(ctx.env, s.a).putVault({ ...s, ver: body.ver, vault });
}

/** POST /v1/account/passkeys { token (purpose add), credential } */
async function addPasskey(ctx) {
  const { s, error } = await sessionOf(ctx);
  if (error) return error;
  const { body, error: be } = await readJson(ctx.request, LIMITS.BODY_MAX);
  if (be) return be;
  const t = await readChallengeToken(ctx.key, body.token, 'add');
  if (!t || t.a !== s.a) return fail(401, 'bad-token', 'the challenge is missing, expired, not valid or for another account; ask for a new one');
  const credential = checkCredential(body.credential, 'create');
  if (!credential) return fail(400, 'bad-credential', 'the credential is malformed');
  return accountStub(ctx.env, s.a).addPasskey({ ...s, challenge: t.c, exp: t.exp, credential });
}

/** DELETE /v1/account/passkeys/<credId> */
async function removePasskey(ctx) {
  const { s, error } = await sessionOf(ctx);
  if (error) return error;
  const credId = b64uField(ctx.params[0], 1, MAX_CREDENTIAL_ID);
  if (!credId) return fail(400, 'bad-credential', 'not a credential id');
  return accountStub(ctx.env, s.a).removePasskey({ ...s, credId });
}

/** POST /v1/account/rename { name } */
async function rename(ctx) {
  const { s, error } = await sessionOf(ctx);
  if (error) return error;
  const { body, error: be } = await readJson(ctx.request, LIMITS.BODY_MAX);
  if (be) return be;
  const name = cleanName(body.name);
  if (!name) return fail(400, 'bad-name', `the name must be 1 to ${LIMITS.NAME_MAX} characters, without control characters`);
  return accountStub(ctx.env, s.a).rename({ ...s, name });
}

/** POST /v1/account/signout-all (no body needed) */
async function signoutAll(ctx) {
  const { s, error } = await sessionOf(ctx);
  if (error) return error;
  return accountStub(ctx.env, s.a).signoutAll(s);
}

/** DELETE /v1/account */
async function deleteAccount(ctx) {
  const { s, error } = await sessionOf(ctx);
  if (error) return error;
  return accountStub(ctx.env, s.a).remove(s);
}

/* ===== presence ===== */

/**
 * GET /v1/rooms/<roomId>/presence: { pc: boolean }, whether the room's PC is
 * connected now. Same Origin rule as the account routes; counts toward the
 * budget and its own per-IP key ("pres:<ip>"). Anyone who knows a room id can
 * already learn this from a phone socket's ready message.
 *
 * Since 2026-10-10 it is priced as what it is (lib.js costOf presence: the
 * question wakes the room) and counts toward the address's share too.
 */
export async function handlePresence(request, env, roomId, { spend, gate }) {
  try {
    if (request.method !== 'GET') return respond(fail(405, 'method', 'method not allowed'), { allow: 'GET' });
    const cfg = accountConfig(env);
    if (!cfg) return respond(fail(503, 'config', 'accounts are misconfigured on this relay (ACCOUNT_ORIGIN)'));
    if (originRefused(request, cfg)) return respond(fail(403, 'origin', 'this origin may not ask'));
    if (await ipLimited(request, env, 'pres:')) return respond(fail(429, 'rate', 'too many presence requests from this address; try again in a minute'), { 'retry-after': '60' });
    const refusal = await budgetRefusal(request, env, costOf({ presence: 1 }), { spend, gate }, 'presence works');
    if (refusal) return refusal;
    const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
    const res = await stub.fetch(new Request(`https://room/v1/rooms/${roomId}/presence`, { method: 'GET', headers: { [ROLE_HEADER]: 'presence' } }));
    const answer = await res.json();
    return respond(ok({ pc: answer.pc === true }));
  } catch {
    return respond(fail(500, 'internal', 'internal error'));
  }
}

/* ===== Account object ===== */

const iso = (now = Date.now()) => new Date(now).toISOString();

function webauthnFailure(e) {
  if (e instanceof WebAuthnError) return fail(401, 'webauthn', e.message);
  throw e;
}

/** Spent challenges that have not expired yet (an object { challenge: exp seconds }). */
function liveSpent(spent, nowS) {
  const out = {};
  for (const [c, exp] of Object.entries(spent || {})) if (exp > nowS) out[c] = exp;
  return out;
}

/** What is stored for one passkey. */
function credRecord(credential, verified, now) {
  return {
    id: credential.id,
    alg: verified.alg,
    jwk: verified.jwk,
    signCount: verified.signCount,
    transports: credential.transports,
    label: passkeyLabel(verified.aaguid, credential.transports),
    aaguid: verified.aaguid,
    be: verified.be,
    bs: verified.bs,
    created: iso(now),
    // The passkey was just used to make the account (or to add itself).
    lastUsed: iso(now),
  };
}

/**
 * One Apaki account. Storage keys: 'account' { id, name, created, gen, creds },
 * 'vault' { ver, iv, ct, wraps } (absent until the first PUT), 'spent'
 * { <challenge>: exp } (successful ceremonies, until their tokens expire).
 *
 * Every method runs inside serial(): the WebAuthn checks await WebCrypto,
 * which (unlike storage calls) lets other requests into the object, so without
 * the queue two requests could both read the same state and both write. With
 * it, check-then-write is atomic: a challenge is spent once, a counter only
 * grows, and the vault version is a real compare-and-swap.
 *
 * The Worker has already checked token MACs, expiry and input shapes; this
 * object checks the session generation, WebAuthn, and the account's own rules.
 * Methods answer { status, body } (and { issue: { a, g } } when a session should be signed).
 */
export class Account extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.tail = Promise.resolve();
  }

  /** Runs fn after every earlier call has finished; an unexpected error becomes a 500 answer. */
  serial(fn) {
    const run = this.tail.then(() => fn());
    this.tail = run.then(() => {}, () => {});
    return run.catch(() => fail(500, 'internal', 'internal error'));
  }

  async load() {
    const m = await this.ctx.storage.get(['account', 'vault', 'spent']);
    return { account: m.get('account') || null, vault: m.get('vault') || null, spent: m.get('spent') || {} };
  }

  expect(challenge) {
    const cfg = accountConfig(this.env);
    if (!cfg) throw new Error('ACCOUNT_ORIGIN is not a valid origin');
    return { challenge, origin: cfg.origin, rpId: cfg.rpId };
  }

  /** null when the session { a, g } still holds, else the answer that says why not. */
  sessionFailure(st, s) {
    if (!st.account || st.account.id !== s.a) return fail(401, 'no-account', 'this account no longer exists');
    if (st.account.gen !== s.g) return fail(401, 'signed-out', 'this session was signed out; sign in again');
    return null;
  }

  /** The spent list with `challenge` added, or an answer when it was already spent (or the list is full). */
  spend(st, challenge, exp) {
    const spent = liveSpent(st.spent, nowSeconds());
    if (Object.hasOwn(spent, challenge)) return { error: fail(401, 'challenge-used', 'this challenge was already used; ask for a new one') };
    if (Object.keys(spent).length >= LIMITS.SPENT_MAX) return { error: fail(429, 'rate', 'too many sign-ins on this account; try again in a few minutes') };
    spent[challenge] = exp;
    return { spent };
  }

  /** Passkey ids to exclude when adding one; refuses early when the account is full. */
  exclude(s) {
    return this.serial(async () => {
      const st = await this.load();
      const bad = this.sessionFailure(st, s);
      if (bad) return bad;
      if (st.account.creds.length >= LIMITS.MAX_PASSKEYS) return fail(409, 'too-many', `an account has at most ${LIMITS.MAX_PASSKEYS} passkeys`);
      return ok({ exclude: st.account.creds.map((c) => c.id) });
    });
  }

  register({ a, challenge, exp, name, credential }) {
    return this.serial(async () => {
      const st = await this.load();
      if (st.account) return fail(409, 'exists', 'this account already exists');
      if (Object.hasOwn(liveSpent(st.spent, nowSeconds()), challenge)) return fail(401, 'challenge-used', 'this challenge was already used; ask for a new one');
      let verified;
      try { verified = await verifyRegistration(credential, this.expect(challenge)); } catch (e) { return webauthnFailure(e); }
      const sp = this.spend(st, challenge, exp);
      if (sp.error) return sp.error;
      const now = Date.now();
      const account = { id: a, name, created: iso(now), gen: 0, creds: [credRecord(credential, verified, now)] };
      await this.ctx.storage.put({ account, spent: sp.spent });
      return { ...ok({ account: accountView(account, null) }), issue: { a, g: account.gen } };
    });
  }

  signin({ a, challenge, exp, credential }) {
    return this.serial(async () => {
      const st = await this.load();
      // Nothing is written for an account that does not exist.
      if (!st.account || st.account.id !== a) return fail(404, 'no-account', 'no account has this passkey (it may have been deleted)');
      const cred = st.account.creds.find((c) => c.id === credential.id);
      if (!cred) return fail(401, 'unknown-credential', 'this passkey is not on the account (it may have been removed)');
      if (Object.hasOwn(liveSpent(st.spent, nowSeconds()), challenge)) return fail(401, 'challenge-used', 'this challenge was already used; ask for a new one');
      let res;
      try { res = await verifyAssertion(credential, cred, this.expect(challenge)); } catch (e) { return webauthnFailure(e); }
      if (!counterOk(cred.signCount, res.signCount)) return fail(401, 'webauthn', 'the passkey\'s signature counter did not grow (was the authenticator copied?)');
      const sp = this.spend(st, challenge, exp);
      if (sp.error) return sp.error;
      cred.signCount = Math.max(cred.signCount, res.signCount);
      cred.bs = res.bs;
      cred.lastUsed = iso();
      await this.ctx.storage.put({ account: st.account, spent: sp.spent });
      return { ...ok({ account: accountView(st.account, st.vault), vault: vaultView(st.vault) }), issue: { a, g: st.account.gen } };
    });
  }

  view(s) {
    return this.serial(async () => {
      const st = await this.load();
      return this.sessionFailure(st, s) || ok({ account: accountView(st.account, st.vault), vault: vaultView(st.vault) });
    });
  }

  /**
   * Compare-and-swap on the vault version: `ver` is the version the client
   * read (0 when there was no vault); the new vault gets ver + 1. Any other
   * version is 409 stale with the current vault, for the client to merge.
   */
  putVault({ a, g, ver, vault }) {
    return this.serial(async () => {
      const st = await this.load();
      const bad = this.sessionFailure(st, { a, g });
      if (bad) return bad;
      const current = st.vault ? st.vault.ver : 0;
      if (ver !== current) return fail(409, 'stale', 'the vault changed since you read it', { ver: current, vault: vaultView(st.vault) });
      const ids = new Set(st.account.creds.map((c) => c.id));
      if (!Object.keys(vault.wraps).every((id) => ids.has(id))) return fail(400, 'bad-vault', 'every wrap must belong to a passkey of this account');
      const next = { ver: current + 1, iv: vault.iv, ct: vault.ct, wraps: vault.wraps };
      await this.ctx.storage.put('vault', next);
      return ok({ ver: next.ver });
    });
  }

  addPasskey({ a, g, challenge, exp, credential }) {
    return this.serial(async () => {
      const st = await this.load();
      const bad = this.sessionFailure(st, { a, g });
      if (bad) return bad;
      if (st.account.creds.length >= LIMITS.MAX_PASSKEYS) return fail(409, 'too-many', `an account has at most ${LIMITS.MAX_PASSKEYS} passkeys`);
      if (st.account.creds.some((c) => c.id === credential.id)) return fail(409, 'exists', 'this passkey is already on the account');
      if (Object.hasOwn(liveSpent(st.spent, nowSeconds()), challenge)) return fail(401, 'challenge-used', 'this challenge was already used; ask for a new one');
      let verified;
      try { verified = await verifyRegistration(credential, this.expect(challenge)); } catch (e) { return webauthnFailure(e); }
      const sp = this.spend(st, challenge, exp);
      if (sp.error) return sp.error;
      st.account.creds.push(credRecord(credential, verified, Date.now()));
      await this.ctx.storage.put({ account: st.account, spent: sp.spent });
      return ok({ account: accountView(st.account, st.vault) });
    });
  }

  /** Removes a passkey (never the last one) and its wrap; a changed vault gets a new version so other phones re-read it. */
  removePasskey({ a, g, credId }) {
    return this.serial(async () => {
      const st = await this.load();
      const bad = this.sessionFailure(st, { a, g });
      if (bad) return bad;
      const i = st.account.creds.findIndex((c) => c.id === credId);
      if (i < 0) return fail(404, 'unknown-credential', 'this passkey is not on the account');
      if (st.account.creds.length === 1) return fail(409, 'last-passkey', 'the last passkey cannot be removed; delete the account instead');
      st.account.creds.splice(i, 1);
      const writes = { account: st.account };
      let vault = st.vault;
      if (vault && Object.hasOwn(vault.wraps, credId)) {
        const wraps = { ...vault.wraps };
        delete wraps[credId];
        vault = { ...vault, ver: vault.ver + 1, wraps };
        writes.vault = vault;
      }
      await this.ctx.storage.put(writes);
      return ok({ account: accountView(st.account, vault) });
    });
  }

  rename({ a, g, name }) {
    return this.serial(async () => {
      const st = await this.load();
      const bad = this.sessionFailure(st, { a, g });
      if (bad) return bad;
      st.account.name = name;
      await this.ctx.storage.put('account', st.account);
      return ok({ account: accountView(st.account, st.vault) });
    });
  }

  /** Every session carries the generation it was issued under; a new generation ends them all. */
  signoutAll(s) {
    return this.serial(async () => {
      const st = await this.load();
      const bad = this.sessionFailure(st, s);
      if (bad) return bad;
      st.account.gen += 1;
      await this.ctx.storage.put('account', st.account);
      return ok({ ok: true });
    });
  }

  /**
   * Deletes the account: name, passkeys, vault, everything. Only the spent
   * challenges that have not expired yet (random nonces, at most 5 minutes)
   * stay, so a recorded registration cannot bring the account back; an alarm
   * then deletes the object's storage entirely.
   */
  remove(s) {
    return this.serial(async () => {
      const st = await this.load();
      const bad = this.sessionFailure(st, s);
      if (bad) return bad;
      await this.cleanup(liveSpent(st.spent, nowSeconds()));
      return ok({ ok: true });
    });
  }

  /** Leaves only `spent` in storage (or nothing at all), with an alarm at its last expiry. */
  async cleanup(spent) {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    const exps = Object.values(spent);
    if (!exps.length) return;
    await this.ctx.storage.put('spent', spent);
    await this.ctx.storage.setAlarm(Math.max(...exps) * 1000 + 1000);
  }

  /** After a delete: drops the remembered challenges once they have expired. */
  async alarm() {
    await this.serial(async () => {
      const st = await this.load();
      const spent = liveSpent(st.spent, nowSeconds());
      if (st.account) {
        await this.ctx.storage.put('spent', spent);
        return ok({});
      }
      await this.cleanup(spent);
      return ok({});
    });
  }
}
