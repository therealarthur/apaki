/**
 * Tests for Myrlin Apaki's artifacts: the store (apaki/engine/artifacts.js),
 * the localhost server that serves them under a no-network CSP and takes
 * URLs from the BROWSER shim (open-server.js), and the tools Claude gets
 * (apaki-tools.js): the show tool through a real MCP client, and the
 * PreToolUse / PostToolUse hooks that turn "open this" commands into
 * artifacts and link cards. No Claude call, no cost.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ArtifactStore, artifactsRoot, inlineLocalAssets, safeId, sniffImage } from '../apaki/engine/artifacts.js';
import { APAKI_SYSTEM_PROMPT, createApakiTools, parseArtifactRef } from '../apaki/engine/apaki-tools.js';
import { ARTIFACT_CSP, startOpenServer } from '../apaki/engine/open-server.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-art-'));
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SID = '11111111-2222-3333-4444-555555555555';

test('artifactsRoot follows LATCH_DIR, and ids are made safe', () => {
  assert.equal(artifactsRoot({ LATCH_DIR: path.join('X', 'latch') }), path.join('X', 'latch', 'artifacts'));
  assert.equal(safeId('Sales by Region / Q3!'), 'sales-by-region-q3');
  assert.equal(safeId('../../etc/passwd'), 'etc-passwd');
  assert.equal(sniffImage(Buffer.from(PNG_1PX, 'base64')), 'png');
  assert.equal(sniffImage(Buffer.from('hello')), null);
});

test('inline html, markdown, svg and base64 images are stored with an index and a note', () => {
  const root = path.join(tmp(), 'artifacts');
  const s = new ArtifactStore({ root });
  const a = s.show(SID, { title: 'Hello page', kind: 'html', content: '<!doctype html><h1>Hi</h1>' });
  assert.match(a.id, /^hello-page-[0-9a-f]{4}$/);
  assert.equal(a.rev, 1);
  assert.equal(a.kind, 'html');
  assert.equal(fs.readFileSync(path.join(root, SID, `${a.id}.html`), 'utf8'), '<!doctype html><h1>Hi</h1>');
  assert.ok(fs.existsSync(path.join(root, '_WHY_THIS_IS_HERE.md')));
  const md = s.show(SID, { title: 'Notes', kind: 'markdown', content: '# Title' });
  assert.equal(md.ext, 'md');
  const svg = s.show(SID, { title: 'Dia', kind: 'svg', content: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
  assert.equal(svg.mime, 'image/svg+xml');
  const img = s.show(SID, { title: 'Dot', kind: 'image', content: `data:image/png;base64,${PNG_1PX}` });
  assert.equal(img.ext, 'png');
  const raw = s.show(SID, { title: 'Dot 2', kind: 'image', content: PNG_1PX });
  assert.equal(raw.ext, 'png');
  assert.equal(s.list(SID).length, 5);
  assert.equal(s.get(a.id).record.sessionId, SID, 'found across sessions by id alone');
  assert.throws(() => s.show(SID, { title: 'x', kind: 'image', content: 'bm90IGFuIGltYWdl' }), /not PNG/);
  assert.throws(() => s.show(SID, { title: 'x', kind: 'html' }), /Give either content/);
  assert.throws(() => s.show(SID, { title: 'x', kind: 'weird', content: 'a' }), /Unknown kind/);
});

test('revisions: the same id updates in place and keeps earlier revisions, at most maxRevs', () => {
  const s = new ArtifactStore({ root: path.join(tmp(), 'artifacts'), maxRevs: 3 });
  const a = s.show(SID, { title: 'Chart', kind: 'html', content: 'v1' });
  const b = s.show(SID, { id: a.id, title: 'Chart', kind: 'html', content: 'v2' });
  assert.equal(b.id, a.id);
  assert.equal(b.rev, 2);
  assert.equal(s.get(a.id, { sessionId: SID }).buf.toString(), 'v2');
  assert.equal(s.get(a.id, { sessionId: SID, rev: 1 }).buf.toString(), 'v1');
  // A revision can change kind; each revision keeps its own extension.
  s.show(SID, { id: a.id, title: 'Chart', kind: 'markdown', content: 'v3' });
  const d = s.show(SID, { id: a.id, title: 'Chart', kind: 'html', content: 'v4' });
  assert.equal(d.rev, 4);
  assert.deepEqual(d.revs.map((r) => r.rev), [2, 3, 4]);
  assert.equal(s.get(a.id, { sessionId: SID, rev: 3 }).ext, 'md');
  assert.equal(fs.existsSync(path.join(s.dir(SID), `${a.id}.r1.html`)), false, 'the oldest revision beyond maxRevs is deleted');
  // An id Claude makes up is fine: it becomes that artifact.
  assert.equal(s.show(SID, { id: 'My Report', title: 'R', kind: 'markdown', content: 'x' }).id, 'my-report');
  // ...except "index", which would land on index.json.
  assert.equal(s.show(SID, { id: 'index', title: 'I', kind: 'markdown', content: 'x' }).id, 'index-page');
});

test('files: kind resolved from the extension, copied, and the same file again is a new revision', () => {
  const dir = tmp();
  const s = new ArtifactStore({ root: path.join(dir, 'artifacts') });
  fs.writeFileSync(path.join(dir, 'report.md'), '# One');
  const a = s.show(SID, { title: 'Report', kind: 'file', path: 'report.md' }, { cwd: dir });
  assert.equal(a.kind, 'markdown');
  assert.equal(a.source, path.join(dir, 'report.md'));
  fs.writeFileSync(path.join(dir, 'report.md'), '# Two');
  const b = s.show(SID, { title: 'Report', kind: 'file', path: path.join(dir, 'report.md') });
  assert.equal(b.id, a.id);
  assert.equal(b.rev, 2);
  fs.writeFileSync(path.join(dir, 'dot.png'), Buffer.from(PNG_1PX, 'base64'));
  assert.equal(s.show(SID, { title: 'Dot', kind: 'file', path: path.join(dir, 'dot.png') }).kind, 'image');
  fs.writeFileSync(path.join(dir, 'main.py'), 'print(1)\n');
  const py = s.show(SID, { title: 'Code', kind: 'file', path: path.join(dir, 'main.py') });
  assert.equal(py.kind, 'text');
  assert.equal(py.ext, 'py');
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3]));
  assert.throws(() => s.show(SID, { title: 'Bin', kind: 'file', path: path.join(dir, 'blob.bin') }), /not something Apaki can show/);
  assert.throws(() => s.show(SID, { title: 'Gone', kind: 'file', path: path.join(dir, 'nope.html') }), /File not found/);
  fs.writeFileSync(path.join(dir, 'doc.pdf'), '%PDF-1.4\n%%EOF');
  assert.equal(s.show(SID, { title: 'Doc', kind: 'file', path: path.join(dir, 'doc.pdf') }).kind, 'pdf');
});

test('html files get their local images, stylesheets and scripts inlined; remote ones stay', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'a.css'), 'h1{color:red}');
  fs.writeFileSync(path.join(dir, 'assets', 'a.js'), 'document.title="ok"</script>');
  fs.writeFileSync(path.join(dir, 'dot.png'), Buffer.from(PNG_1PX, 'base64'));
  const html = '<link rel="stylesheet" href="assets/a.css"><link rel="icon" href="x.ico"><script type="module" crossorigin src="/assets/a.js"></script><img src="dot.png"><img src="https://example.com/x.png">';
  const out = inlineLocalAssets(html, dir);
  assert.match(out, /<style>\nh1\{color:red\}\n<\/style>/);
  assert.match(out, /<script type="module">\ndocument\.title="ok"<\\\/script>\n<\/script>/);
  assert.match(out, /<img src="data:image\/png;base64,iVBOR/);
  assert.match(out, /<img src="https:\/\/example\.com\/x\.png">/);
  assert.match(out, /<link rel="icon" href="x\.ico">/);
});

test('servedFile refuses anything outside a session folder', () => {
  const s = new ArtifactStore({ root: path.join(tmp(), 'artifacts') });
  const a = s.show(SID, { title: 'P', kind: 'html', content: 'x' });
  assert.ok(s.servedFile(SID, `${a.id}.html`));
  assert.equal(s.servedFile(SID, '../index.json'), null);
  assert.equal(s.servedFile(SID, 'index.json'), null);
  assert.equal(s.servedFile('..', `${a.id}.html`), null);
  assert.equal(s.servedFile(SID, `${a.id}.html/..`), null);
});

test('the server serves artifacts under the no-network CSP, behind its token and host check', async () => {
  const s = new ArtifactStore({ root: path.join(tmp(), 'artifacts') });
  const opened = [];
  const srv = await startOpenServer({ store: s, onOpen: (paneId, url) => opened.push([paneId, url]) });
  try {
    const a = s.show(SID, { title: 'P', kind: 'html', content: '<h1>x</h1>' });
    const u = srv.artifactUrl(a);
    const r = await fetch(u);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), '<h1>x</h1>');
    assert.equal(r.headers.get('content-security-policy'), ARTIFACT_CSP);
    assert.match(ARTIFACT_CSP, /default-src 'none'/);
    assert.match(ARTIFACT_CSP, /sandbox allow-scripts allow-forms allow-modals/);
    assert.doesNotMatch(ARTIFACT_CSP, /allow-same-origin/);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal((await fetch(u.replace(srv.uiToken, 'nope'))).status, 403);
    assert.equal((await fetch(`${srv.base}/a/${srv.uiToken}/${SID}/..%2Findex.json`)).status, 404);
    // An earlier revision has its own address.
    s.show(SID, { id: a.id, title: 'P', kind: 'html', content: '<h1>y</h1>' });
    assert.equal(await (await fetch(srv.artifactUrl(s.record(a.id, SID), 1))).text(), '<h1>x</h1>');

    // The BROWSER shim's endpoint: POST with the pane's token only.
    const t = srv.paneToken('pane-1');
    assert.equal(srv.paneToken('pane-1'), t, 'one token per pane');
    const post = (body, token) => fetch(srv.openUrl, { method: 'POST', headers: { 'x-apaki-token': token, 'content-type': 'application/json' }, body });
    assert.equal((await post(JSON.stringify({ url: 'http://localhost:5173/' }), t)).status, 204);
    assert.equal((await post(JSON.stringify({ url: 'http://localhost:5173/' }), 'wrong')).status, 403);
    assert.equal((await post(JSON.stringify({ url: 'javascript:alert(1)' }), t)).status, 400);
    assert.equal((await fetch(`${srv.openUrl}?url=http://x`)).status, 404, 'a GET (a navigation) never opens anything');
    assert.deepEqual(opened, [['pane-1', 'http://localhost:5173/']]);
    srv.forget('pane-1');
    assert.equal((await post(JSON.stringify({ url: 'http://localhost:5173/' }), t)).status, 403);
  } finally {
    await srv.close();
  }
});

function toolsFor(dir) {
  const store = new ArtifactStore({ root: path.join(dir, 'artifacts') });
  const events = { artifacts: [], urls: [] };
  const tools = createApakiTools({
    store, sessionId: () => SID, cwd: () => dir, home: dir, env: {},
    onArtifact: (rec, meta) => events.artifacts.push({ rec, meta }),
    onOpenUrl: (o) => events.urls.push(o),
  });
  return { store, events, tools };
}

test('the show tool works through a real MCP client: html, update by id, url, errors', async () => {
  const dir = tmp();
  const { events, tools } = toolsFor(dir);
  const server = tools.mcpServers().apaki;
  assert.equal(server.type, 'sdk');
  assert.equal(server.name, 'apaki');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(st);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(ct);
  try {
    const list = await client.listTools();
    // view_read (2026-10-13): the user's edits of what was shown, read back.
    assert.deepEqual(list.tools.map((t) => t.name), ['show', 'view_read']);
    assert.equal(list.tools[0]._meta?.['anthropic/alwaysLoad'], true, 'never deferred behind tool search');
    assert.deepEqual(list.tools[0].inputSchema.required.sort(), ['kind', 'title']);

    const r1 = await client.callTool({ name: 'show', arguments: { title: 'Demo', kind: 'html', content: '<h1>demo</h1>' } });
    assert.equal(r1.isError, false);
    const ref = parseArtifactRef(r1.content[0].text);
    assert.equal(ref.rev, 1);
    assert.match(r1.content[0].text, /They can see it beside this conversation now/);
    assert.equal(events.artifacts[0].rec.id, ref.id);

    const r2 = await client.callTool({ name: 'show', arguments: { title: 'Demo', kind: 'html', content: '<h1>demo 2</h1>', id: ref.id } });
    assert.deepEqual(parseArtifactRef(r2.content[0].text), { id: ref.id, rev: 2 });
    assert.match(r2.content[0].text, /^Updated "Demo"/);

    const r3 = await client.callTool({ name: 'show', arguments: { title: 'Dev server', kind: 'url', url: 'http://localhost:5173/' } });
    assert.equal(r3.isError, false);
    assert.equal(events.urls[0].url, 'http://localhost:5173/');
    assert.equal(events.urls[0].reason, 'show');

    const r4 = await client.callTool({ name: 'show', arguments: { title: 'Bad', kind: 'url', url: 'not a url' } });
    assert.equal(r4.isError, true);
    const r5 = await client.callTool({ name: 'show', arguments: { title: 'Missing', kind: 'file', path: 'nope.html' } });
    assert.equal(r5.isError, true);
    assert.match(r5.content[0].text, /File not found/);
  } finally {
    await client.close();
  }
  assert.match(APAKI_SYSTEM_PROMPT, /mcp__apaki__show/);
});

test('PreToolUse: a pure open is denied and shown; a mixed command loses only its open step', async () => {
  const dir = tmp();
  const { events, tools } = toolsFor(dir);
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>site</h1>');

  const pre = (tool_name, command) => tools.preToolUse({ hook_event_name: 'PreToolUse', tool_name, tool_input: { command }, cwd: dir }, `tu-${Math.random()}`);

  const d1 = await pre('Bash', 'start index.html');
  assert.equal(d1.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(d1.hookSpecificOutput.permissionDecisionReason, /^Opened in Apaki instead: .*index\.html \(artifact index-html-[0-9a-f]{4}, rev 1\)/);
  assert.equal(events.artifacts.length, 1);
  assert.equal(events.artifacts[0].meta.via, 'start');

  const d2 = await pre('PowerShell', 'Start-Process http://localhost:5173');
  assert.equal(d2.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(d2.hookSpecificOutput.permissionDecisionReason, /Opened in Apaki instead: http:\/\/localhost:5173/);
  assert.equal(events.urls.at(-1).url, 'http://localhost:5173');

  // Opening the same file again is a new revision of the same artifact.
  await pre('Bash', 'start index.html');
  assert.equal(events.artifacts.at(-1).rec.rev, 2);

  // A missing file: denied, and Claude is told why.
  const d3 = await pre('Bash', 'start missing.html');
  assert.match(d3.hookSpecificOutput.permissionDecisionReason, /could not be shown: File not found/);

  // Work commands pass untouched.
  assert.deepEqual(await pre('Bash', 'npm start'), {});
  assert.deepEqual(await pre('PowerShell', 'Start-Sleep 2'), {});
  assert.deepEqual(await tools.preToolUse({ tool_name: 'Read', tool_input: { file_path: 'x' } }, 't'), {});

  // Build then open: the build runs without the open, the file shows after it.
  const id = 'tu-build';
  const before = events.artifacts.length;
  const r = await tools.preToolUse({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm run build && start dist/out.html', description: 'build' }, cwd: dir }, id);
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(r.hookSpecificOutput.updatedInput, { command: 'npm run build && true', description: 'build' });
  assert.equal(events.artifacts.length, before, 'nothing shown before the command ran');
  fs.mkdirSync(path.join(dir, 'dist'));
  fs.writeFileSync(path.join(dir, 'dist', 'out.html'), '<p>built</p>');
  const post = await tools.postToolUse({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }, id);
  assert.match(post.hookSpecificOutput.additionalContext, /Opened in Apaki instead: .*out\.html/);
  assert.equal(events.artifacts.length, before + 1);
  assert.deepEqual(await tools.postToolUse({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }, id), {}, 'only once');

  // A dev server started with an open: the page card comes at once.
  const urlsBefore = events.urls.length;
  const dev = await pre('Bash', 'npm run dev & start http://localhost:3000');
  assert.equal(dev.hookSpecificOutput.updatedInput.command, 'npm run dev & true');
  assert.equal(events.urls.length, urlsBefore + 1);

  // An open that cannot be cut out cleanly: denied with instructions.
  const piped = await pre('Bash', 'cmd /c "npm run build && start dist\\out.html"');
  assert.equal(piped.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(piped.hookSpecificOutput.permissionDecisionReason, /Run it again without the open step/);
});

test('the window rebuilds cards from history: hook notes and show results parse back', async () => {
  const { parseOpened, parseRef } = await import('../apaki/ui/artifacts.js');
  const dir = tmp();
  const { tools } = toolsFor(dir);
  fs.writeFileSync(path.join(dir, 'a.html'), '<p>a</p>');
  const r = await tools.preToolUse({ tool_name: 'Bash', tool_input: { command: 'start a.html && start http://localhost:5173/x?y=1' }, cwd: dir }, 'tu-1');
  const items = parseOpened(r.hookSpecificOutput.permissionDecisionReason);
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, 'artifact');
  assert.equal(items[0].path, path.join(dir, 'a.html'));
  assert.match(items[0].id, /^a-html-[0-9a-f]{4}$/);
  assert.equal(items[0].rev, 1);
  assert.deepEqual(items[1], { kind: 'url', url: 'http://localhost:5173/x?y=1' });
  const shown = await tools.show({ title: 'T', kind: 'markdown', content: '# t' });
  assert.deepEqual(parseRef(shown.text), { id: shown.record.id, rev: 1 });
  assert.deepEqual(parseOpened('no note here'), []);
});
