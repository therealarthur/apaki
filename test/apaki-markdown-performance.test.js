/**
 * Codex, 2026-10-12: regressions for the quadratic shell/YAML highlighting found
 * while investigating Apaki's frozen window. All fixtures are synthetic.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { highlight, md } from '../apaki/ui/markdown.js';

const rendererUrl = new URL('../apaki/ui/markdown.js', import.meta.url);
const source = readFileSync(rendererUrl, 'utf8');
const newCheck = '&& atLineStart(code, i)';
const oldCheck = String.raw`&& /(^|\n)\s*$/.test(code.slice(0, i))`;
// Restore only the superseded predicate as an independent output oracle. The
// renderer otherwise stays identical, so this checks the actual changed behavior.
assert.equal(source.split(newCheck).length - 1, 2, 'both line-start checks must be compared');
const legacy = await import(`data:text/javascript;base64,${Buffer.from(source.replaceAll(newCheck, oldCheck)).toString('base64')}`);

test('shell and YAML keep exactly the old HTML for every JavaScript whitespace character', () => {
  const whitespace = [
    '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\u1680',
    '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005',
    '\u2006', '\u2007', '\u2008', '\u2009', '\u200a',
    '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff',
  ];
  // These visually similar characters are deliberately not JavaScript whitespace.
  const nonWhitespace = ['\u0085', '\u180e', '\u200b', '\u2060', '\ud800', '\udc00', '😀'];
  for (const char of whitespace) assert.match(char, /^\s$/u);
  for (const char of nonWhitespace) assert.doesNotMatch(char, /^\s$/u);
  const separators = [...whitespace, ...nonWhitespace, '\r\n', '\n\r', whitespace.join(''), ' '.repeat(20000)];
  for (const separator of separators) {
    for (const prefix of ['', separator, `7${separator}`, `7\n${separator}`, `7${separator}\n`, `7\r${separator}`, `7\u2028${separator}`, `7\u2029${separator}`]) {
      for (const lang of ['sh', 'yaml']) {
        const code = `${prefix}probe_word${lang === 'yaml' ? ':' : ''} argument`;
        assert.equal(highlight(code, lang), legacy.highlight(code, lang), `${lang}, prefix ${JSON.stringify(prefix).slice(0, 160)}`);
        // md normalizes CR and splits LF; exercise that entry point as well.
        const fenced = `\`\`\`${lang}\n${code}\n\`\`\``;
        assert.equal(md(fenced), legacy.md(fenced));
      }
    }
  }
  assert.equal(highlight('7\rprobe_word', 'sh'), '<span class="tok-num">7</span>\rprobe_word');
  assert.equal(highlight('7\nprobe_word', 'sh'), '<span class="tok-num">7</span>\n<span class="tok-fn">probe_word</span>');
});

test('mixed code and partial streaming prefixes preserve complete HTML', () => {
  const fragments = [
    'echo alpha\n', '  npm run test && printf beta\n', '\tconfig_key: some_value\n',
    'value = call(42)\n', '"quoted \\" text"\n', "'single quoted' ", '# comment\n',
    '/* comment */ ', '$NAME ${VALUE} ', '<script>&text</script> ',
    '\n\n\t', '\r\n', '\u00a0', '\u2028', '\u2029', '\ufeff', '\u200b',
  ];
  const languages = ['sh', 'bash', 'yaml', 'toml', 'js', 'ps', 'sql', 'py', 'rust', 'json', 'html', ''];
  let seed = 0x5eed;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let sample = 0; sample < 120; sample++) {
    let code = '';
    for (let part = 0; part < 12; part++) code += fragments[next() % fragments.length];
    code = code.slice(0, 1 + next() % code.length);
    for (const lang of languages) {
      assert.equal(highlight(code, lang), legacy.highlight(code, lang), `${lang}, sample ${sample}`);
      // An unfinished fence is how this input reaches the renderer during streaming.
      const fenced = `\`\`\`${lang}\n${code}`;
      assert.equal(md(fenced), legacy.md(fenced), `${lang} fence, sample ${sample}`);
    }
  }
});

test('large shell and YAML replies avoid the old quadratic render cost', (t) => {
  // A separate process gives the synchronous parser a real deadline; node:test's
  // timeout alone cannot interrupt a blocked event loop. No files or sessions used.
  const script = `
    import { readFileSync } from 'node:fs';
    import assert from 'node:assert/strict';
    import { performance } from 'node:perf_hooks';
    const url = ${JSON.stringify(rendererUrl.href)};
    const source = readFileSync(new URL(url), 'utf8');
    const current = await import(url);
    const old = await import('data:text/javascript;base64,' + Buffer.from(source.replaceAll(${JSON.stringify(newCheck)}, ${JSON.stringify(oldCheck)})).toString('base64'));
    const results = [];
    for (const lang of ['sh', 'yaml']) {
      const line = lang === 'sh' ? 'echo testvalue\\n' : 'config_key: some_value\\n';
      const text = '\\x60\\x60\\x60' + lang + '\\n' + line.repeat(Math.ceil(120000 / line.length)).slice(0, 120000) + '\\n\\x60\\x60\\x60';
      current.md(text.slice(0, 1000)); old.md(text.slice(0, 1000));
      let currentMs = Infinity, oldMs = Infinity;
      for (let pass = 0; pass < 2; pass++) {
        const start = performance.now(); const expected = old.md(text); const middle = performance.now();
        const actual = current.md(text); const end = performance.now();
        assert.equal(actual, expected);
        oldMs = Math.min(oldMs, middle - start); currentMs = Math.min(currentMs, end - middle);
      }
      results.push({ lang, chars: text.length, currentMs, oldMs });
    }
    console.log(JSON.stringify(results));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const results = JSON.parse(child.stdout);
  for (const { lang, chars, currentMs, oldMs } of results) {
    t.diagnostic(`${lang}: ${chars} characters, current ${currentMs.toFixed(1)} ms, legacy ${oldMs.toFixed(1)} ms`);
    // A generous relative threshold tolerates normal host variation. The original
    // implementation was over 10 times slower at this size during investigation.
    assert.ok(currentMs < oldMs * 0.6, `${lang} should cost less than 60% of legacy parsing time`);
  }
});
