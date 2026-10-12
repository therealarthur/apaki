/**
 * codex-history.js: a Codex thread's conversation, paged like a Claude one.
 *
 * WHY (Arthur, 2026-10-11, apaki/remote/CODEX.md: "full history from the rollout file, paged like Claude's"): a Codex
 * thread's rollout can be a gigabyte (the largest on this PC is 1.3 GB), so it is never read whole. The app-server pages
 * it by turn (thread/turns/list, newest first, an opaque cursor for the next older page; 33 ms warm, about a second
 * cold on a 245 MB rollout, measured 2026-10-12). This keeps one cursor per open thread and turns pages into the
 * messages the pane draws (codex-map.js turnsToMessages), in the shape history.js uses for Claude, so the pane's
 * "Load earlier messages", scrolling near the top and the phone page work unchanged.
 *
 * A page: { messages, total, hasMore, first, earlier, compactions, source: 'codex', countless }.
 *   first      the id of the oldest turn loaded; the pane sends it back as `before` to ask for the page before it
 *   countless  true while more exists: the server does not say how many turns or messages there are (total then
 *              counts only what has been loaded), so the pane words its loader without numbers
 */

import { turnsToMessages } from './codex-map.js';

export const PAGE = 300;
/** Turns asked for in one request; a turn often holds dozens of items. */
const TURNS_PER_REQUEST = 8;
/** A page stops after this many turns even when it holds fewer messages than asked for (long turns of tool calls). */
const PAGE_TURNS_MAX = TURNS_PER_REQUEST * 40;
/** One "Load all" call stops after this many turns, so a huge thread loads in a few clicks instead of freezing the engine. */
const ALL_TURNS_MAX = 160;
/** Turns one summary request asks for, the most requests a pass makes, and how long a pass is reused. */
const SUMMARY_PAGE = 100;
const SUMMARY_PAGES_MAX = 400;
const SUMMARY_TTL_MS = 60 * 1000;
/** A page asked to reach a picked prompt stops after this many turns. */
const UNTIL_TURNS_MAX = 20000;

export class CodexHistory {
  /**
   * @param {object} o
   * @param {(method: string, params: object) => Promise<object>} o.request  the app-server request function
   */
  constructor({ request }) {
    this.request = request;
    /** threadId -> { threadId, cursor, loaded: turns oldest first, messageCount }; cursor: undefined = not asked yet, string = older turns exist, null = that was all */
    this.threads = new Map();
  }

  forget(threadId) { this.threads.delete(threadId); }

  /** The turn page from the server's cursor: turns, newest first, until `want` messages are in hand or the turn budget is spent. Returns the new turns, oldest first. */
  async fill(st, want, turnBudget) {
    let fresh = [];
    let messages = 0;
    let used = 0;
    while (st.cursor !== null && messages < want && used < turnBudget) {
      const r = await this.request('thread/turns/list', { threadId: st.threadId, limit: TURNS_PER_REQUEST, itemsView: 'full', ...(st.cursor ? { cursor: st.cursor } : {}) });
      const turns = Array.isArray(r?.data) ? r.data : [];
      st.cursor = r?.nextCursor || null;
      used += turns.length;
      if (!turns.length) break;
      const older = turns.slice().reverse();
      fresh = [...older, ...fresh];
      messages += turnsToMessages(older).length;
    }
    return fresh;
  }

  /** The newest page of a thread (a fresh start over any earlier state). */
  async firstPage(threadId, { limit = PAGE } = {}) {
    const st = { threadId, cursor: undefined, loaded: [], messageCount: 0, summary: null, summaryAt: 0 };
    this.threads.set(threadId, st);
    const fresh = await this.fill(st, limit, PAGE_TURNS_MAX);
    st.loaded = fresh;
    const messages = turnsToMessages(fresh);
    st.messageCount = messages.length;
    st.loadedPrompts = messages.filter((m) => m.prompt).length;
    return this.pageOf(st, messages);
  }

  pageOf(st, messages) {
    const hasMore = st.cursor !== null && st.cursor !== undefined;
    const prompts = this.promptsBefore(st);
    return { messages, total: st.messageCount, hasMore, first: st.loaded[0]?.id ?? null, earlier: 0, compactions: messages.filter((m) => m.type === 'compact').length, source: 'codex', countless: hasMore, ...(prompts ? { prompts } : {}) };
  }

  /**
   * The page before the one whose oldest turn is `before`. { gone: true } when `before` is not this thread's oldest
   * loaded turn any more (the pane asked about an older state; it says so and offers a reopen). until: an item id (a
   * prompt picked in the pane's list) the page must reach, however many turns that takes (2026-10-12).
   */
  async pageBefore(threadId, before, { limit = PAGE, all = false, until = null } = {}) {
    const st = this.threads.get(threadId);
    if (!st || st.loaded[0]?.id !== before) return { gone: true, total: st?.messageCount ?? 0 };
    let fresh = await this.fill(st, all ? Number.MAX_SAFE_INTEGER : limit, all ? ALL_TURNS_MAX : PAGE_TURNS_MAX);
    if (until) {
      const has = (turns) => turns.some((t) => (t.items || []).some((i) => i?.id === until));
      for (let spent = fresh.length; !has(fresh) && st.cursor !== null && spent < UNTIL_TURNS_MAX;) {
        const more = await this.fill(st, Number.MAX_SAFE_INTEGER, PAGE_TURNS_MAX);
        if (!more.length) break;
        fresh = [...more, ...fresh];
        spent += more.length;
      }
    }
    st.loaded = [...fresh, ...st.loaded];
    const messages = turnsToMessages(fresh);
    st.messageCount += messages.length;
    st.loadedPrompts = (st.loadedPrompts || 0) + messages.filter((m) => m.prompt).length;
    return this.pageOf(st, messages);
  }

  /* ---------- your prompts across the whole thread (2026-10-12) ---------- */

  // Arthur: the prompt list "is 100% accurate - it can have 20 of 21+, but when you reach the top it should load ALL
  // prompts". The server does not say how many turns or prompts a thread has, so the pin counted only what was loaded.
  // The turn summaries (thread/turns/list with itemsView summary) carry each turn's first user message and are read
  // from the server's own index, without the items: one cheap pass over the whole thread gives every turn that has a
  // prompt. A message steered into a turn is not in its summary, so it is counted once its turn is loaded; the count
  // is exact when everything is loaded, and the pane shows "+" until the pass is done.

  /** One summary pass (cached for a minute): oldest first, [{ turnId, prompt: { id, text, at, images } | null }]. */
  async summaries(st) {
    if (st.summary && Date.now() - st.summaryAt < SUMMARY_TTL_MS) return st.summary;
    const out = [];
    let cursor = null;
    for (let i = 0; i < SUMMARY_PAGES_MAX; i++) {
      const r = await this.request('thread/turns/list', { threadId: st.threadId, limit: SUMMARY_PAGE, itemsView: 'summary', ...(cursor ? { cursor } : {}) });
      const turns = Array.isArray(r?.data) ? r.data : [];
      for (const t of turns) {
        // The first prompt message of the turn, read with the same rule the pane draws by (codex-map.js turnsToMessages).
        const first = turnsToMessages([{ ...t, status: 'completed' }]).find((m) => m.prompt);
        out.push({ turnId: t.id, prompt: first ? { id: first.uuid, text: first.prompt.text, at: first.at, images: first.prompt.images || 0 } : null });
      }
      cursor = r?.nextCursor || null;
      if (!cursor || !turns.length) break;
    }
    out.reverse();
    st.summary = out;
    st.summaryAt = Date.now();
    return out;
  }

  /** { before, total } for the loaded pages, or null while the summary pass has not run. */
  promptsBefore(st) {
    const hasMore = st.cursor !== null && st.cursor !== undefined;
    const loadedPrompts = st.loadedPrompts || 0;
    if (!hasMore) return { before: 0, total: loadedPrompts };
    if (!st.summary) return null;
    // The turns older than the oldest one loaded: found by id, so turns that came after the pass do not shift it.
    const oldest = st.loaded[0]?.id;
    const at = st.summary.findIndex((s) => s.turnId === oldest);
    const loadedIds = new Set(st.loaded.map((t) => t.id));
    const older = at >= 0 ? st.summary.slice(0, at) : st.summary.filter((s) => !loadedIds.has(s.turnId));
    const before = older.filter((s) => s.prompt).length;
    return { before, total: before + loadedPrompts };
  }

  /** Runs the summary pass for an open thread: { before, total, first } for the pane's pin, or null when it is not open. */
  async promptCount(threadId) {
    const st = this.threads.get(threadId);
    if (!st) return null;
    await this.summaries(st);
    const p = this.promptsBefore(st);
    return p ? { ...p, first: st.loaded[0]?.id ?? null } : null;
  }

  /**
   * Every prompt of the thread, oldest first, for the pane's list: the loaded turns' prompts in full (steered ones
   * included), the rest from the turn summaries. { prompts: [{ id, text, at, images }], total }.
   */
  async promptList(threadId, { chars = 240 } = {}) {
    const st = this.threads.get(threadId);
    if (!st) return null;
    const summary = await this.summaries(st);
    const loadedIds = new Set(st.loaded.map((t) => t.id));
    const cut = (s) => (s.length > chars ? `${s.slice(0, chars - 1)}…` : s);
    const prompts = [];
    for (const s of summary) if (!loadedIds.has(s.turnId) && s.prompt) prompts.push({ ...s.prompt, text: cut(s.prompt.text) });
    for (const m of turnsToMessages(st.loaded)) if (m.prompt) prompts.push({ id: m.uuid, text: cut(m.prompt.text), at: m.at, images: m.prompt.images || 0 });
    // Loaded turns are the newest ones; a turn the summary saw after them (a live one) keeps its place by time.
    prompts.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
    return { prompts, total: prompts.length };
  }
}
