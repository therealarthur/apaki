/**
 * Apaki's markdown renderer (apaki/ui/markdown.js): every construct Claude's
 * replies use, escaping, and the 2026-10-09 bug (bold text that contains
 * `code` kept its asterisks).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { highlight, inline, md } from '../apaki/ui/markdown.js';

test('bold that contains inline code renders as bold (the reported bug)', () => {
  const html = inline('**Built this turn (pushed in `43b1d8d` and `40e313c`; installs when you next close Apaki)**');
  assert.equal(html, '<strong>Built this turn (pushed in <code>43b1d8d</code> and <code>40e313c</code>; installs when you next close Apaki)</strong>');
  assert.ok(!html.includes('**'));
});

test('emphasis: bold, italic, both, underscores at word edges only, strike', () => {
  assert.equal(inline('**b** *i* ***bi*** __B__ _I_ ~~s~~'), '<strong>b</strong> <em>i</em> <strong><em>bi</em></strong> <strong>B</strong> <em>I</em> <del>s</del>');
  assert.equal(inline('file_name_here and 2 * 3 * 4'), 'file_name_here and 2 * 3 * 4');
  assert.equal(inline('a **bold** word, then *one* more'), 'a <strong>bold</strong> word, then <em>one</em> more');
});

test('code spans keep their contents literal and escaped', () => {
  assert.equal(inline('`**not bold**` and `<b>`'), '<code>**not bold**</code> and <code>&lt;b&gt;</code>');
  assert.equal(inline('``a ` b``'), '<code>a ` b</code>');
});

test('links: markdown, angle and bare; unsafe schemes stay text; html is escaped', () => {
  assert.equal(inline('[Docs](https://x.dev/a "Title")'), '<a href="https://x.dev/a" title="Title" target="_blank" rel="noreferrer">Docs</a>');
  assert.equal(inline('see <https://x.dev>'), 'see <a href="https://x.dev" target="_blank" rel="noreferrer">https://x.dev</a>');
  assert.equal(inline('go to https://x.dev/p.'), 'go to <a href="https://x.dev/p" target="_blank" rel="noreferrer">https://x.dev/p</a>.');
  assert.equal(inline('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
  assert.equal(inline('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(inline('**[bold link](https://a.b)**'), '<strong><a href="https://a.b" target="_blank" rel="noreferrer">bold link</a></strong>');
});

test('backslash escapes keep markers literal', () => {
  assert.equal(inline('\\*not italic\\* and \\`tick\\`'), '*not italic* and `tick`');
});

test('headings h1-h6, rules and paragraphs with breaks', () => {
  assert.equal(md('# One\n#### Four\n###### Six'), '<h1>One</h1>\n<h4>Four</h4>\n<h6>Six</h6>');
  assert.equal(md('---'), '<hr>');
  assert.equal(md('line one  \nline two\nsame para'), '<p>line one<br>line two same para</p>');
});

test('lists: nested by indent, numbered start, tasks, items with code', () => {
  assert.equal(md('- a\n- b\n  - b1\n  - b2\n- c'), '<ul><li>a</li><li>b\n<ul><li>b1</li><li>b2</li></ul></li><li>c</li></ul>');
  assert.equal(md('3. three\n4. four'), '<ol start="3"><li>three</li><li>four</li></ol>');
  assert.equal(md('- [x] done\n- [ ] todo'), '<ul><li class="task done"><span class="tick" aria-hidden="true"></span>done</li><li class="task"><span class="tick" aria-hidden="true"></span>todo</li></ul>');
  const withCode = md('1. Run it:\n   ```sh\n   npm test\n   ```\n2. Done');
  assert.match(withCode, /^<ol><li>Run it:\n<pre class="code lang-sh"><span class="code-lang">sh<\/span><code><span class="tok-fn">npm<\/span> test<\/code><\/pre><\/li><li>Done<\/li><\/ol>$/);
  assert.equal(md('- **Bold item** with `code`'), '<ul><li><strong>Bold item</strong> with <code>code</code></li></ul>');
});

test('block quotes span lines and hold markdown', () => {
  assert.equal(md('> **Note**\n> second line\n>\n> - item'), '<blockquote><p><strong>Note</strong> second line</p>\n<ul><li>item</li></ul></blockquote>');
});

test('tables keep alignment and inline formatting; short rows are padded', () => {
  const html = md('| Name | Count |\n|:---|---:|\n| **a** | 1 |\n| b |');
  assert.equal(html, '<div class="table-wrap"><table><thead><tr><th style="text-align:left">Name</th><th style="text-align:right">Count</th></tr></thead><tbody><tr><td style="text-align:left"><strong>a</strong></td><td style="text-align:right">1</td></tr><tr><td style="text-align:left">b</td><td style="text-align:right"></td></tr></tbody></table></div>');
});

test('fenced code: language label, escaping, syntax colours', () => {
  const html = md('```js\nconst x = "a<b>"; // note\nfoo(42)\n```');
  assert.match(html, /<span class="code-lang">js<\/span>/);
  assert.match(html, /<span class="tok-key">const<\/span>/);
  assert.match(html, /<span class="tok-str">&quot;a&lt;b&gt;&quot;<\/span>/);
  assert.match(html, /<span class="tok-com">\/\/ note<\/span>/);
  assert.match(html, /<span class="tok-fn">foo<\/span>\(<span class="tok-num">42<\/span>\)/);
  assert.equal(md('```\n<script>\n```'), '<pre class="code"><code>&lt;script&gt;</code></pre>');
  assert.equal(highlight('x = 1', 'nope'), 'x = 1');
});
