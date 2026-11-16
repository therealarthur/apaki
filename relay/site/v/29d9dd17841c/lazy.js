/**
 * lazy.js: the viewer's heavy libraries, loaded only when a viewer of their kind opens (2026-10-13).
 *
 * WHY (Arthur, 2026-10-13: viewers that show code, spreadsheets and documents like ChatGPT's side window): the code
 * viewer's syntax colours, the workbook reader and the Word reader are libraries of 20 KB to 500 KB. The window must
 * not pay for them at start, so each is fetched the first time a viewer needs it, from this app's own files (never a
 * CDN: the window's CSP allows only 'self' scripts, and the phone page's the same), and kept for the session.
 *
 * Vendored in apaki/ui/vendor/<name>/ with their licenses, nothing fetched at run time from anywhere else:
 *   highlight  highlight.js 11.12.0 (BSD-3-Clause), the ES module core and 28 grammars (vendor/highlight/languages),
 *              from the npm package @highlightjs/cdn-assets. About 200 KB in all; a viewer loads the core and one grammar.
 *   sheetjs    SheetJS Community Edition 0.20.3 (Apache-2.0), dist/xlsx.core.min.js from cdn.sheetjs.com
 *              (xlsx-0.20.3.tgz): reads xlsx, xlsm, xlsb and xls. 507 KB, run in a worker (sheetworker.js).
 *   mammoth    mammoth 1.13.0 (BSD-2-Clause), mammoth.browser.min.js from npm: Word (.docx) to HTML. 405 KB. It bundles
 *              JSZip, pako, underscore, bluebird, @xmldom/xmldom, lop, dingbat-to-unicode and base64-js, all permissive
 *              (vendor/mammoth/NOTICE). None of the three evaluates code from a string on the paths Apaki uses (checked
 *              under the window's CSP, which has no 'unsafe-eval').
 */

const scripts = new Map();
const modules = new Map();

/** The address of a vendored file, next to this module (the window's ui folder, or the phone build's root). */
export const vendorUrl = (rel) => new URL(`./vendor/${rel}`, import.meta.url).href;

/** Loads a classic script once (a UMD library that sets a global); resolves when it ran. */
export function loadScript(rel) {
  if (!scripts.has(rel)) {
    scripts.set(rel, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = vendorUrl(rel);
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { scripts.delete(rel); reject(new Error(`Could not load ${rel}.`)); };
      document.head.append(s);
    }));
  }
  return scripts.get(rel);
}

/** Imports a vendored ES module once. */
export function loadModule(rel) {
  if (!modules.has(rel)) {
    const p = import(vendorUrl(rel)).catch((e) => { modules.delete(rel); throw e; });
    modules.set(rel, p);
  }
  return modules.get(rel);
}

let hljsReady = null;
const grammars = new Map();

/**
 * highlight.js with `grammar` registered (one of viewkind.js GRAMMARS), or null when it cannot load. Grammars load one
 * by one as code of that language is opened.
 */
export async function highlighter(grammar) {
  try {
    hljsReady ||= loadModule('highlight/core.min.js').then((m) => m.default);
    const hljs = await hljsReady;
    if (grammar && !hljs.getLanguage(grammar)) {
      if (!grammars.has(grammar)) {
        grammars.set(grammar, loadModule(`highlight/languages/${grammar}.min.js`).then((m) => { hljs.registerLanguage(grammar, m.default); }).catch(() => {}));
      }
      await grammars.get(grammar);
    }
    return hljs;
  } catch {
    hljsReady = null;
    return null;
  }
}
