/**
 * sheets.js: workbooks (xlsx, xlsm, xlsb, xls) for the viewer, one table per sheet (2026-10-13).
 *
 * WHY (Arthur, 2026-10-13: spreadsheets in the viewer, like ChatGPT's side window): SheetJS reads the workbook in a
 * worker (sheetworker.js), so a big file never freezes the window (a stall over a second is logged as a freeze, see
 * app.js). Where a worker cannot start, the same reading runs here, after loading SheetJS the same lazy way.
 * readWorkbook resolves to { sheets: [{ name, hidden, rows, truncated }], more }.
 */

import { loadScript } from './lazy.js';
import { MAX_COLS, MAX_ROWS } from './tabular.js';

let worker = null;
let seq = 0;
const waiting = new Map();

function startWorker() {
  if (worker !== null) return worker;
  try {
    worker = new Worker(new URL('./sheetworker.js', import.meta.url));
    worker.onmessage = (e) => { const w = waiting.get(e.data?.id); if (w) { waiting.delete(e.data.id); w(e.data); } };
    worker.onerror = () => { for (const w of waiting.values()) w({ ok: false, error: 'The workbook reader stopped.' }); waiting.clear(); worker.terminate(); worker = false; };
  } catch { worker = false; }
  return worker;
}

/** Reads a workbook's bytes (Uint8Array or ArrayBuffer). */
export async function readWorkbook(bytes, { maxRows = MAX_ROWS, maxCols = MAX_COLS } = {}) {
  const w = startWorker();
  if (w) {
    const id = ++seq;
    const r = await new Promise((resolve) => {
      waiting.set(id, resolve);
      // A copy goes to the worker; the viewer keeps its own bytes for Download.
      w.postMessage({ id, bytes: bytes instanceof ArrayBuffer ? bytes.slice(0) : bytes.slice(), maxRows, maxCols });
    });
    if (r.ok) return { sheets: r.sheets, more: r.more };
    if (!/stopped/.test(r.error || '')) throw new Error(r.error || 'The workbook could not be read.');
  }
  // No worker here: the same reading on this thread.
  await loadScript('sheetjs/xlsx.core.min.js');
  const X = window.XLSX;
  const wb = X.read(bytes, { type: 'array', dense: true, cellDates: true, cellHTML: false, cellFormula: false, sheetRows: maxRows + 1 });
  const meta = wb.Workbook?.Sheets || [];
  return {
    sheets: wb.SheetNames.slice(0, 60).map((name, i) => {
      const ws = wb.Sheets[name];
      const grid = ws ? X.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false }) : [];
      const width = grid.reduce((n, r) => Math.max(n, r.length), 0);
      return { name: String(name), hidden: Boolean(meta[i]?.Hidden), rows: grid.slice(0, maxRows).map((r) => r.slice(0, maxCols).map((v) => (v == null ? '' : String(v)))), truncated: grid.length > maxRows || width > maxCols };
    }),
    more: wb.SheetNames.length > 60,
  };
}

/** Base64 (as the engine sends binary artifacts) to bytes. */
export function b64Bytes(b64) {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
