/**
 * turns.mjs: scripted Claude turns for Apaki's demo harness.
 *
 * A turn is an async function that drives a Turn: it streams text the way the
 * Agent SDK does (message_start, content_block_start, text deltas, then the
 * finished assistant message), runs "tools" (an assistant tool_use block, a
 * pause, a user tool_result block), spawns subagent tasks (task_started,
 * task_progress, task_notification), says what Claude Code says itself, and
 * waits at steer points for a message the person sent with Ctrl+Enter.
 *
 * The engine (engine.mjs) picks a script per session and runs it when a
 * message is sent, or on its own for a turn Claude "started by itself".
 * Timings are real time and slow enough to read; scenes rely on them.
 *
 * Browser side (the harness page). No real Claude, no network, no files.
 */

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clock = () => performance.now();

export class TurnAborted extends Error {}

export class Turn {
  /**
   * host: { emit(ev), nextId(prefix), browser, contextSoon(paneId) } from the engine.
   * o: { paneId, sessionId, text, auto }.
   */
  constructor(host, { paneId, sessionId, text = '', auto = false }) {
    this.host = host;
    this.paneId = paneId;
    this.sessionId = sessionId;
    this.text = text;
    this.auto = auto;
    this.steers = [];
    this.aborted = false;
    this.startedAt = clock();
    this.msgId = null;
    this.tasks = 0;
  }

  emit(ev) { this.host.emit({ paneId: this.paneId, ...ev }); }

  sdk(msg) { this.emit({ ev: 'sdk', msg }); }

  abort() { this.aborted = true; }

  /** Waits ms; throws TurnAborted as soon as the turn is stopped. */
  async sleep(ms) {
    const end = clock() + ms;
    for (;;) {
      if (this.aborted) throw new TurnAborted();
      const left = end - clock();
      if (left <= 0) return;
      await wait(Math.min(left, 60));
    }
  }

  /** A new assistant message: Claude Code's message_start, which also marks an auto turn as working. */
  begin() {
    this.msgId = this.host.nextId('msg');
    this.sdk({ type: 'stream_event', event: { type: 'message_start', message: { id: this.msgId } } });
    return this.msgId;
  }

  /** Thinking: the working line shows one of its playful words for ms. */
  async think(ms = 900) {
    this.begin();
    this.sdk({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } });
    await this.sleep(ms);
  }

  /** Streams markdown as Claude's reply, about `cps` characters a second, then the finished message. */
  async say(markdown, { cps = 130 } = {}) {
    const id = this.begin();
    this.sdk({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } });
    const parts = markdown.split(/(?<=\s)/);
    let i = 0;
    while (i < parts.length) {
      const n = 2 + (i % 3);
      const chunk = parts.slice(i, i + n).join('');
      i += n;
      this.sdk({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } } });
      await this.sleep(Math.max(24, (chunk.length / cps) * 1000));
    }
    this.sdk({ type: 'assistant', message: { id, content: [{ type: 'text', text: markdown }] } });
  }

  /**
   * One tool call: Claude decides (think ms), the call shows, it runs (run ms,
   * `during` runs beside it, for page effects), and its result comes back.
   * `result` may be a string or an array of content blocks (an image).
   */
  async tool(name, input, result, { think = 260, run = 700, error = false, during = null } = {}) {
    const id = this.host.nextId('toolu');
    const mid = this.begin();
    this.sdk({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name } } });
    await this.sleep(think);
    this.sdk({ type: 'assistant', message: { id: mid, content: [{ type: 'tool_use', id, name, input }] } });
    const side = during ? Promise.resolve().then(() => during(id)).catch(() => {}) : null;
    await this.sleep(run);
    if (side) await side;
    this.sdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: error }] } });
    return id;
  }

  /**
   * A subagent (the Task tool): the call shows with an Open button, the Tasks
   * button lights while it runs, progress arrives step by step, and the result
   * comes back when it ends. steps: [{ tool, summary }] spread over ms.
   */
  async task({ description, subagentType = 'Explore', prompt = '', steps = [], summary = 'Done.', ms = 3000 }) {
    const toolId = this.host.nextId('toolu');
    const taskId = `task-live-${++this.tasks}`;
    const mid = this.begin();
    this.sdk({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolId, name: 'Task' } } });
    await this.sleep(240);
    this.sdk({ type: 'assistant', message: { id: mid, content: [{ type: 'tool_use', id: toolId, name: 'Task', input: { description, subagent_type: subagentType, prompt } }] } });
    this.host.registerAgent?.(toolId, { description, prompt, subagentType, summary, steps });
    this.sdk({ type: 'system', subtype: 'task_started', task_id: taskId, task_type: 'local_agent', subagent_type: subagentType, description, prompt, tool_use_id: toolId });
    const each = ms / (steps.length + 1);
    let tokens = 2400;
    for (let i = 0; i < steps.length; i += 1) {
      await this.sleep(each);
      tokens += 3100 + i * 900;
      this.sdk({ type: 'system', subtype: 'task_progress', task_id: taskId, usage: { tool_uses: i + 1, total_tokens: tokens, duration_ms: Math.round(each * (i + 1)) }, last_tool_name: steps[i].tool, summary: steps[i].summary });
    }
    await this.sleep(each);
    const usage = { tool_uses: steps.length, total_tokens: tokens + 1800, duration_ms: ms };
    this.sdk({ type: 'system', subtype: 'task_notification', task_id: taskId, status: 'completed', summary, usage, tool_use_id: toolId });
    this.sdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: summary, is_error: false }] } });
    return taskId;
  }

  /** A line Claude Code prints itself (a retry, a hook block, a usage warning), as the SDK sends it. */
  system(msg) { this.sdk({ type: 'system', ...msg }); }

  /**
   * Waits for a message the person sent while this turn runs (Ctrl+Enter) and
   * tells the window it went in. Returns { qid, text }, or null after timeoutMs.
   */
  async steerPoint({ timeoutMs = 30000 } = {}) {
    const end = clock() + timeoutMs;
    while (!this.steers.length) {
      if (clock() > end) return null;
      await this.sleep(60);
    }
    const s = this.steers.shift();
    this.emit({ ev: 'steered', qid: s.qid });
    return s;
  }

  /** The turn's end: the footer's numbers, and the context meter refreshed. */
  finish({ cost = 0.214, cached = 31_400, fresh = 2_600 } = {}) {
    // A steer that arrived too late goes back to the window to send as the next message.
    for (const s of this.steers.splice(0)) this.emit({ ev: 'steer_missed', qid: s.qid });
    this.emit({ ev: 'result', durationMs: Math.round(clock() - this.startedAt), usage: { cache_read_input_tokens: cached, cache_creation_input_tokens: fresh }, cost });
    this.host.contextSoon?.(this.paneId, 0.04);
  }
}

/* the scripts */

const USE_ORDER_SRC = `import { useState } from 'react';
import { api } from '../../lib/api';

export function useOrder(cart: Cart) {
  const [order, setOrder] = useState<Order | null>(null);
  const [status, setStatus] = useState<'idle' | 'paying' | 'confirmed'>('idle');

  async function pay() {
    setStatus('paying');
    setStatus('confirmed'); // runs before the order id is set
    setOrder(await api.pay(cart));
  }
  return { order, status, pay };
}`;

/** The checkout page as Claude's browser tools read it (page text with refs). */
const CHECKOUT_OUTLINE = `Page: Checkout · Acme Store (http://localhost:3000/checkout)
[1] heading "Checkout"
[2] text "2 items · $84.00"
[3] textbox "Email"
[4] textbox "Card number"
[5] textbox "Expiry"
[6] textbox "CVC"
[7] button "Pay now"
[8] link "Back to cart"`;

const SCRIPTS = {
  /** Fix flaky checkout test: reads, writes a hook fix, waits for a steer, scans another service, runs the test ten times. */
  async 'flaky-fix'(t) {
    await t.think(900);
    await t.tool('Read', { file_path: 'src/components/Checkout/useOrder.ts' }, USE_ORDER_SRC, { run: 520 });
    await t.tool('Grep', { pattern: "status === 'confirmed'", path: 'src' }, "src/pages/checkout.tsx:58:  {status === 'confirmed' && <Confirmation order={order} />}\nsrc/components/Checkout/Confirmation.tsx:9:  if (status === 'confirmed') track('checkout_done');", { run: 460 });
    await t.say('The banner is gated on `status`, so moving the `confirmed` line below `setOrder` is enough for the page. `Confirmation` also reads `order.id` without a guard, which I will leave until the hook is fixed.');
    const steer = await t.steerPoint({ timeoutMs: 45_000 });
    if (steer) await t.say('Good call. A retried payment could land a second order id after the banner is up, so I am sending a subagent to look at the retry path in billing-service while I make the edit.', { cps: 150 });
    await t.task({
      description: 'Scan billing-service for checkout retries',
      prompt: 'Find every place billing-service retries a checkout payment. Say whether a retry can create a second order id.',
      steps: [{ tool: 'Grep', summary: 'Searching for retry loops' }, { tool: 'Read', summary: 'Reading src/payments/retry.ts' }],
      summary: 'One retry loop, in src/payments/retry.ts, re-sends the charge after a 5xx. It reuses the idempotency key, so a retry cannot create a second order id.',
      ms: 2400,
    });
    await t.tool('Edit', {
      file_path: 'src/components/Checkout/useOrder.ts',
      old_string: "    setStatus('confirmed'); // runs before the order id is set\n    setOrder(await api.pay(cart));",
      new_string: "    const created = await api.pay(cart);\n    setOrder(created);\n    setStatus('confirmed'); // after the id exists",
    }, 'The file src/components/Checkout/useOrder.ts has been updated.', { run: 600 });
    await t.tool('Bash', { command: 'for i in 1 2 3 4 5 6 7 8 9 10; do npx playwright test checkout.spec.ts -x || break; done', description: 'Run the checkout test ten times' },
      '10 of 10 runs passed\nrun 1: 1 passed (1.4s)\nrun 2: 1 passed (1.3s)\nrun 3: 1 passed (1.3s)\nrun 4: 1 passed (1.4s)\nrun 5: 1 passed (1.3s)\nrun 6: 1 passed (1.3s)\nrun 7: 1 passed (1.4s)\nrun 8: 1 passed (1.3s)\nrun 9: 1 passed (1.3s)\nrun 10: 1 passed (1.4s)', { run: 1500 });
    await t.say('### Fixed\n\nThe banner now waits for the order id. `useOrder` sets `confirmed` only after `api.pay` returns, so the page can no longer show a confirmation without an order number.\n\n- ten runs in a row, ten passes (it failed one in five before)\n- the subagent found no way for a retry to create a second order id\n\nWant me to open the pull request?', { cps: 170 });
    t.finish({ cost: 0.318, cached: 52_800, fresh: 3_900 });
  },

  /** The message queued during flaky-fix goes out as the next turn. */
  async 'pr-followup'(t) {
    await t.think(700);
    await t.tool('Bash', { command: 'gh pr create -t "Fix checkout race: confirm only after the order exists" -b "useOrder set the status before the id arrived."', description: 'Open the pull request' }, 'https://github.com/acme/acme-web/pull/1291', { run: 900 });
    await t.say('Opened **#1291, Fix checkout race: confirm only after the order exists**. The description says the test was right and the hook was wrong, and links the ten passing runs.', { cps: 150 });
    t.finish({ cost: 0.061 });
  },

  /** Claude drives the built-in browser: opens the page, reads it, types, clicks, sees the problem. */
  async 'browse-checkout'(t) {
    const b = t.host.browser;
    let pageId = null;
    await t.think(500);
    await t.tool('mcp__apaki__browser_open', { url: 'http://localhost:3000/checkout' }, 'Opened http://localhost:3000/checkout in a browser pane beside this conversation.', {
      think: 200, run: 900,
      during: async () => { pageId = await b.open({ owner: t.paneId, url: 'http://localhost:3000/checkout', focus: false, reason: 'claude' }); },
    });
    await t.tool('mcp__apaki__browser_read', {}, CHECKOUT_OUTLINE, { think: 160, run: 400, during: () => b.activity(pageId, 'read the page') });
    await t.tool('mcp__apaki__browser_type', { ref: 3, text: 'sam@acme.example' }, 'Typed into [3] Email.', { think: 160, run: 700, during: async () => { b.activity(pageId, 'type [3] "sam@acme.example"'); await b.type(pageId, '#email', 'sam@acme.example'); } });
    await t.tool('mcp__apaki__browser_click', { ref: 7 }, 'Clicked [7] button "Pay now". The page now shows a confirmation with an empty order number.', {
      think: 160, run: 1300,
      during: async () => { b.activity(pageId, 'click [7] "Pay now"'); await b.click(pageId, '#pay'); },
    });
    await t.tool('mcp__apaki__browser_screenshot', {}, [{ type: 'image', source: { media_type: 'image/svg+xml', data: b.shot(pageId) } }], { think: 160, run: 400, during: () => b.activity(pageId, 'screenshot') });
    await t.say('Reproduced. The confirmation banner is already up while **Order #** is still blank, which is exactly what the test trips over. The order number arrives a moment later, so the fix belongs in the page, not the test.', { cps: 200 });
    t.finish({ cost: 0.142, cached: 24_100, fresh: 2_100 });
  },

  /** A background turn for the split scene: invoices. Long enough to stay busy for the whole clip. */
  async 'background-invoices'(t) {
    await t.think(500);
    await t.say('Moving invoice totals onto the new tax API. The old `calcTax` rounds per line and the new endpoint rounds per invoice, so I am writing a test for the one-cent difference first.', { cps: 120 });
    await t.tool('Edit', {
      file_path: 'src/invoices/totals.ts',
      old_string: '  const tax = lines.reduce((sum, l) => sum + calcTax(l), 0);',
      new_string: '  const tax = await taxApi.forInvoice({ lines, region: invoice.region });',
    }, 'The file src/invoices/totals.ts has been updated.', { run: 900 });
    await t.tool('Bash', { command: 'npx vitest run src/invoices', description: 'Run the invoice tests' }, ' ✓ src/invoices/totals.test.ts (18 tests) 301ms\n\n Test Files  1 passed (1)\n      Tests  18 passed (18)', { run: 6000 });
    await t.say('The totals match to the cent on all 18 fixtures. Next I will move the credit note path, which still calls `calcTax` directly.', { cps: 110 });
    await t.sleep(30_000);
    t.finish();
  },

  /** A background turn for the split scene: the push worker. */
  async 'background-push'(t) {
    await t.think(500);
    await t.tool('Read', { file_path: 'src/workers/push.ts' }, `export async function deliver(job: PushJob) {
  const res = await fcm.send(job.token, job.payload);
  if (!res.ok) throw new Error(res.error);
}`, { run: 700 });
    await t.say(`A failed send throws, and the queue drops the job on the first error. Transient FCM errors (\`UNAVAILABLE\`, \`INTERNAL\`) should retry with backoff; a bad token should not.

I will add three retries with exponential delay and skip the retry for \`UNREGISTERED\`.`, { cps: 115 });
    await t.tool('Edit', { file_path: 'src/workers/push.ts', old_string: '  if (!res.ok) throw new Error(res.error);', new_string: `  if (!res.ok && RETRYABLE.has(res.error)) throw new RetryLater(res.error);
  if (!res.ok) await tokens.drop(job.token);` }, 'The file src/workers/push.ts has been updated.', { run: 800 });
    await t.sleep(30_000);
    t.finish();
  },

  /** A background turn for the split scene: reviewing a pull request. */
  async 'background-review'(t) {
    await t.think(500);
    await t.say('Reading the diff for PR 482 first, then the tests it adds.', { cps: 120 });
    await t.tool('Bash', { command: 'gh pr diff 482', description: 'Read the pull request diff' }, ` src/limiter/bucket.ts | 64 +++++++++
 src/limiter/bucket.test.ts | 41 +++++
 src/api/middleware.ts | 12 +-
 3 files changed, 112 insertions(+), 5 deletions(-)`, { run: 1400 });
    await t.say('The token bucket refills from `Date.now()`, so a clock that steps backwards gives a negative elapsed time and **grants extra tokens**. The tests never move the clock. I would use a monotonic timer and add a test that rewinds it.', { cps: 115 });
    await t.sleep(30_000);
    t.finish();
  },

  /** Any other session: a short reply, so the harness works by hand too. */
  async generic(t) {
    await t.think(800);
    await t.say(`Got it. I will read the code around that first, then make the change and run the tests. Give me a moment.\n\nYou said: "${String(t.text).slice(0, 140)}"`, { cps: 120 });
    t.finish({ cost: 0.052, cached: 12_000, fresh: 900 });
  },
};

export { SCRIPTS };
