/*
 * sheetworker.js: reads a workbook (xlsx, xlsm, xlsb, xls) off the window's main thread (2026-10-13; sheets.js
 * starts it). A classic worker: it loads SheetJS from the app's own files (vendor/sheetjs, Apache-2.0) and answers
 * one message per workbook with every sheet's cells as text, as the sheet formats them (dates, currency, percent).
 * Bounded: at most maxSheets sheets, maxRows rows and maxCols columns each; a sheet past them says it was cut.
 * Nothing in the file is run: SheetJS reads formulas' cached values and never evaluates them.
 */
/* global importScripts, XLSX */
importScripts('vendor/sheetjs/xlsx.core.min.js');

self.onmessage = (e) => {
  const { id, bytes, maxRows = 200000, maxCols = 400, maxSheets = 60 } = e.data || {};
  try {
    const wb = XLSX.read(bytes, { type: 'array', dense: true, cellDates: true, cellHTML: false, cellFormula: false, sheetRows: maxRows + 1 });
    const meta = (wb.Workbook && wb.Workbook.Sheets) || [];
    const sheets = wb.SheetNames.slice(0, maxSheets).map((name, i) => {
      const ws = wb.Sheets[name];
      const ref = ws && ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
      const fullRows = ws && ws['!fullref'] ? XLSX.utils.decode_range(ws['!fullref']).e.r + 1 : ref ? ref.e.r + 1 : 0;
      const grid = ws ? XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false }) : [];
      const width = grid.reduce((n, r) => Math.max(n, r.length), 0);
      const rows = grid.slice(0, maxRows).map((r) => r.slice(0, maxCols).map((v) => (v === null || v === undefined ? '' : String(v))));
      return { name: String(name), hidden: Boolean(meta[i] && meta[i].Hidden), rows, truncated: fullRows > maxRows || width > maxCols };
    });
    self.postMessage({ id, ok: true, sheets, more: wb.SheetNames.length > maxSheets });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
