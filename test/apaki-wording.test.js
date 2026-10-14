/**
 * Platform-correct wording (2026-10-13): apaki/ui/platform.js reads the Mac
 * shell's <html data-platform="mac"> flag at call time and answers Windows / PC
 * words anywhere else (a phone browser, plain Node). apaki/engine/asksearch.js
 * shortens home folders of all three systems and builds its prompt paths with
 * the platform's separator, byte-identical to before on Windows.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { badge, explorer, isMac, osName, pc } from '../apaki/ui/platform.js';
import { digPrompt, short } from '../apaki/engine/asksearch.js';

const setPlatform = (value) => {
  globalThis.document = { documentElement: { dataset: value === undefined ? {} : { platform: value } } };
};
afterEach(() => { delete globalThis.document; });

test('platform helpers: Windows / PC words without a document, without the flag, and with another flag', () => {
  delete globalThis.document;
  for (const arrange of [() => delete globalThis.document, () => setPlatform(undefined), () => setPlatform('win')]) {
    arrange();
    assert.equal(isMac(), false);
    assert.equal(pc(), 'PC');
    assert.equal(explorer(), 'Explorer');
    assert.equal(osName(), 'Windows');
    assert.equal(badge(), 'taskbar');
  }
});

test('platform helpers: Mac words once the shell has set data-platform="mac", read at call time', () => {
  delete globalThis.document;
  assert.equal(pc(), 'PC');
  setPlatform('mac');
  assert.equal(isMac(), true);
  assert.equal(pc(), 'Mac');
  assert.equal(explorer(), 'Finder');
  assert.equal(osName(), 'macOS');
  assert.equal(badge(), 'Dock');
  globalThis.document.documentElement.dataset.platform = 'windows';
  assert.equal(pc(), 'PC', 'the answer follows the flag each time, nothing is cached');
});

test('asksearch short: ~ for a Windows, macOS or Linux home folder, other paths untouched', () => {
  assert.equal(short('C:\\Users\\arthur\\Projects\\x'), '~\\Projects\\x');
  assert.equal(short('c:\\users\\Arthur'), '~');
  assert.equal(short('/Users/arthur/Projects/x'), '~/Projects/x');
  assert.equal(short('/home/arthur/code'), '~/code');
  assert.equal(short('/opt/work'), '/opt/work');
  assert.equal(short('D:\\work'), 'D:\\work');
  assert.equal(short('/srv/Users/arthur'), '/srv/Users/arthur', 'only a leading home folder is shortened');
  assert.equal(short(undefined), '');
});

test('asksearch digPrompt: Windows paths exactly as before, forward slashes and "Mac" on a Mac', () => {
  const win = digPrompt('find it', [], { home: 'C:\\Users\\arthur', sep: '\\', platform: 'win32' });
  assert.ok(win.includes('on this PC that match this request: "find it"'));
  assert.ok(win.includes('- Claude Code: C:\\Users\\arthur\\.claude\\projects\\<project>\\<session-id>.jsonl (one JSON entry per line;'));
  assert.ok(win.includes('subagent runs live under <project>\\<session-id>\\).'));
  assert.ok(win.includes('- Codex: C:\\Users\\arthur\\.codex\\sessions\\YYYY\\MM\\DD\\rollout-*.jsonl.'));

  const mac = digPrompt('find it', [], { home: '/Users/arthur', sep: '/', platform: 'darwin' });
  assert.ok(mac.includes('on this Mac that match this request'));
  assert.ok(mac.includes('- Claude Code: /Users/arthur/.claude/projects/<project>/<session-id>.jsonl (one JSON entry'));
  assert.ok(mac.includes('subagent runs live under <project>/<session-id>/).'));
  assert.ok(mac.includes('- Codex: /Users/arthur/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.'));
  // (the search-index line carries the index binary's own path, which is this machine's, so it is left out of the check)
  assert.ok(!mac.split('\n').filter((l) => !l.includes('latch-index')).join('\n').includes('\\'), 'no backslash left in the Mac prompt paths');
});

test('asksearch digPrompt: candidate folders are shortened with the new home rules', () => {
  const p = digPrompt('q', [{ title: 'T', cwd: '/Users/arthur/app', id: 'abc' }], { home: '/Users/arthur', sep: '/', platform: 'darwin' });
  assert.ok(p.includes('- T · ~/app · abc'));
});

test('UI modules that changed still import under Node, with and without a fake document', async () => {
  // app.js, theme.js and the panes touch window / document at import; only the ones that do not are checked.
  const names = ['glasscard', 'glasspanel', 'settings', 'sessionlist', 'phone'];
  for (const withDoc of [false, true]) {
    if (withDoc) setPlatform('mac'); else delete globalThis.document;
    for (const n of names) {
      try {
        const m = await import(`../apaki/ui/${n}.js?doc=${withDoc}`);
        assert.ok(m && typeof m === 'object', `${n} imported`);
      } catch (e) {
        if (/document|window|navigator|localStorage|location/.test(String(e?.message))) continue; // touches the browser at import: skipped
        throw e;
      }
    }
  }
});
