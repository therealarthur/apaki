/**
 * apaki-claude-models.test.js: the model menus follow Claude Code's own model list (2026-11-09).
 *
 * Arthur: "myrlin apaki needs is not picking up fable 5.2". The menus were a fixed list, and the bundled Claude Code
 * (SDK 0.3.295, Claude Code 2.1.295) predated Fable 5.2. The SDK is 0.3.321 now; the engine asks a running Claude Code
 * for supportedModels and the window's menus use that list, with a fallback that already has Fable 5.2.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeModelRows } from '../apaki/engine/claude-models.js';
import { PHONE_OPS, BROADCAST_EVENTS, checkPhoneCommand } from '../apaki/engine/remote-policy.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

// What Claude Code 2.1.321 answered on 2026-11-09 (supportedModels), trimmed.
const SAMPLE = [
  { value: 'default', resolvedModel: 'claude-fable-5-2', displayName: 'Default (recommended)', description: 'Fable 5.2' },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For complex work and everyday tasks' },
  { value: 'fable', resolvedModel: 'claude-fable-5-2', displayName: 'Fable 5.2', description: 'For your toughest challenges' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: 'Most efficient for simpler tasks' },
  { value: 'claude-fable-5-1', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 5.1', description: 'Most capable' },
  { value: 'sonnet[1m]', displayName: 'odd row without a Claude id' },
];

test('Claude Code rows become one menu row per model id, aliases resolved, default left out', () => {
  const rows = claudeModelRows(SAMPLE);
  assert.deepEqual(rows.map((r) => r.id), ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-fable-5-1']);
  assert.equal(rows.find((r) => r.id === 'claude-fable-5-2').name, 'Fable 5.2', 'the alias row names it, not "Default"');
  assert.deepEqual(claudeModelRows(null), []);
  assert.deepEqual(claudeModelRows([{ value: 'default', resolvedModel: 'claude-fable-5-2', displayName: 'Default' }]), []);
});

test('the engine asks the first Claude Code that starts, keeps the list and answers claudeModels', () => {
  const engine = read('apaki', 'engine', 'engine.js');
  assert.match(engine, /import \{ claudeModelRows \} from '\.\/claude-models\.js';/);
  assert.match(engine, /if \(msg\?\.type === 'system' && msg\.subtype === 'init' && !claudeModelList\) refreshClaudeModels\(runner\);/);
  assert.match(engine, /claudeModels: \(c\) => \{\r?\n\s+emit\(\{ ev: 'claudeModels', reqId: c\.reqId \?\? null, models: claudeModelList \|\| \[\] \}\);/);
  assert.match(engine, /runner\.supportedModels\(\)/);
});

test('the window\'s menus use that list, with a fallback that knows Fable 5.2', () => {
  const pane = read('apaki', 'ui', 'pane.js');
  assert.match(pane, /fable: 'claude-fable-5-2'/);
  assert.match(pane, /'claude-fable-5-2': 'Fable 5\.2'/);
  assert.match(pane, /menu\(this\.\$\.model, this\.modelOptions\(\)\.map/);
  assert.match(pane, /model\.textContent = this\.modelName\(this\.model\);/);
  const app = read('apaki', 'ui', 'app.js');
  assert.match(app, /claudeModels: \(\) => S\.claudeModels,/);
  assert.match(app, /case 'claudeModels':/);
  assert.match(app, /send\('claudeModels'\);/);
});

test('a phone may ask for the list, and hears it when the engine sends it', () => {
  assert.ok(PHONE_OPS.includes('claudeModels'));
  assert.ok(BROADCAST_EVENTS.has('claudeModels'));
  assert.equal(checkPhoneCommand({ op: 'claudeModels', reqId: 'r1' }, { cap: 'chat', panes: new Set() }).ok, true);
});

test('the SDK is the one whose Claude Code knows Fable 5.2', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.dependencies['@anthropic-ai/claude-agent-sdk'], '0.3.321');
});
