/**
 * passkeys.js: Apaki account passkeys inside the app (apaki/mobile, 2026-10-10).
 *
 * account.js (apaki/web/src, contract apaki/remote/ACCOUNTS.md) uses the
 * browser's WebAuthn: navigator.credentials.create/get with the PRF
 * extension, whose output unlocks the account's vault. A WebView inside an
 * app cannot do WebAuthn for apaki.myrlin.io (its page is
 * capacitor://localhost). The app answers the same calls natively instead
 * (ApakiPasskeys: ASAuthorizationPlatformPublicKeyCredentialProvider with
 * PRF, iOS 18+), which works because the app is associated with the domain
 * (Associated Domains webcredentials:apaki.myrlin.io and the
 * apple-app-site-association file the site serves). The system builds the
 * client data with origin https://apaki.myrlin.io, so the server checks pass
 * unchanged, and a passkey made in Safari works in the app and back.
 *
 * makeCredentials(Passkeys) returns { create, get } shaped like
 * navigator.credentials for the options account.js passes, and
 * PublicKeyCredential-like results (ArrayBuffers, getClientExtensionResults
 * with prf.results.first). Errors come back as DOMExceptions with the names
 * a browser uses (NotAllowedError when cancelled, InvalidStateError for an
 * excluded passkey), which account.js already maps to its messages.
 */

import { b64d, b64e } from './codec.js';

const buf = (b64) => b64d(b64).slice().buffer;
const bytesOf = (v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : null);
const b64Of = (v) => { const b = bytesOf(v); return b ? b64e(b) : null; };

/** A native error as the DOMException a browser would raise. */
function domError(e) {
  const code = e?.code || '';
  const name = code === 'cancelled' ? 'NotAllowedError' : code === 'exists' ? 'InvalidStateError' : code === 'domain' ? 'SecurityError' : code === 'unsupported' ? 'NotSupportedError' : 'UnknownError';
  return new DOMException(e?.message || 'The passkey request did not work.', name);
}

/** The extension results a browser reports for PRF. */
function prfResults(r) {
  if (!r.prfSupported && !r.prf) return {};
  return { prf: { enabled: Boolean(r.prfSupported || r.prf), ...(r.prf ? { results: { first: buf(r.prf) } } : {}) } };
}

export function makeCredentials(Passkeys) {
  async function create(options = {}) {
    const pk = options.publicKey;
    if (!pk) throw new DOMException('Only passkeys are supported here.', 'NotSupportedError');
    const salt = pk.extensions?.prf?.eval?.first;
    let r;
    try {
      r = await Passkeys.create({
        rpId: pk.rp?.id,
        challenge: b64Of(pk.challenge),
        userId: b64Of(pk.user?.id),
        name: String(pk.user?.name || pk.user?.displayName || ''),
        prfSalt: salt ? b64Of(salt) : null,
        exclude: (pk.excludeCredentials || []).map((c) => b64Of(c.id)).filter(Boolean),
      });
    } catch (e) { throw domError(e); }
    return {
      id: r.id,
      rawId: buf(r.id),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: buf(r.clientDataJSON),
        attestationObject: buf(r.attestationObject),
        // iCloud Keychain passkeys work on this phone and, by QR, for other devices.
        getTransports: () => ['hybrid', 'internal'],
      },
      getClientExtensionResults: () => prfResults(r),
    };
  }

  async function get(options = {}) {
    const pk = options.publicKey;
    if (!pk) throw new DOMException('Only passkeys are supported here.', 'NotSupportedError');
    const salt = pk.extensions?.prf?.eval?.first;
    let r;
    try {
      r = await Passkeys.get({
        rpId: pk.rpId,
        challenge: b64Of(pk.challenge),
        allow: (pk.allowCredentials || []).map((c) => b64Of(c.id)).filter(Boolean),
        prfSalt: salt ? b64Of(salt) : null,
      });
    } catch (e) { throw domError(e); }
    return {
      id: r.id,
      rawId: buf(r.id),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: buf(r.clientDataJSON),
        authenticatorData: buf(r.authenticatorData),
        signature: buf(r.signature),
        userHandle: r.userHandle ? buf(r.userHandle) : null,
      },
      getClientExtensionResults: () => prfResults(r),
    };
  }

  return { create, get };
}

/**
 * Puts the native passkeys where account.js looks: navigator.credentials
 * and window.PublicKeyCredential (getClientCapabilities says whether PRF
 * works on this iOS).
 */
export async function installPasskeys(Passkeys) {
  const creds = makeCredentials(Passkeys);
  let caps = { available: false, prf: false };
  try { caps = await Passkeys.support(); } catch { /* an older app build: no passkeys */ }
  const container = {
    create: (o) => creds.create(o),
    get: (o) => creds.get(o),
    store: async () => { throw new DOMException('Not supported in the app.', 'NotSupportedError'); },
    preventSilentAccess: async () => {},
  };
  Object.defineProperty(navigator, 'credentials', { value: container, configurable: true });
  const PKC = function PublicKeyCredential() { throw new TypeError('Illegal constructor'); };
  PKC.getClientCapabilities = async () => ({ passkeyPlatformAuthenticator: caps.available, userVerifyingPlatformAuthenticator: caps.available, 'extension:prf': Boolean(caps.prf) });
  PKC.isUserVerifyingPlatformAuthenticatorAvailable = async () => Boolean(caps.available);
  PKC.isConditionalMediationAvailable = async () => false;
  Object.defineProperty(window, 'PublicKeyCredential', { value: PKC, configurable: true, writable: true });
  return caps;
}
