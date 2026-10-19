/**
 * apaki-queue-clicks.test.js: a queued message's Steer, Edit and x take real clicks (2026-10-19).
 *
 * Arthur: "when queing a message/prompt the steer and edit and x button do not work". The composer area lets clicks
 * through to the conversation behind it (pointer-events: none), and only the composer and the slash list took them
 * back, so the queue inherited "none" and every click on its buttons landed on the transcript. A click from script
 * ignores pointer-events, which is why an earlier check passed. Measured in the demo with real mouse clicks after the
 * fix: x removes, Edit puts the text back in the box, Steer sends it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'apaki', 'ui', 'app.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'apaki', 'ui', 'index.html'), 'utf8');

test('the composer area passes clicks through, and the queue takes them back like the composer does', () => {
  assert.match(css, /\.composer-wrap \{[^}]*pointer-events: none;/);
  const rule = css.match(/([^{}]*)\{ pointer-events: auto; \}/g)?.find((r) => r.includes('.composer-wrap > .composer'));
  assert.ok(rule, 'the rule that gives clicks back inside the composer area');
  for (const part of ['.composer-wrap > .composer', '.composer-wrap > .slash', '.composer-wrap > .queue']) assert.ok(rule.includes(part), `${part} takes clicks`);
});

test('the queue sits directly in the composer area, so the rule above reaches it', () => {
  const wrap = html.slice(html.indexOf('<section class="composer-wrap">'), html.indexOf('<div class="composer">', html.indexOf('<section class="composer-wrap">')));
  assert.match(wrap, /<div class="queue" hidden><\/div>/);
});
