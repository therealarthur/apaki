/**
 * native-http.js: the account API from inside the Apaki app (apaki/mobile,
 * 2026-10-10).
 *
 * account.js calls fetch('/v1/account...') and fetch('/v1/rooms/<id>/presence')
 * on the page's own origin, which on the web is https://apaki.myrlin.io. In
 * the app the page's origin is capacitor://localhost, so those requests go
 * to the site through the native side instead (ApakiNet.http): it sends no
 * Origin header (the account routes accept a request without one, as from
 * any non-browser client), keeps no cookies and no cache, and refuses any
 * address but https://apaki.myrlin.io/v1/. Every other fetch (the page's own
 * files) is left alone.
 *
 * makeFetch(Net, base, site, page) returns the fetch to install.
 */

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

function plainHeaders(h) {
  const out = {};
  if (!h) return out;
  if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach((v, k) => { out[k.toLowerCase()] = String(v); });
  else for (const [k, v] of Array.isArray(h) ? h : Object.entries(h)) out[String(k).toLowerCase()] = String(v);
  return out;
}

/**
 * @param {object} Net  the ApakiNet plugin (http({ url, method, headers, body }) -> { status, headers, body })
 * @param {Function} base  the page's fetch
 * @param {string} site  https://apaki.myrlin.io
 * @param {string} [page]  the page's address (location.href): requests to its own scheme and host count as "same origin"
 */
export function makeFetch(Net, base, site, page = globalThis.location?.href) {
  // Compared by scheme and host, not URL.origin: a custom scheme such as capacitor:// has an opaque origin ("null").
  const home = new URL(page || `${site}/`);
  return async function appFetch(input, init = {}) {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    let url;
    try { url = new URL(raw, home); } catch { return base(input, init); }
    if (url.protocol !== home.protocol || url.host !== home.host || !url.pathname.startsWith('/v1/')) return base(input, init);
    const body = init.body == null ? undefined : typeof init.body === 'string' ? init.body : null;
    if (body === null) throw new TypeError('The app sends text bodies only to the Apaki site.');
    let r;
    try {
      r = await Net.http({ url: `${site}${url.pathname}${url.search}`, method: String(init.method || 'GET').toUpperCase(), headers: plainHeaders(init.headers), body });
    } catch (e) {
      // What a browser's fetch does when the network fails; account.js says "offline" for it.
      throw new TypeError(`Failed to fetch (${e?.message || 'network'})`);
    }
    const status = Number(r.status) || 0;
    return new Response(NULL_BODY.has(status) ? null : (r.body ?? ''), { status: status || 502, headers: r.headers || {} });
  };
}
