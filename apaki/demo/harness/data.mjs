/**
 * data.mjs: the invented dataset behind Apaki's demo harness.
 *
 * Everything here is made up for marketing screenshots and recordings: a team
 * at a fictional company ("Acme") working in five folders, with plausible
 * session titles, conversations, Glass accounts and paired phones. Nothing is
 * read from the machine the harness runs on, and nothing here may ever be
 * replaced with a real title, path, name, email or account.
 *
 * Browser side (runs inside the harness page) and Node safe: no DOM use.
 *
 * Exports:
 *   MIN, HOUR, DAY      time units in ms
 *   ID                  stable session ids by short name
 *   buildSessions(now)  the rail's session items (engine compact() shape)
 *   buildFolders()      Apaki folders (the rail's Folders list)
 *   buildHistory(id, now) { messages, earlier } for a session's transcript
 *   buildGlass(now)     the Glass accounts and live selection
 *   buildSubagents(id, now) the rail's subagent rows for a session
 *   PRESETS             named starting workspaces (tabs and layouts) per scene
 */

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const CWD = {
  web: 'C:\\Users\\dev\\code\\acme-web',
  billing: 'C:\\Users\\dev\\code\\billing-service',
  mobile: 'C:\\Users\\dev\\code\\mobile-app',
  infra: 'C:\\Users\\dev\\code\\infra',
  docs: 'C:\\Users\\dev\\code\\docs-site',
};

const sid = (n) => `a1c4e7b2-${String(n).padStart(4, '0')}-4f3a-9c6d-2b8e5f0d71${String(n).padStart(2, '0')}`;

/** Stable ids by short name, so scenes and presets can refer to a session without its title. */
export const ID = {
  flaky: sid(1),
  invoices: sid(2),
  push: sid(3),
  review: sid(4),
  dashboard: sid(5),
  uploads: sid(6),
  backfill: sid(7),
  vpc: sid(8),
  creds: sid(9),
  changelog: sid(10),
  docsearch: sid(11),
  ci: sid(12),
  darkmode: sid(13),
  onboarding: sid(14),
  codexPricing: sid(21),
  codexWebhook: sid(22),
  codexDates: sid(23),
};

/** The rail's session list, newest work first; the engine sorts terminals to the top, as the real one does. */
export function buildSessions(now) {
  const s = (key, title, ago, cwd, extra = {}) => ({
    id: ID[key], title, firstPrompt: title, cwd, branch: 'main', lastModified: now - ago, size: 52_000, codex: false,
    terminal: null, folder: null, headless: false, bare: false, warm: false, subagents: 0, archived: false, running: false, ...extra,
  });
  return [
    s('invoices', 'Migrate invoices to the new tax API', 3 * MIN, CWD.billing, { terminal: { name: 'Windows Terminal', status: 'working', pid: 4120 }, folder: 'f-checkout', running: true }),
    s('push', 'Add retries to the push notification worker', 9 * MIN, CWD.mobile, { terminal: { name: 'Windows Terminal', status: 'working', pid: 5288 }, running: true }),
    s('review', 'Review PR 482: rate limiter for the public API', 21 * MIN, CWD.billing, { terminal: { name: 'Windows Terminal', status: 'waiting', pid: 6032 } }),
    s('flaky', 'Fix flaky checkout test', 6 * MIN, CWD.web, { warm: true, folder: 'f-checkout', subagents: 2 }),
    s('codexPricing', 'Refactor the pricing table component', 18 * MIN, CWD.web, { codex: true }),
    s('dashboard', 'Why the dashboard flashes on first load', 38 * MIN, CWD.web),
    s('uploads', 'Move image uploads to signed URLs', 2 * HOUR + 10 * MIN, CWD.web, { warm: true, subagents: 3 }),
    s('backfill', 'Backfill missing invoice PDFs', 3 * HOUR, CWD.billing, { folder: 'f-checkout' }),
    s('codexWebhook', 'Explain the webhook retry schedule', 4 * HOUR, CWD.billing, { codex: true }),
    s('darkmode', 'Dark mode for the settings screen', 5 * HOUR, CWD.mobile),
    s('vpc', 'Terraform plan for the staging VPC', 1 * DAY + 2 * HOUR, CWD.infra, { folder: 'f-infra' }),
    s('creds', 'Rotate the staging database credentials', 1 * DAY + 5 * HOUR, CWD.infra, { folder: 'f-infra' }),
    s('changelog', 'Write the changelog for 4.2', 1 * DAY + 7 * HOUR, CWD.docs, { folder: 'f-release' }),
    s('docsearch', 'Docs search: index the API reference', 2 * DAY + 1 * HOUR, CWD.docs, { folder: 'f-release' }),
    s('codexDates', 'Port the date helpers to Temporal', 2 * DAY + 4 * HOUR, CWD.web, { codex: true }),
    s('ci', 'Speed up the CI cache restore', 3 * DAY, CWD.infra),
    s('onboarding', 'Prototype the onboarding checklist', 6 * DAY, CWD.web, { archived: true }),
  ];
}

export function buildFolders(now) {
  const created = new Date(now - 20 * DAY).toISOString();
  return [
    { id: 'f-checkout', name: 'Checkout', sessions: [ID.flaky, ID.invoices, ID.backfill], createdAt: created },
    { id: 'f-release', name: 'Release 4.2', sessions: [ID.changelog, ID.docsearch], createdAt: created },
    { id: 'f-infra', name: 'Infra', sessions: [ID.vpc, ID.creds], createdAt: created },
  ];
}

/* transcripts */

/** The markdown table rule (three hyphens), built here so the source holds no double hyphen. */
const DASH = '-'.repeat(3);

/** Small constructors so the conversations below read like conversations. */
function kit(now) {
  const iso = (ago) => new Date(now - ago).toISOString();
  const u = (ago, content, extra = {}) => ({ type: 'user', at: iso(ago), message: { content }, ...extra });
  const a = (ago, blocks) => ({ type: 'assistant', at: iso(ago), message: { content: typeof blocks === 'string' ? [{ type: 'text', text: blocks }] : blocks } });
  const result = (ago, id, content, isError = false) => u(ago, [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }]);
  const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const text = (t) => ({ type: 'text', text: t });
  const think = (t) => ({ type: 'thinking', thinking: t });
  const notice = (t, tone, label, mono = false) => ({ type: 'notice', notice: { text: t, tone, label, ...(mono ? { mono: true } : {}) } });
  return { iso, u, a, result, use, text, think, notice };
}

const FLAKY_FIX_CODE = `export function useOrder(cart: Cart) {
  const [order, setOrder] = useState<Order | null>(null);
  const [status, setStatus] = useState<'idle' | 'paying' | 'confirmed'>('idle');

  async function pay() {
    setStatus('paying');
    const created = await api.pay(cart);
    setOrder(created);
    setStatus('confirmed'); // after the id exists, not before
  }
  return { order, status, pay };
}`;

/** The conversation behind "Fix flaky checkout test": ends where the live turn in the steer scene begins. */
function flakyHistory(now) {
  const { u, a, result, use, text } = kit(now);
  return [
    u(46 * MIN, 'The checkout e2e test fails about one run in five on CI and never locally. Can you find out why?'),
    a(45.6 * MIN, [text('I will start with the test and the page it drives.'), use('toolu_f1', 'Read', { file_path: 'tests/e2e/checkout.spec.ts' })]),
    result(45.4 * MIN, 'toolu_f1', "import { test, expect } from '@playwright/test';\n\ntest('pays for a cart', async ({ page }) => {\n  await page.goto('/checkout');\n  await page.getByRole('button', { name: 'Pay now' }).click();\n  await expect(page.getByTestId('confirmation')).toBeVisible();\n  await expect(page.getByTestId('order-id')).toHaveText(/#\\d+/);\n});"),
    a(45 * MIN, [use('toolu_f2', 'Grep', { pattern: 'confirmed', path: 'src' })]),
    result(44.8 * MIN, 'toolu_f2', "src/components/Checkout/Confirmation.tsx:14:  <section data-testid=\"confirmation\">\nsrc/components/Checkout/useOrder.ts:31:    setStatus('confirmed'); // runs before the order id is set\nsrc/pages/checkout.tsx:58:  {status === 'confirmed' && <Confirmation order={order} />}"),
    a(44 * MIN, `Found it. This is a race in the app, and the test only exposes it:

- \`useOrder\` sets the status to \`confirmed\` **before** the order id comes back from the API
- on a fast laptop the id lands first; on a busy CI runner the test checks \`order-id\` while the banner is still empty

\`\`\`ts
setStatus('confirmed');        // useOrder.ts:31
setOrder(await api.pay(cart)); // the id arrives later
\`\`\`

I would fix the hook so the banner only shows once the order exists, and leave the test as it is. The test is right; the page was lying.`),
  ];
}

/**
 * The handoff (2026-10-12, for the home page's hero): the turn a phone runs in "Fix flaky checkout test" after
 * taking it over from the desktop. The phone plays it live (turns.mjs, script "handoff"); the desktop pane that
 * lost the session reads the same turn from the transcript as Claude Code writes it (engine.mjs historyCheck,
 * handoffMessages below), the way the real pane follows a conversation that moved to a phone.
 */
export const HANDOFF = {
  prompt: 'Fix the hook, then run the test ten times',
  lead: 'Moving `confirmed` below `setOrder` in `useOrder`, so the banner waits for the order id.',
  edit: {
    file_path: 'src/components/Checkout/useOrder.ts',
    old_string: ["    setStatus('confirmed'); // runs before the order id is set", '    setOrder(await api.pay(cart));'].join('\n'),
    new_string: ['    const created = await api.pay(cart);', '    setOrder(created);', "    setStatus('confirmed'); // after the id exists"].join('\n'),
  },
  editResult: 'The file src/components/Checkout/useOrder.ts has been updated.',
  bash: { command: 'for i in 1 2 3 4 5 6 7 8 9 10; do npx playwright test checkout.spec.ts -x || break; done', description: 'Run the checkout test ten times' },
  bashResult: ['10 of 10 runs passed', ...Array.from({ length: 10 }, (_, i) => `run ${i + 1}: 1 passed (1.${i % 3 ? 3 : 4}s)`)].join('\n'),
  reply: 'Fixed. The banner now waits for the order id: ten runs in a row, ten passes, where it failed about one run in five before.',
};

/**
 * The handoff turn as transcript messages, the first `count` of them as Claude Code has written them so far:
 * 1 the prompt, 3 the edit and its result, 5 the test run and its result, 6 the reply.
 */
export function handoffMessages(now, count) {
  const { u, a, result, use, text } = kit(now);
  const all = [
    u(14_000, HANDOFF.prompt),
    a(12_000, [text(HANDOFF.lead), use('toolu_h1', 'Edit', HANDOFF.edit)]),
    result(11_000, 'toolu_h1', HANDOFF.editResult),
    a(9_000, [use('toolu_h2', 'Bash', HANDOFF.bash)]),
    result(5_000, 'toolu_h2', HANDOFF.bashResult),
    a(2_000, HANDOFF.reply),
  ];
  return all.slice(0, Math.max(0, Math.min(all.length, count)));
}

/** The long conversation for the history scene: tool calls, a diff, a subagent, and what Claude Code says itself. */
function uploadsHistory(now) {
  const { u, a, result, use, text, think, notice } = kit(now);
  const earlier = [
    u(4 * HOUR, 'Image uploads go through our API today and time out on big files. Move them to signed URLs straight to the bucket, and keep the old endpoint working for the mobile app until 4.2 ships.'),
    a(4 * HOUR - 40_000, [
      think('The request is to move uploads off the API process. Before changing anything I need to know who calls POST /api/uploads, how large the files get, and whether the mobile client can switch to a signed URL without a store release.'),
      text('Let me look at how uploads work today, and who calls the old endpoint.'),
      use('toolu_u1', 'Grep', { pattern: '/api/uploads', path: '.' }),
    ]),
    result(4 * HOUR - 36_000, 'toolu_u1', 'server/routes.ts:41:  router.post(\'/api/uploads\', requireAuth, uploads.handle);\nweb/src/lib/upload.ts:12:  const res = await fetch(\'/api/uploads\', { method: \'POST\', body: form });\nmobile/src/api/uploads.ts:27:  return client.post(\'/api/uploads\', body);\ntests/uploads.test.ts:9:  const res = await request(app).post(\'/api/uploads\');'),
    a(4 * HOUR - 30_000, [use('toolu_u2', 'Read', { file_path: 'server/uploads.ts' })]),
    result(4 * HOUR - 27_000, 'toolu_u2', "import { pipeline } from 'node:stream/promises';\nimport { bucket } from './storage';\n\nexport async function handle(req, res) {\n  const key = `uploads/${req.user.id}/${Date.now()}`;\n  await pipeline(req, bucket.createWriteStream(key));\n  res.json({ key });\n}"),
    a(4 * HOUR - 20_000, `The whole file streams through the API process, which is why a slow phone on a 12 MB photo ties up a worker for a minute. Here is the plan:

1. Add \`POST /api/uploads/sign\`, which returns a short-lived signed URL and the final key
2. Switch the web client to upload straight to that URL
3. Leave \`POST /api/uploads\` in place, unchanged, for the mobile app
4. Add a test for each path, then remove the old endpoint after 4.2`),
    { type: 'compact', trigger: 'auto', preTokens: 181_000, postTokens: 22_000, at: new Date(now - 3 * HOUR).toISOString(), summary: { text: '## Summary\n\nMoving image uploads from the API process to direct-to-bucket uploads with signed URLs.\n\n**Decided**\n- New endpoint `POST /api/uploads/sign` returns a signed URL and the final key\n- The web client switches first; the mobile app keeps `POST /api/uploads` until 4.2 ships\n\n**Done so far**\n- Read `server/uploads.ts` and every caller of the old endpoint\n\n**Next**\n- Write the signing endpoint, wire the route, add tests' } },
  ];
  const page = [
    u(2 * HOUR + 12 * MIN, 'Good plan. Start with the signing endpoint, and keep POST /api/uploads working for the mobile app.'),
    notice('UserPromptSubmit operation blocked by hook:\n.claude/hooks/no-secrets.sh: this prompt looks like it contains a credential. Remove it and send it again.', 'warn', 'Hook'),
    a(2 * HOUR + 10 * MIN, [
      think('Signing needs the bucket client and a TTL. I should keep the key layout identical to the old endpoint so the cleanup job still finds these files. Write the endpoint first, then route it.'),
      text('Starting with the endpoint. The key layout stays the same as the old one, so the nightly cleanup job keeps working.'),
      use('toolu_u3', 'Write', { file_path: 'server/signed-upload.ts', content: "import { bucket } from './storage';\n\nconst TTL_SECONDS = 15 * 60;\n\nexport async function sign(req, res) {\n  const key = `uploads/${req.user.id}/${Date.now()}`;\n  const url = await bucket.signedWriteUrl(key, { expiresIn: TTL_SECONDS, maxBytes: 25_000_000 });\n  res.json({ key, url, expiresIn: TTL_SECONDS });\n}" }),
    ]),
    result(2 * HOUR + 9.5 * MIN, 'toolu_u3', 'File created successfully at: server/signed-upload.ts'),
    a(2 * HOUR + 9 * MIN, [use('toolu_u4', 'Edit', { file_path: 'server/routes.ts', old_string: "  router.post('/api/uploads', requireAuth, uploads.handle);", new_string: "  router.post('/api/uploads', requireAuth, uploads.handle); // kept for the mobile app until 4.2\n  router.post('/api/uploads/sign', requireAuth, signedUpload.sign);" })]),
    result(2 * HOUR + 8.8 * MIN, 'toolu_u4', 'The file server/routes.ts has been updated.'),
    notice('API error 529 (overloaded error). Retrying in 4 s, attempt 2 of 10.', 'warn', 'API'),
    a(2 * HOUR + 7 * MIN, [text('Now a test, so the new path is covered before anything depends on it.'), use('toolu_u5', 'Bash', { command: 'npx vitest run server/uploads', description: 'Run the upload tests' })]),
    result(2 * HOUR + 6 * MIN, 'toolu_u5', ' FAIL  server/uploads.test.ts > signed uploads > rejects files over the limit\nAssertionError: expected 200 to be 413\n\n Test Files  1 failed (1)\n      Tests  1 failed | 11 passed (12)', true),
    a(2 * HOUR + 5 * MIN, [text('The test caught something real: `maxBytes` is passed to the bucket but my handler never checks the size the client announces. A client could ask for a URL for a 4 GB file. I will reject it before signing.'), use('toolu_u6', 'Edit', { file_path: 'server/signed-upload.ts', old_string: '  const key = `uploads/${req.user.id}/${Date.now()}`;', new_string: "  if (Number(req.body.size) > MAX_BYTES) return res.status(413).json({ error: 'File too large', code: 'too_large' });\n  const key = `uploads/${req.user.id}/${Date.now()}`;" })]),
    result(2 * HOUR + 4.8 * MIN, 'toolu_u6', 'The file server/signed-upload.ts has been updated.'),
    u(2 * HOUR + 4 * MIN, 'Also give the signed URL a 15 minute expiry.', { queued: true }),
    a(2 * HOUR + 3.5 * MIN, [text('Already in: `TTL_SECONDS` is 15 minutes. I will add a test that asserts the `expiresIn` field so it cannot drift.'), use('toolu_u7', 'Bash', { command: 'npx vitest run server/uploads', description: 'Run the upload tests again' })]),
    result(2 * HOUR + 3 * MIN, 'toolu_u7', ' RUN  v2.1.4 /code/acme-web\n\n ✓ server/uploads.test.ts (13 tests) 412ms\n\n Test Files  1 passed (1)\n      Tests  13 passed (13)\n   Duration  1.31s'),
    notice('Stop hook feedback:\nRun the full test suite before you finish. Only server/uploads was run after the last edit.', 'warn', 'Hook'),
    a(2 * HOUR + 2 * MIN, [text('Fair. Before the full suite, I want to know whether anything else still depends on the old endpoint, so I am sending a subagent through the mobile and web clients while I run it.'), use('toolu_u8', 'Task', { description: 'Check which clients still call the old upload endpoint', subagent_type: 'Explore', prompt: 'Find every caller of POST /api/uploads in web/ and mobile/. Report file, line, and whether it can switch to /api/uploads/sign.' })]),
    result(2 * HOUR + 1 * MIN, 'toolu_u8', 'Two callers of POST /api/uploads:\n- web/src/lib/upload.ts:12 (can switch to /api/uploads/sign now)\n- mobile/src/api/uploads.ts:27 (keep until the 4.2 release; the app cannot be updated server-side)\nNo other callers, including scripts/ and the admin tool.'),
    a(2 * HOUR + 50_000, [use('toolu_u9', 'Bash', { command: 'npx vitest run', description: 'Run the full test suite' })]),
    result(2 * HOUR + 10_000, 'toolu_u9', ' ✓ server/uploads.test.ts (13 tests) 398ms\n ✓ server/auth.test.ts (22 tests) 207ms\n ✓ server/routes.test.ts (31 tests) 633ms\n ✓ web/upload.test.ts (9 tests) 151ms\n\n Test Files  4 passed (4)\n      Tests  75 passed (75)\n   Duration  3.84s'),
    notice('You have used 82% of your 5-hour limit. It resets 12:15 PM.', 'warn', 'Limit'),
    a(2 * HOUR, `### Signed uploads are in

The web client can now send files straight to the bucket. The API process never sees the bytes.

| Endpoint | What it does | Status |
| ${DASH} | ${DASH} | ${DASH} |
| \`POST /api/uploads/sign\` | Returns a signed URL, valid for 15 minutes | New |
| \`POST /api/uploads\` | Streams the file through the API | Kept for mobile until 4.2 |

**What changed**
- \`server/signed-upload.ts\` is new; \`server/routes.ts\` registers it next to the old route
- uploads over 25 MB are refused before a URL is signed (\`413\`, \`too_large\`)
- 13 upload tests and the full suite pass (75 tests)

**Still to do**
1. Point \`web/src/lib/upload.ts\` at the signed URL
2. Remove \`POST /api/uploads\` once 4.2 is out

I have not touched the mobile app. Want me to start on the web client next?`),
  ];
  return { earlier, page };
}

/**
 * Short conversations (a request, a look at the code, a reply) for the sessions the
 * scenes only open or list, so a pane opened from the rail never reads as filler.
 * prompt, then optionally one tool call (name, input, result), then the reply.
 */
const BRIEF = {
  invoices: {
    prompt: 'The new tax API rounds per invoice instead of per line. Move invoice totals over and keep the old numbers matching for the existing fixtures.',
    tool: ['Read', { file_path: 'src/invoices/totals.ts' }, 'export function totals(invoice: Invoice) {\n  const tax = invoice.lines.reduce((sum, l) => sum + calcTax(l), 0);\n  return { net: net(invoice), tax, gross: net(invoice) + tax };\n}'],
    reply: 'Totals are built in `totals.ts` by summing `calcTax(line)`. The new endpoint takes the whole invoice, so that loop becomes one call.\n\nOne catch: per-invoice rounding can differ by a cent from the old per-line sum. I will keep the old fixtures and add a test that names the cases where the two disagree.',
  },
  push: {
    prompt: 'Push notifications are dropped after a single FCM error. Add retries with backoff, but not for dead tokens.',
    tool: ['Read', { file_path: 'src/workers/push.ts' }, 'export async function deliver(job: PushJob) {\n  const res = await fcm.send(job.token, job.payload);\n  if (!res.ok) throw new Error(res.error);\n}'],
    reply: 'Any failed send throws, and the queue gives up on the first error. I will retry the transient errors (`UNAVAILABLE`, `INTERNAL`) three times with exponential delay, and drop the token on `UNREGISTERED` instead of retrying it.',
  },
  review: {
    prompt: 'Review PR 482, the rate limiter for the public API. Tell me what to fix before it merges.',
    tool: ['Bash', { command: 'gh pr view 482', description: 'Read the pull request' }, 'Add token bucket rate limiter for the public API\nopen, 3 files changed, +112 -5\nChecks: 14 passing'],
    reply: 'Mostly good. Two things I would change before it merges:\n\n1. The bucket refills from `Date.now()`, so a clock that steps backwards **grants extra tokens**. Use a monotonic timer.\n2. The limit is per IP, and the API sits behind the load balancer, so every client shares one address. It should key on the API key.\n\nWant me to leave these as review comments on the pull request?',
  },
  dashboard: {
    prompt: 'The dashboard flashes when it first loads. Find out why.',
    tool: ['Read', { file_path: 'src/pages/Dashboard.tsx' }, 'export function Dashboard() {\n  const { data } = useStats();\n  if (!data) return <Spinner />;\n  return <Layout stats={data} />;\n}'],
    reply: 'The first paint is a spinner and the second is the whole layout, so everything shifts when `useStats` resolves. Rendering the layout with skeleton rows instead would leave only the numbers to change.',
  },
  backfill: {
    prompt: 'Some invoices have no PDF because the renderer was down for two weeks. Backfill them without calling the payment provider again.',
    tool: ['Bash', { command: 'node scripts/count-missing-pdfs.js', description: 'Count invoices with no PDF' }, '1,284 invoices have no PDF (oldest: 2026-03-02, newest: 2026-10-11)'],
    reply: '1,284 invoices, all from the two weeks the renderer was down. The renderer only needs the stored invoice, not the provider, so the backfill can run offline. I will do it in batches of 50 and stop on the first error.',
  },
  darkmode: {
    prompt: 'Add dark mode to the settings screen and follow the system setting by default.',
    tool: ['Grep', { pattern: 'useColorScheme', path: 'src' }, 'src/theme/useTheme.ts:8:  const scheme = useColorScheme();\nsrc/screens/Home.tsx:21:  const { colors } = useTheme();'],
    reply: 'The theme hook already follows the system setting; only `SettingsScreen` has hard coded colors. I will move those onto the theme tokens and add a toggle that overrides the system choice.',
  },
};

/** Short stand-in conversations for sessions the scenes only open or list. */
function genericHistory(session, now, key) {
  const { u, a, result, use, text } = kit(now);
  const b = BRIEF[key];
  const age = session.ageMs;
  if (!b) {
    return [
      u(age + 4 * MIN, session.firstPrompt || session.title),
      a(age + 3 * MIN, [text('I read the code around it first, made the change, and ran the tests. Everything passes. The diff is small and touches two files; say the word and I will open the pull request.')]),
    ];
  }
  const out = [u(age + 8 * MIN, b.prompt)];
  if (b.tool) {
    out.push(a(age + 7 * MIN, [use('toolu_b1', b.tool[0], b.tool[1])]));
    out.push(result(age + 6.5 * MIN, 'toolu_b1', b.tool[2]));
  }
  out.push(a(age + 6 * MIN, [text(b.reply)]));
  return out;
}

/**
 * The transcript for one session: { messages, earlier } where `messages` is
 * the newest page and `earlier` an older page the pane loads on demand
 * (history scene), or null.
 */
export function buildHistory(id, now) {
  if (id === ID.flaky) return { messages: flakyHistory(now), earlier: null };
  if (id === ID.uploads) { const h = uploadsHistory(now); return { messages: h.page, earlier: h.earlier, total: 94, earlierCount: 58 }; }
  const s = buildSessions(now).find((x) => x.id === id);
  if (!s) return { messages: [], earlier: null };
  const key = Object.keys(ID).find((k) => ID[k] === id);
  return { messages: genericHistory({ ...s, ageMs: now - s.lastModified }, now, key), earlier: null };
}

/** What the engine's context event says per session (percent of a 200k window). */
export const CONTEXT = {
  [ID.flaky]: { percentage: 34, totalTokens: 68_000 },
  [ID.uploads]: { percentage: 74, totalTokens: 148_000 },
  [ID.dashboard]: { percentage: 12, totalTokens: 24_000 },
  [ID.invoices]: { percentage: 52, totalTokens: 104_000 },
  [ID.darkmode]: { percentage: 21, totalTokens: 42_000 },
  [ID.backfill]: { percentage: 45, totalTokens: 90_000 },
};

export const CONTEXT_USED = [
  { name: 'Messages', tokens: 41_200 },
  { name: 'Tool results', tokens: 18_600 },
  { name: 'System prompt', tokens: 4_900 },
  { name: 'Skills', tokens: 3_300 },
];

/** Slash commands the composer offers (engine "commands" event). */
export const COMMANDS = [
  { name: 'compact', description: 'Clear the conversation but keep a summary in context' },
  { name: 'review', description: 'Review a pull request' },
  { name: 'init', description: 'Create a CLAUDE.md for this project' },
  { name: 'context', description: 'Show how full the context window is' },
  { name: 'cost', description: 'Show the cost of this session' },
  { name: 'security-review', description: 'Review the pending changes for security problems' },
];

/* Glass */

/**
 * Three Claude subscriptions, one API key and one Codex account, in the
 * shape of the engine's glass event (engine.js glassView). `active` marks
 * the live login per provider.
 */
export function buildGlass(now) {
  const at = (ms) => new Date(now + ms).toISOString();
  const sub = (id, name, plan, headroom, windows, extra = {}) => ({
    id, name, plan, isKey: false, state: 'ok', headroom, detail: '', windows, active: false, hidden: false, label: name, email: `${id}@acme.example`, leftUsd: null, ...extra,
  });
  const claude = [
    {
      id: 'key-acme', name: 'Acme Console', plan: 'API key', isKey: true, state: 'ok', headroom: 71, leftUsd: 142.5, creditUsd: 200, windows: [], active: false,
      detail: 'Acme Inc', label: 'Acme Console', hidden: false, keyHint: '...9f3c', spentUsd: 57.5, error: '', email: '',
    },
    sub('work', 'Work', 'Max 20x', 64, [{ label: '5-hour', percent: 36, resetsAt: at(2 * HOUR + 14 * MIN) }, { label: 'Weekly', percent: 41, resetsAt: at(3 * DAY + 5 * HOUR) }], { active: true }),
    sub('team', 'Team seat', 'Team', 82, [{ label: '5-hour', percent: 11, resetsAt: at(4 * HOUR + 3 * MIN) }, { label: 'Weekly', percent: 18, resetsAt: at(4 * DAY) }]),
    sub('side', 'Side projects', 'Pro', 23, [{ label: '5-hour', percent: 77, resetsAt: at(1 * HOUR + 31 * MIN) }, { label: 'Weekly', percent: 64, resetsAt: at(2 * DAY + 2 * HOUR) }]),
  ];
  const codex = [
    sub('codex-main', 'Codex', 'Plus', 71, [{ label: '5-hour', percent: 29, resetsAt: at(3 * HOUR) }, { label: 'Weekly', percent: 33, resetsAt: at(5 * DAY) }], { active: true, provider: 'codex' }),
  ];
  return { claude, codex };
}

/** The rail's subagent rows for a session (engine "subagents" event). */
export function buildSubagents(id, now) {
  if (id === ID.flaky) {
    return {
      agents: [
        { id: 'agent-f1', toolUseId: 'toolu_f9', description: 'Find other tests that wait on a banner', type: 'Explore', model: 'claude-haiku-5-5', running: false, startedAt: now - 3 * HOUR, lastAt: now - 3 * HOUR + 40_000 },
        { id: 'agent-f2', toolUseId: 'toolu_f10', description: 'Check the CI runner image for timing differences', type: 'Explore', model: 'claude-haiku-5-5', running: false, startedAt: now - 3 * HOUR, lastAt: now - 3 * HOUR + 70_000 },
      ],
      shells: [],
    };
  }
  if (id === ID.uploads) {
    return {
      agents: [
        { id: 'agent-u1', toolUseId: 'toolu_u8', description: 'Check which clients still call the old upload endpoint', type: 'Explore', model: 'claude-haiku-5-5', running: false, startedAt: now - 2 * HOUR - 2 * MIN, lastAt: now - 2 * HOUR - 1 * MIN },
        { id: 'agent-u2', toolUseId: 'toolu_u10', description: 'Audit bucket CORS settings for browser uploads', type: 'general-purpose', model: 'claude-sonnet-5-5', running: false, startedAt: now - 3 * HOUR, lastAt: now - 3 * HOUR + 2 * MIN },
        { id: 'agent-u3', toolUseId: 'toolu_u11', description: 'List image formats the web client accepts', type: 'Explore', model: 'claude-haiku-5-5', running: false, startedAt: now - 4 * HOUR, lastAt: now - 4 * HOUR + 30_000 },
      ],
      shells: [],
    };
  }
  return { agents: [], shells: [] };
}

/** A subagent's own transcript (what its viewer pane shows), keyed by agent id. */
export function buildAgentLines(agentId, now) {
  const { u, a, result, use, text } = kit(now);
  if (agentId === 'agent-u1' || agentId === 'task-live-1') {
    return [
      u(2 * HOUR + 2 * MIN, 'Find every caller of POST /api/uploads in web/ and mobile/. Report file, line, and whether it can switch to /api/uploads/sign.'),
      a(2 * HOUR + 100_000, [use('toolu_s1', 'Grep', { pattern: "post\\(['\"]/api/uploads", path: '.' })]),
      result(2 * HOUR + 95_000, 'toolu_s1', 'web/src/lib/upload.ts:12\nmobile/src/api/uploads.ts:27'),
      a(2 * HOUR + 90_000, [use('toolu_s2', 'Read', { file_path: 'mobile/src/api/uploads.ts' })]),
      result(2 * HOUR + 85_000, 'toolu_s2', "export async function uploadPhoto(file) {\n  const body = new FormData();\n  body.append('file', file);\n  return client.post('/api/uploads', body);\n}"),
      a(2 * HOUR + 70_000, [text('Two callers.\n\n- `web/src/lib/upload.ts:12` can switch to `/api/uploads/sign` now\n- `mobile/src/api/uploads.ts:27` must keep the old endpoint until the 4.2 release, because the shipped app cannot be updated server-side\n\nNo other callers, including `scripts/` and the admin tool.')]),
    ];
  }
  return [
    u(3 * HOUR, 'Look through the repo and report what you find.'),
    a(3 * HOUR - 30_000, [text('Done. Nothing that needs a change; notes are in the summary above.')]),
  ];
}

/* starting workspaces, one per scene */

const leaf = (pane, sessionId, extra = {}) => ({ type: 'leaf', pane, s: sessionId, cwd: '', title: '', model: 'claude-opus-5-5', effort: 'high', mode: 'acceptEdits', draft: '', queue: [], scroll: null, busy: false, ...extra });

/**
 * Named starting workspaces. A preset is { tabs, active, scripts, rail }:
 * tabs are { focused, root } in the app's saved-workspace shape (app.js
 * snapshot()), `scripts` says which scripted turn a session plays when a
 * message is sent (see turns.mjs), `rail` is the rail's starting view.
 */
export const PRESETS = {
  /** A lived-in window: three tabs, the focused one idle at the end of a conversation. */
  base: () => ({
    active: 0,
    tabs: [
      { focused: 'pa1', root: leaf('pa1', ID.flaky, { title: 'Fix flaky checkout test', cwd: CWD.web }) },
      { focused: 'pa2', root: leaf('pa2', ID.uploads, { title: 'Move image uploads to signed URLs', cwd: CWD.web, model: 'claude-sonnet-5-5', effort: 'xhigh' }) },
      { focused: 'pa3', root: leaf('pa3', ID.darkmode, { title: 'Dark mode for the settings screen', cwd: CWD.mobile, model: 'claude-sonnet-5-5' }) },
    ],
    scripts: { [ID.flaky]: ['flaky-fix'] },
    rail: { view: 'all', expanded: [], scroll: 0, width: 352, collapsed: false },
  }),
};

PRESETS.sessions = () => PRESETS.base();
PRESETS.steer = () => PRESETS.base();
PRESETS['glass-swap'] = () => PRESETS.base();
PRESETS['phone-pair'] = () => PRESETS.base();
PRESETS.search = () => PRESETS.base();
// The phone client (phone.html, 2026-10-12): the same lived-in PC; the phone starts on its sessions list.
PRESETS.phone = () => PRESETS.base();
// The phone's Browser view (2026-10-12): the flaky-checkout conversation plays a browser visit, as the engine reports it.
PRESETS['phone-browser'] = () => {
  const p = PRESETS.base();
  p.scripts = { [ID.flaky]: ['browse-phone'] };
  return p;
};

// Codex installed (2026-10-12): a Codex thread open next to a Claude conversation, the rail on its Codex view.
PRESETS.codex = () => {
  const p = PRESETS.base();
  p.codex = true;
  p.tabs = [
    { focused: 'pc1', root: { type: 'split', dir: 'row', sizes: [0.5, 0.5], children: [
      leaf('pc1', ID.codexPricing, { title: 'Refactor the pricing table component', cwd: CWD.web, kind: 'codex', model: 'gpt-6.1-sol', effort: 'low', mode: 'auto' }),
      leaf('pa1', ID.flaky, { title: 'Fix flaky checkout test', cwd: CWD.web }),
    ] } },
    p.tabs[1],
  ];
  p.rail = { ...p.rail, view: 'codex' };
  return p;
};

// Git worktrees (2026-10-12): conversations in the worktrees of two invented repositories, the sidebar on its Worktrees view.
PRESETS.worktrees = () => {
  const p = PRESETS.base();
  const web = `${CWD.web}.worktrees`;
  p.worktrees = true;
  p.tabs = [
    { focused: 'pa1', root: leaf('pa1', ID.flaky, { title: 'Fix flaky checkout test', cwd: `${web}\\fix-flaky-checkout` }) },
    { focused: 'pa2', root: leaf('pa2', ID.uploads, { title: 'Move image uploads to signed URLs', cwd: `${web}\\signed-uploads`, model: 'claude-sonnet-5-5', effort: 'xhigh' }) },
    { focused: 'pa3', root: leaf('pa3', ID.darkmode, { title: 'Dark mode for the settings screen', cwd: CWD.mobile, model: 'claude-sonnet-5-5' }) },
  ];
  p.rail = { view: 'worktrees', expanded: [], scroll: 0, width: 352, collapsed: false };
  return p;
};

PRESETS.history = () => {
  const p = PRESETS.base();
  p.tabs = [p.tabs[1], p.tabs[0], p.tabs[2]];
  return p;
};

PRESETS.browser = () => {
  const p = PRESETS.base();
  p.scripts = { [ID.flaky]: ['browse-checkout'] };
  return p;
};

/**
 * The handoff (2026-10-12): the desktop has one tab of three sessions, the sidebar folded away. "Fix flaky
 * checkout test" (the left column, focused) is the one you were in; it is idle, the two on the right work.
 */
const HANDOFF_ROOT = {
  type: 'split', dir: 'row', sizes: [0.5, 0.5], children: [
    leaf('ph1', ID.flaky, { title: 'Fix flaky checkout test', cwd: CWD.web }),
    { type: 'split', dir: 'col', sizes: [0.5, 0.5], children: [
      leaf('ph2', ID.invoices, { title: 'Migrate invoices to the new tax API', cwd: CWD.billing }),
      leaf('ph3', ID.review, { title: 'Review PR 482: rate limiter for the public API', cwd: CWD.billing }),
    ] },
  ],
};
const HANDOFF_BUSY = [ID.invoices, ID.review];

PRESETS.handoff = () => ({
  active: 0,
  tabs: [{ focused: 'ph1', root: HANDOFF_ROOT }],
  scripts: { [ID.invoices]: ['background-invoices'], [ID.review]: ['background-review'] },
  rail: { view: 'all', expanded: [], scroll: 0, width: 352, collapsed: true },
  // Scenes start these right away (scenes.mjs), so the grid is working when the clip begins.
  busy: HANDOFF_BUSY,
});

/**
 * What a phone hears about that desktop (engine desktopTabs): the same tab, its three panes in layout order,
 * which ones work and which one has focus, as apaki/engine/desktop-tabs.js sends it.
 */
const handoffDesktopTabs = () => [{
  index: 0, active: true,
  panes: [
    { kind: 'session', sessionId: ID.flaky, title: 'Fix flaky checkout test', busy: false, focused: true },
    { kind: 'session', sessionId: ID.invoices, title: 'Migrate invoices to the new tax API', busy: true, focused: false },
    { kind: 'session', sessionId: ID.review, title: 'Review PR 482: rate limiter for the public API', busy: true, focused: false },
  ],
}];

/**
 * The phone in the handoff: nothing open of its own yet; it lists the desktop's tab, and the desktop holds
 * "Fix flaky checkout test" (held), so opening it on the phone asks to take it over, as the real engine does.
 */
PRESETS['handoff-phone'] = () => ({
  active: 0,
  tabs: [],
  scripts: { [ID.flaky]: ['handoff'] },
  rail: { view: 'all', expanded: [], scroll: 0, width: 352, collapsed: false },
  desktopTabs: handoffDesktopTabs(),
  held: { [ID.flaky]: { name: 'Apaki on this PC', app: 'apaki' } },
});

/**
 * The phone in the pairing scene: nothing paired yet, so it starts on its own "Connect to your PC" screen
 * (phone-boot.mjs); once the PC allows it, its list shows the desktop of the base preset.
 */
PRESETS['pair-phone'] = () => ({
  active: 0,
  tabs: [],
  scripts: {},
  rail: { view: 'all', expanded: [], scroll: 0, width: 352, collapsed: false },
  desktopTabs: [
    { index: 0, active: true, panes: [{ kind: 'session', sessionId: ID.flaky, title: 'Fix flaky checkout test', busy: false, focused: true }] },
    { index: 1, active: false, panes: [{ kind: 'session', sessionId: ID.uploads, title: 'Move image uploads to signed URLs', busy: false, focused: true }] },
    { index: 2, active: false, panes: [{ kind: 'session', sessionId: ID.darkmode, title: 'Dark mode for the settings screen', busy: false, focused: true }] },
  ],
  phoneStart: 'welcome',
});

PRESETS.split = () => {
  const p = PRESETS.base();
  p.tabs = [
    { focused: 'pa1', root: leaf('pa1', ID.flaky, { title: 'Fix flaky checkout test', cwd: CWD.web }) },
    { focused: 'pa2', root: leaf('pa2', ID.uploads, { title: 'Move image uploads to signed URLs', cwd: CWD.web }) },
    { focused: 'pa3', root: leaf('pa3', ID.darkmode, { title: 'Dark mode for the settings screen', cwd: CWD.mobile }) },
  ];
  p.scripts = { [ID.invoices]: ['background-invoices'], [ID.push]: ['background-push'], [ID.review]: ['background-review'] };
  return p;
};
