/**
 * worktrees.mjs: the demo harness's pretend of the engine's git worktree ops (apaki/engine/worktrees.js, engine.js
 * "git worktrees"), on invented repositories of the fictional Acme team (2026-10-12). Nothing here touches the
 * machine the harness runs on, and nothing may be replaced with a real path, branch or name.
 *
 * It answers worktrees, worktreePlan, worktreeRun and worktreeDiff the way the real engine does (same event shapes),
 * with blockers where the real one would refuse: a worktree with uncommitted files cannot be removed, a merge needs a
 * clean base. Creating a worktree adds it to the list, committing clears its changes, removing takes it out.
 *
 * createWorktrees({ emit, later, now }) returns { handle(c), repos(), remap(sessions) }.
 */

import { CWD } from './data.mjs';

// The flag prefix, built here so the source holds no double hyphen (demo.test.mjs checks the harness for them).
const DD = '-'.repeat(2);

const WEB = CWD.web;
const BILL = CWD.billing;
const wtPath = (root, name) => `${root}.worktrees\\${name}`;

/** A worktree record as the engine sends it, with the numbers filled from `o`. */
const wt = (path, branch, o = {}) => ({
  path, head: 'a1c4e7b2', branch, detached: false, bare: false, locked: null, prunable: null, main: false, stats: true,
  base: 'main', added: 0, removed: 0, files: 0, changed: 0, untracked: 0, conflicts: 0, staged: 0, upstream: '', aheadUp: 0, behindUp: 0,
  ahead: 0, behind: 0, unpushed: 0, merged: false, approx: false, ...o,
});

function buildRepos() {
  return [
    {
      id: 'c:/users/dev/code/acme-web/.git', commonDir: `${WEB}\\.git`, root: WEB, name: 'acme-web', base: 'main', remote: 'origin', linked: true, light: false,
      branches: ['main', 'fix-flaky-checkout', 'signed-uploads', 'dashboard-flash', 'tax-rounding'],
      worktrees: [
        wt(WEB, 'main', { main: true, upstream: 'origin/main' }),
        wt(wtPath(WEB, 'fix-flaky-checkout'), 'fix-flaky-checkout', { added: 42, removed: 7, files: 5, changed: 2, ahead: 3, unpushed: 3 }),
        wt(wtPath(WEB, 'signed-uploads'), 'signed-uploads', { added: 118, removed: 36, files: 9, changed: 0, ahead: 5, behind: 2, upstream: 'origin/signed-uploads', aheadUp: 0 }),
        wt(wtPath(WEB, 'dashboard-flash'), 'dashboard-flash', { merged: true, upstream: 'origin/dashboard-flash' }),
      ],
    },
    {
      id: 'c:/users/dev/code/billing-service/.git', commonDir: `${BILL}\\.git`, root: BILL, name: 'billing-service', base: 'main', remote: 'origin', linked: true, light: false,
      branches: ['main', 'tax-api', 'retry-pdf'],
      worktrees: [
        wt(BILL, 'main', { main: true, upstream: 'origin/main', added: 12, removed: 0, files: 1, changed: 1 }),
        wt(wtPath(BILL, 'tax-api'), 'tax-api', { added: 260, removed: 88, files: 14, changed: 3, ahead: 6, unpushed: 2, upstream: 'origin/tax-api', aheadUp: 2 }),
        wt(wtPath(BILL, 'retry-pdf'), 'retry-pdf', { added: 31, removed: 4, files: 3, changed: 0, ahead: 2, behind: 5, upstream: 'origin/retry-pdf' }),
      ],
    },
  ];
}

/** The same session list with a few conversations moved into worktrees, so the Worktrees view has something to nest. */
export function remapSessions(list, ID) {
  const move = {
    [ID.flaky]: wtPath(WEB, 'fix-flaky-checkout'),
    [ID.uploads]: wtPath(WEB, 'signed-uploads'),
    [ID.dashboard]: wtPath(WEB, 'dashboard-flash'),
    [ID.invoices]: wtPath(BILL, 'tax-api'),
    [ID.backfill]: wtPath(BILL, 'retry-pdf'),
  };
  return list.map((s) => (move[s.id] ? { ...s, cwd: move[s.id], branch: move[s.id].split('\\').pop() } : s));
}

/** Patches for the demo's diff viewer: invented files of the checkout test fix. */
const H3 = '-'.repeat(3); // the "from" line of a patch, built here so the source holds no double hyphen
const PATCHES = [
  {
    path: 'tests/checkout.spec.ts', status: 'M', added: 5, removed: 1,
    patch: [
      `diff ${DD}git a/tests/checkout.spec.ts b/tests/checkout.spec.ts`, 'index 3c1a9d2..b7e04f1 100644', `${H3} a/tests/checkout.spec.ts`, '+++ b/tests/checkout.spec.ts',
      "@@ -41,6 +41,10 @@ describe('checkout', () => {", "   it('shows the confirmation', async () => {", "     await page.click('text=Pay now');",
      "-    expect(await page.textContent('.confirmation')).toContain('Thank you');",
      '+    // The order id arrives after the redirect, so wait for it instead of reading the page at once.', "+    await page.waitForSelector('[data-order-id]');",
      "+    const id = await page.getAttribute('[data-order-id]', 'data-order-id');", '+    expect(id).toMatch(/^ORD-[0-9]+$/);',
      "+    expect(await page.textContent('.confirmation')).toContain('Thank you');", '   });', '',
    ].join('\n'),
  },
  {
    path: 'src/checkout/confirm.ts', status: 'M', added: 3, removed: 1,
    patch: [
      `diff ${DD}git a/src/checkout/confirm.ts b/src/checkout/confirm.ts`, 'index 51a0c7e..9d2f6b3 100644', `${H3} a/src/checkout/confirm.ts`, '+++ b/src/checkout/confirm.ts',
      '@@ -12,7 +12,9 @@ export async function confirm(order: Order) {', '   const receipt = await pay(order);', '-  return receipt;',
      '+  // Expose the id on the page for tests and for support, once the payment is final.', '+  document.body.dataset.orderId = receipt.orderId;', '+  return receipt;', ' }', '',
    ].join('\n'),
  },
  {
    path: 'docs/checkout-flow.md', status: 'A', added: 3, removed: 0, untracked: true,
    patch: [`diff ${DD}git a/docs/checkout-flow.md b/docs/checkout-flow.md`, 'new file mode 100644', `${H3} /dev/null`, '+++ b/docs/checkout-flow.md', '@@ -0,0 +1,3 @@', '+# Checkout flow', '+', '+The order id is set on the body once the payment is final.', ''].join('\n'),
  },
];

/** `enabled`: only the worktrees preset has repositories; every other scene shows the window as it was (no branch labels). */
export function createWorktrees({ emit, later, now = () => Date.now(), enabled = true }) {
  let repos = enabled ? buildRepos() : [];
  const findWt = (p) => { for (const r of repos) for (const w of r.worktrees) if (w.path === p) return { r, w }; return null; };
  const findRepo = (p) => repos.find((r) => r.root === p || r.worktrees.some((w) => w.path === p)) || null;
  const send = () => emit({ ev: 'worktrees', reqId: null, repos });

  function plan(c, run) {
    const r = findRepo(c.kind === 'create' ? c.repo : c.path);
    const base = { ev: 'worktreePlan', reqId: c.reqId, ok: true, kind: c.kind, title: '', summary: '', commands: [], blockers: [], warnings: [], data: {}, repo: r ? { root: r.root, name: r.name, base: r.base, branches: r.branches, remote: r.remote } : null };
    if (!r) return { ...base, blockers: ['That folder is not in a git repository.'] };
    const hit = c.kind === 'create' ? null : findWt(c.path);
    if (c.kind === 'create') {
      const branch = String(c.branch || '').trim();
      const path = wtPath(r.root, branch.replace(/[\\/\s]+/g, '-') || 'worktree');
      const blockers = [];
      if (!branch) blockers.push('Give the branch a name.');
      else if (r.branches.includes(branch)) blockers.push(`A branch named ${branch} already exists.`);
      return { ...base, title: 'New worktree', summary: `Make a new branch ${branch} from ${c.base || r.base} in its own folder, so work there never touches your other checkouts.`, commands: [`git worktree add -b ${branch} "${path}" ${c.base || r.base}`], blockers, data: { branch, base: c.base || r.base, path, repo: r.root, branchExists: blockers.length > 0 && Boolean(branch) } };
    }
    if (!hit) return { ...base, blockers: ['That folder is not a worktree of this repository.'] };
    const { w } = hit;
    const data = { path: w.path, branch: w.branch, merged: w.merged };
    if (c.kind === 'remove') {
      const blockers = [];
      if (w.main) blockers.push('This is the main checkout of the repository; it is not removed from here.');
      if (w.changed > 0) blockers.push(`${w.changed} files have uncommitted changes. Commit or move them first.`);
      if (w.unpushed > 0) blockers.push(`${w.unpushed} commits are not pushed anywhere and not in main. Push or merge them first.`);
      const commands = [`git worktree remove "${w.path}"`, ...(c.deleteBranch && w.merged ? [`git branch -d ${w.branch}`] : [])];
      return { ...base, title: 'Remove worktree', summary: `Remove the folder ${w.path}. The branch and everything committed to it stay unless you also delete a merged branch below.`, commands, blockers, data };
    }
    if (c.kind === 'commit') {
      const files = PATCHES.slice(0, Math.max(w.files, 1)).map((p) => ({ path: p.path, status: p.untracked ? '?' : p.status, staged: false }));
      const msg = String(c.message || '').trim();
      return { ...base, title: 'Commit', summary: `Commit ${files.length} files on ${w.branch}.`, commands: ['git add -A', `git commit -m "${msg || '<message>'}"`], blockers: [...(w.changed ? [] : ['Nothing to commit.']), ...(run && !msg ? ['Write a commit message.'] : [])], data: { ...data, files, total: files.length } };
    }
    if (c.kind === 'push') {
      return { ...base, title: 'Push', summary: w.upstream ? `Send ${w.aheadUp} commits on ${w.branch} to ${w.upstream}.` : `Publish ${w.branch} to origin and track it.`, commands: [w.upstream ? 'git push' : `git push -u origin ${w.branch}`], blockers: w.upstream && !w.aheadUp ? ['Everything is already pushed.'] : [], data };
    }
    if (c.kind === 'pr') {
      const title = String(c.title || '').trim();
      return { ...base, title: 'Open pull request', summary: `Push the branch, then open a pull request from ${w.branch} into main on GitHub.`, commands: [`git push -u origin ${w.branch}`, `gh pr create ${DD}base main ${DD}head ${w.branch} ${DD}title "${title || '<title>'}"`], blockers: run && !title ? ['Give the pull request a title.'] : [], data: { ...data, base: 'main', suggest: { title: w.branch.replace(/-/g, ' ').replace(/^./, (x) => x.toUpperCase()), body: '- Wait for the order id before asserting on the page\n- Expose the order id on the body' } } };
    }
    const base2 = findRepo(c.path).worktrees.find((x) => x.main);
    return { ...base, title: 'Merge', summary: `Merge ${w.branch} into main. Nothing is pushed, and nothing is deleted.`, commands: [`git merge ${DD}no-edit ${w.branch}`], blockers: base2.changed > 0 ? [`The main checkout (${base2.path}) has uncommitted changes. Commit or move them first so the merge cannot mix with them.`] : [], data: { ...data, into: 'main' } };
  }

  function run(c) {
    const p = plan(c, true);
    if (p.blockers.length) { later(140, { ev: 'worktreeResult', reqId: c.reqId, kind: c.kind, ok: false, error: p.blockers[0], blockers: p.blockers, commands: p.commands }); return; }
    const hit = c.kind === 'create' ? null : findWt(c.path);
    const log = p.commands.map((cmd) => ({ cmd, code: 0, out: '' }));
    let message = 'Done.';
    if (c.kind === 'create') {
      const r = findRepo(c.repo);
      r.worktrees.push(wt(p.data.path, p.data.branch, { base: p.data.base }));
      r.branches.unshift(p.data.branch);
      message = `Made ${p.data.branch} in its own folder.`;
    } else if (c.kind === 'commit') { hit.w.changed = 0; hit.w.untracked = 0; message = `Committed ${p.data.files.length} files on ${hit.w.branch}.`; } else if (c.kind === 'remove') {
      hit.r.worktrees = hit.r.worktrees.filter((x) => x !== hit.w);
      message = 'Removed the worktree.';
    } else if (c.kind === 'push') { hit.w.aheadUp = 0; hit.w.unpushed = 0; hit.w.upstream ||= `origin/${hit.w.branch}`; message = `Pushed ${hit.w.branch}.`; } else if (c.kind === 'pr') {
      hit.w.unpushed = 0; hit.w.upstream ||= `origin/${hit.w.branch}`; hit.w.aheadUp = 0; message = 'Opened the pull request.';
    } else if (c.kind === 'merge') { hit.w.merged = true; message = `Merged ${hit.w.branch} into main.`; }
    later(900, {
      ev: 'worktreeResult', reqId: c.reqId, kind: c.kind, ok: true, error: null, log, url: c.kind === 'pr' ? 'https://github.com/acme/acme-web/pull/482' : null,
      path: p.data.path || null, branch: p.data.branch || null, message, commands: p.commands,
    });
    later(1000, { ev: 'worktrees', reqId: null, repos });
  }

  function handle(c) {
    switch (c.op) {
      case 'worktrees': later(60, { ev: 'worktrees', reqId: c.reqId, repos }); return true;
      case 'worktreePlan': later(120, plan(c, false)); return true;
      case 'worktreeRun': run(c); return true;
      case 'worktreeDiff': {
        const hit = findWt(c.path);
        const files = hit ? PATCHES.map((p) => ({ ...p, oldPath: '', binary: false, untracked: Boolean(p.untracked), cut: false })) : [];
        later(160, { ev: 'worktreeDiff', reqId: c.reqId, ok: Boolean(hit), path: c.path, branch: hit?.w.branch || '', repo: hit?.r.name || '', base: 'main', ref: 'a1c4e7b2', scope: c.scope === 'head' ? 'head' : 'base', files, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0), truncated: false, error: hit ? undefined : 'That folder is not a git worktree.' });
        return true;
      }
      case 'worktreeTerminal': return true;
      default: return false;
    }
  }

  return { handle, repos: () => repos, remap: remapSessions, send, now };
}
