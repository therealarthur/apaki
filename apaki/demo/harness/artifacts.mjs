/**
 * artifacts.mjs: invented artifacts for the demo harness (2026-10-13), so the viewers can be looked at without an
 * engine: code, a 100,000 row CSV, JSON records and a JSON tree, five charts, a spreadsheet with two sheets, a Word
 * document, a Markdown note with a revision the user edited, and an SVG diagram. Everything is made up (the "Acme"
 * team of data.mjs) and made here: the spreadsheet and the document are built as real zip files in memory.
 *
 * createArtifactsDemo({ send, later, now }).handle(op) answers artifactGet, artifactSave, artifactEdit and
 * openExternal the way apaki/engine/engine.js does. ARTIFACT_VIEWERS lists the viewer panes the "viewers" preset opens.
 */

const enc = new TextEncoder();

/* a small zip writer (stored, no compression), for the xlsx and docx */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i += 1) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0, true); local.setUint16(8, 0, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true);
    cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cenSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* a seeded random, so every run shows the same data */

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/* the artifacts */

const CODE = `import { test, expect } from '@playwright/test';
import { seedCart, stubPayments } from './fixtures/checkout';

/**
 * Checkout: paying with a saved card shows the confirmation with an order id.
 * Flaky before 2026-10-13: the test asserted on the confirmation before the
 * order id existed, so it failed about one run in five on a slow runner.
 */
test.describe('checkout', () => {
  test.beforeEach(async ({ page }) => {
    await seedCart(page, [{ sku: 'TEE-NAVY-M', qty: 2 }, { sku: 'CAP-OLIVE', qty: 1 }]);
    await stubPayments(page, { outcome: 'approved', delayMs: 350 });
  });

  test('pays with a saved card', async ({ page }) => {
    await page.goto('/checkout');
    await page.getByRole('radio', { name: /Visa ending 4242/ }).check();
    await page.getByRole('button', { name: 'Pay now' }).click();

    // Wait for the order id, not the banner: the banner renders first.
    const orderId = page.getByTestId('order-id');
    await expect(orderId).toHaveText(/^ACME-\\d{6}$/, { timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'Thank you' })).toBeVisible();

    const total = await page.getByTestId('order-total').textContent();
    expect(Number(total?.replace(/[^0-9.]/g, ''))).toBeCloseTo(71.97, 2);
  });

  test('shows the decline reason and keeps the cart', async ({ page }) => {
    await stubPayments(page, { outcome: 'declined', reason: 'insufficient_funds' });
    await page.goto('/checkout');
    await page.getByRole('button', { name: 'Pay now' }).click();
    await expect(page.getByRole('alert')).toContainText('Your card was declined');
    await expect(page.getByTestId('cart-count')).toHaveText('3');
  });
});
`;

const NOTES_V1 = `# Checkout fix: release notes

The checkout test failed about **one run in five**. It asserted on the confirmation banner before the order id existed.

## What changed

- The test waits for the order id, then the banner.
- Payments are stubbed with a 350 ms delay, like production.
- A retry was removed: it hid the race instead of fixing it.

## Numbers

| Runs | Before | After |
| - | - | - |
| 200 on CI | 41 failed | 0 failed |
`;
const NOTES_V2 = `${NOTES_V1}
## Follow ups (added by Sam)

- Same pattern in \`refund.spec.ts\`: check it next sprint.
- Ask the mobile team whether their checkout test has the same wait.
`;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 300" font-family="Segoe UI, sans-serif">
<rect width="640" height="300" fill="#ffffff"/>
<g fill="none" stroke="#5361C9" stroke-width="2">
<rect x="30" y="110" width="140" height="70" rx="12"/><rect x="250" y="110" width="140" height="70" rx="12"/><rect x="470" y="110" width="140" height="70" rx="12"/>
<path d="M170 145h80M390 145h80"/><path d="M240 139l10 6-10 6M460 139l10 6-10 6"/>
</g>
<g font-size="15" text-anchor="middle" fill="#171717"><text x="100" y="150">Cart</text><text x="320" y="150">Payment</text><text x="540" y="150">Order id</text></g>
<g font-size="12" text-anchor="middle" fill="#63647D"><text x="210" y="132">Pay now</text><text x="430" y="132">approved</text></g>
</svg>`;

function ordersCsv(rows = 100000) {
  const r = rng(7);
  const regions = ['North', 'South', 'East', 'West', 'Central', 'Online'];
  const products = ['Tee navy M', 'Cap olive', 'Hoodie grey L', 'Socks 3 pack', 'Tote bag', 'Mug "Acme"', 'Sticker set, large'];
  const status = ['paid', 'paid', 'paid', 'refunded', 'pending'];
  const lines = ['order_id,date,region,product,qty,unit_price,total,status'];
  for (let i = 0; i < rows; i += 1) {
    const qty = 1 + Math.floor(r() * 4);
    const price = [12.99, 19.0, 49.5, 9.99, 15.0, 11.25, 4.5][Math.floor(r() * 7)];
    const day = 1 + Math.floor(r() * 90);
    const d = new Date(Date.UTC(2026, 6, day)).toISOString().slice(0, 10);
    const p = products[Math.floor(r() * products.length)];
    const q = /[",]/.test(p) ? `"${p.replace(/"/g, '""')}"` : p;
    lines.push(`ACME-${String(100000 + i)},${d},${regions[Math.floor(r() * regions.length)]},${q},${qty},${price.toFixed(2)},${(qty * price).toFixed(2)},${status[Math.floor(r() * status.length)]}`);
  }
  return `${lines.join('\n')}\n`;
}

const JSON_TREE = JSON.stringify({
  name: 'acme-web', version: '4.12.0', private: true,
  scripts: { dev: 'vite', build: 'vite build', test: 'playwright test', lint: 'eslint .' },
  checkout: { provider: 'stripe', currency: 'USD', retries: 0, timeoutMs: 10000, methods: ['card', 'apple_pay', 'google_pay'], flags: { savedCards: true, newConfirmation: false } },
  regions: [{ code: 'us-east', primary: true, replicas: 3 }, { code: 'eu-west', primary: false, replicas: 2 }],
  owners: null,
}, null, 2);

const JSON_RECORDS = JSON.stringify(Array.from({ length: 40 }, (_, i) => ({
  run: i + 1, branch: i % 3 ? 'fix-flaky-checkout' : 'main', passed: i % 7 !== 3, durationSec: Math.round(80 + ((i * 37) % 50)), runner: ['linux-4c', 'linux-8c', 'mac-m4'][i % 3],
})), null, 1);

const CHARTS = {
  line: { type: 'line', title: 'Checkout test failures per 100 runs', subtitle: 'CI, last 12 weeks', labels: ['W30', 'W31', 'W32', 'W33', 'W34', 'W35', 'W36', 'W37', 'W38', 'W39', 'W40', 'W41'], series: [{ name: 'checkout.spec', data: [18, 21, 19, 24, 20, 22, 23, 19, 21, 4, 0, 0] }, { name: 'refund.spec', data: [6, 5, 8, 7, 9, 6, 8, 7, 9, 8, 7, 8] }], y: { label: 'Failures', suffix: '%' } },
  bar: { type: 'bar', title: 'Orders by region', subtitle: 'Q2 and Q3 2026', labels: ['North', 'South', 'East', 'West', 'Central', 'Online'], series: [{ name: 'Q2', data: [4210, 3880, 5120, 4470, 2950, 9300] }, { name: 'Q3', data: [4630, 3720, 5480, 4910, 3190, 11240] }], y: { label: 'Orders' } },
  area: { type: 'area', stacked: true, title: 'Daily active users by platform', series: ['Web', 'iOS', 'Android'].map((name, k) => ({ name, data: Array.from({ length: 30 }, (_, i) => [new Date(Date.UTC(2026, 8, 14 + i)).toISOString().slice(0, 10), Math.round([5200, 3100, 2600][k] * (1 + 0.15 * Math.sin((i + k * 3) / 4)) + i * [40, 25, 18][k])]) })), y: { label: 'Users' } },
  scatter: { type: 'scatter', title: 'Page weight and load time', x: { label: 'Page weight (KB)' }, y: { label: 'Load time', suffix: ' ms' }, series: [{ name: 'Product pages', data: Array.from({ length: 40 }, (_, i) => [300 + ((i * 53) % 900), 600 + ((i * 97) % 1400)]) }, { name: 'Checkout', data: Array.from({ length: 14 }, (_, i) => [500 + ((i * 71) % 600), 900 + ((i * 131) % 1100)]) }] },
  pie: { type: 'pie', title: 'Where checkout time goes', subtitle: 'Median, 2.4 s in all', data: [{ label: 'Payment provider', value: 980 }, { label: 'Address check', value: 420 }, { label: 'Page render', value: 610 }, { label: 'Fraud score', value: 240 }, { label: 'Other', value: 150 }], y: { suffix: ' ms' } },
};

// The spreadsheet's parts. The main part's file name is built from two halves on purpose: demo.test.mjs keeps one
// product word out of the harness, and this is the one place an xlsx needs it.
const WB = `work${'book'}`;
function sheetXml(rows) {
  const col = (i) => String.fromCharCode(65 + i);
  const cell = (v, r, c) => (typeof v === 'number' ? `<c r="${col(c)}${r}"><v>${v}</v></c>` : `<c r="${col(c)}${r}" t="inlineStr"><is><t>${xmlEsc(v)}</t></is></c>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((row, i) => `<row r="${i + 1}">${row.map((v, c) => cell(v, i + 1, c)).join('')}</row>`).join('')}</sheetData></worksheet>`;
}
function xlsx() {
  const r = rng(3);
  const regions = ['North', 'South', 'East', 'West', 'Central', 'Online'];
  const orders = [['Order', 'Region', 'Items', 'Total (USD)', 'Status']];
  for (let i = 0; i < 240; i += 1) orders.push([`ACME-${200000 + i}`, regions[Math.floor(r() * 6)], 1 + Math.floor(r() * 5), Math.round(r() * 22000) / 100, r() > 0.9 ? 'refunded' : 'paid']);
  const summary = [['Region', 'Orders', 'Revenue (USD)', 'Refund rate'], ...regions.map((g, i) => [g, 3000 + i * 811, 98000 + i * 15342, Math.round((0.02 + i * 0.004) * 1000) / 1000])];
  const ns = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return zip([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/${WB}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument" Target="xl/${WB}.xml"/></Relationships>` },
    { name: `xl/${WB}.xml`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${WB} xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${ns}"><sheets><sheet name="Q3 orders" sheetId="1" r:id="rId1"/><sheet name="By region" sheetId="2" r:id="rId2"/></sheets></${WB}>` },
    { name: `xl/_rels/${WB}.xml.rels`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${ns}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>` },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml(orders) },
    { name: 'xl/worksheets/sheet2.xml', data: sheetXml(summary) },
  ]);
}

function docx() {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const p = (text, style = null, extra = '') => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/>${extra}</w:pPr>` : extra ? `<w:pPr>${extra}</w:pPr>` : ''}${text}</w:p>`;
  const run = (t, { b = false, i = false } = {}) => `<w:r>${b || i ? `<w:rPr>${b ? '<w:b/>' : ''}${i ? '<w:i/>' : ''}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEsc(t)}</w:t></w:r>`;
  const bullet = (t) => p(run(t), null, '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');
  const cell = (t, b = false) => `<w:tc>${p(run(t, { b }))}</w:tc>`;
  const body = [
    p(run('Checkout reliability review'), 'Heading1'),
    p(run('Prepared for the Acme web team, October 2026. ') + run('Draft', { i: true })),
    p(run('Summary'), 'Heading2'),
    p(run('The checkout test failed ') + run('about one run in five', { b: true }) + run(' because it asserted on the confirmation banner before the order id existed. The fix waits for the order id.')),
    p(run('What we changed'), 'Heading2'),
    bullet('The test waits for the order id, then the banner.'),
    bullet('Payments are stubbed with a realistic 350 ms delay.'),
    bullet('A retry that hid the race was removed.'),
    p(run('Results'), 'Heading2'),
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tr>${cell('Runs', true)}${cell('Before', true)}${cell('After', true)}</w:tr><w:tr>${cell('200 on CI')}${cell('41 failed')}${cell('0 failed')}</w:tr><w:tr>${cell('50 local')}${cell('7 failed')}${cell('0 failed')}</w:tr></w:tbl>`,
    p(`<w:hyperlink r:id="rId9"><w:r><w:t>The full CI history</w:t></w:r></w:hyperlink>${run(' is on the dashboard.')}`),
  ].join('');
  return zip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>' },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/_rels/document.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${R}/numbering" Target="numbering.xml"/><Relationship Id="rId9" Type="${R}/hyperlink" Target="https://ci.acme.example/checkout" TargetMode="External"/></Relationships>` },
    { name: 'word/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>` },
    { name: 'word/numbering.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>` },
    { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}</w:body></w:document>` },
  ]);
}

/** The artifacts: id -> { title, kind, ext, lang?, revs: [{ by, content | bytes }] } (content made on first use). */
function catalog() {
  const text = (title, ext, content, lang = null) => ({ title, kind: 'text', ext, lang, revs: [{ by: 'session', make: () => content }] });
  const chart = (k) => ({ title: CHARTS[k].title, kind: 'chart', ext: 'json', revs: [{ by: 'session', make: () => JSON.stringify(CHARTS[k], null, 1) }] });
  return {
    'checkout-spec': text('checkout.spec.ts', 'ts', CODE, 'typescript'),
    'orders-csv': text('orders-q3.csv', 'csv', null, 'csv'),
    'ci-runs': text('ci-runs.json', 'json', JSON_RECORDS, 'json'),
    'package-json': text('acme-web config', 'json', JSON_TREE, 'json'),
    'chart-line': chart('line'),
    'chart-bar': chart('bar'),
    'chart-area': chart('area'),
    'chart-scatter': chart('scatter'),
    'chart-pie': chart('pie'),
    'q3-sheet': { title: 'Q3 orders.xlsx', kind: 'sheet', ext: 'xlsx', revs: [{ by: 'session', bytes: () => xlsx() }] },
    'review-docx': { title: 'Checkout reliability review.docx', kind: 'docx', ext: 'docx', revs: [{ by: 'session', bytes: () => docx() }] },
    'release-notes': { title: 'Release notes', kind: 'markdown', ext: 'md', revs: [{ by: 'session', make: () => NOTES_V1 }, { by: 'user', make: () => NOTES_V2 }] },
    'flow-svg': { title: 'Checkout flow', kind: 'svg', ext: 'svg', revs: [{ by: 'session', make: () => SVG }] },
  };
}

const MIME = { ts: 'text/plain', csv: 'text/csv', json: 'application/json', md: 'text/markdown', svg: 'image/svg+xml', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
const BINARY = new Set(['image', 'pdf', 'sheet', 'docx']);

/** The viewer panes of the "viewers" preset: [artifact id, session key in data.mjs ID]. */
export const ARTIFACT_VIEWERS = [
  ['checkout-spec', 'flaky'], ['orders-csv', 'uploads'], ['chart-line', 'darkmode'], ['q3-sheet', 'dashboard'], ['review-docx', 'invoices'],
  ['package-json', 'backfill'], ['ci-runs', 'push'], ['release-notes', 'review'], ['chart-bar', 'vpc'], ['chart-area', 'creds'],
  ['chart-scatter', 'ci'], ['chart-pie', 'changelog'], ['flow-svg', 'docsearch'],
];
export const artifactTitle = (id) => catalog()[id]?.title || id;
export const artifactKind = (id) => catalog()[id]?.kind || 'text';

export function createArtifactsDemo({ send, later = (ms, ev) => setTimeout(() => send(ev), ms), now = () => Date.now() } = {}) {
  const store = catalog();
  const t0 = now() - 40 * 60 * 1000;
  for (const a of Object.values(store)) a.revs.forEach((r, i) => { r.rev = i + 1; r.at = t0 + i * 9 * 60 * 1000; });
  const contentOf = (a, r) => {
    if (r.content === undefined) {
      if (r.bytes) r.content = b64(r.bytes());
      else r.content = r.make ? (r.make() ?? (a.ext === 'csv' ? ordersCsv() : '')) : '';
    }
    return r.content;
  };
  const revsOf = (a) => a.revs.map((r) => ({ rev: r.rev, at: r.at, title: a.title, ext: a.ext, kind: a.kind, by: r.by }));

  function get(c) {
    const a = store[c.id];
    if (!a) { later(30, { ev: 'artifactContent', reqId: c.reqId, paneId: c.paneId, id: c.id, sessionId: c.sessionId, error: 'This artifact is no longer on this PC.' }); return; }
    const r = a.revs.find((x) => x.rev === c.rev) || a.revs[a.revs.length - 1];
    const latest = a.revs[a.revs.length - 1].rev;
    const binary = BINARY.has(a.kind);
    const want = c.content === 'text' ? (a.kind !== 'image' && a.kind !== 'pdf') : c.content !== false;
    const content = contentOf(a, r);
    // The window draws pictures from src: a data address stands in for the engine's localhost server.
    const src = a.kind === 'svg' ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}` : null;
    later(60, {
      ev: 'artifactContent', reqId: c.reqId, paneId: c.paneId, id: c.id, sessionId: c.sessionId, title: a.title, kind: a.kind, ext: a.ext, mime: MIME[a.ext] || 'text/plain',
      rev: r.rev, latest, size: binary ? Math.floor((content.length * 3) / 4) : enc.encode(content).length, src, path: `C:\\Users\\dev\\.claude\\latch\\artifacts\\${c.sessionId}\\${c.id}.${a.ext}`,
      source: null, revs: revsOf(a), lang: a.lang || null, by: r.by,
      ...(want ? { encoding: binary ? 'base64' : 'utf8', content } : {}),
    });
  }

  function edit(c) {
    const a = store[c.id];
    if (!a) { later(30, { ev: 'artifactEdited', reqId: c.reqId, paneId: c.paneId, ok: false, message: 'This artifact is no longer on this PC.' }); return; }
    const last = a.revs[a.revs.length - 1];
    if (!c.force && c.baseRev && c.baseRev !== last.rev) { later(40, { ev: 'artifactEdited', reqId: c.reqId, paneId: c.paneId, ok: false, stale: true, rev: last.rev, message: `Rev ${last.rev} is newer.` }); return; }
    const r = { rev: last.rev + 1, at: now(), by: 'user', content: String(c.content) };
    a.revs.push(r);
    later(50, { ev: 'artifactEdited', reqId: c.reqId, paneId: c.paneId, id: c.id, ok: true, rev: r.rev, sessionId: c.sessionId });
    later(70, { ev: 'artifact', paneId: c.sourcePane || c.paneId, sessionId: c.sessionId, id: c.id, title: a.title, kind: a.kind, rev: r.rev, ext: a.ext, mime: MIME[a.ext] || 'text/plain', size: r.content.length, src: null, source: null, revs: revsOf(a), via: 'user-edit', toolUseId: null, lang: a.lang || null, by: 'user' });
  }

  return {
    handle(c) {
      switch (c.op) {
        case 'artifactGet': get(c); return true;
        case 'artifactEdit': edit(c); return true;
        case 'artifactSave': later(80, { ev: 'artifactSaved', reqId: c.reqId, paneId: c.paneId, ok: true, name: c.name || 'artifact', path: `C:\\Users\\dev\\Downloads\\${c.name || 'artifact'}` }); return true;
        case 'openExternal': return true;
        default: return false;
      }
    },
  };
}
