/**
 * media.js: the home page's recordings (site/assets/media/) with HTTP range requests.
 *
 * Why (2026-10-12, Claude Code, Opus 5.5, for Arthur): Workers static assets answer a request
 * that carries a Range header with the whole file and a 200 (checked live on apaki.myrlin.io).
 * Safari, on the iPhone and the Mac, plays an MP4 only from a server that answers ranges with
 * 206 Partial Content: it asks for bytes=0-1 first and gives up on a 200. So wrangler.jsonc runs
 * the Worker first for /assets/media/* (assets.run_worker_first) and this serves those files from
 * the ASSETS binding, cut to the asked range. Every other file on the site, the phone pages in
 * /v/<version>/ included, is still served by the platform without running the Worker.
 *
 * The files are small (under 2.1 MB each), so a ranged answer reads the file and slices it.
 */

/** A file directly under /assets/media/, with a plain name (no subfolders, no dot-dot). */
export const MEDIA_PATH = /^\/assets\/media\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

const CACHE = 'public, max-age=14400';

/**
 * One byte range from a Range header against a file of `size` bytes:
 * { start, end } (inclusive), null to send the whole file (no header, or one this does not
 * handle, such as several ranges), or 'unsatisfiable'.
 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'unsatisfiable';
  return { start, end };
}

/** Serves one recording from env.ASSETS, answering Range with 206 (or 416). */
export async function serveMedia(request, env) {
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('method not allowed\n', { status: 405, headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' } });
  }
  // Ask the asset store for the whole file, with none of the client's conditional or range headers.
  const asset = await env.ASSETS.fetch(new Request(new URL(request.url).toString(), { method: 'GET' }));
  if (!asset.ok) return asset;
  const headers = new Headers(asset.headers);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', CACHE);
  headers.set('x-content-type-options', 'nosniff');
  headers.delete('content-encoding');
  const body = await asset.arrayBuffer();
  const size = body.byteLength;
  const range = parseRange(request.headers.get('range'), size);
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' } });
  }
  if (!range) {
    headers.set('content-length', String(size));
    return new Response(method === 'HEAD' ? null : body, { status: 200, headers });
  }
  headers.set('content-range', `bytes ${range.start}-${range.end}/${size}`);
  headers.set('content-length', String(range.end - range.start + 1));
  return new Response(method === 'HEAD' ? null : body.slice(range.start, range.end + 1), { status: 206, headers });
}
