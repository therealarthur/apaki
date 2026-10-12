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
    const st = { threadId, cursor: undefined, loaded: [], messageCount: 0 };
    this.threads.set(threadId, st);
    const fresh = await this.fill(st, limit, PAGE_TURNS_MAX);
    st.loaded = fresh;
    const messages = turnsToMessages(fresh);
    st.messageCount = messages.length;
    return this.pageOf(st, messages);
  }

  pageOf(st, messages) {
    const hasMore = st.cursor !== null && st.cursor !== undefined;
    return { messages, total: st.messageCount, hasMore, first: st.loaded[0]?.id ?? null, earlier: 0, compactions: messages.filter((m) => m.type === 'compact').length, source: 'codex', countless: hasMore };
  }

  /**
   * The page before the one whose oldest turn is `before`. { gone: true } when `before` is not this thread's oldest
   * loaded turn any more (the pane asked about an older state; it says so and offers a reopen).
   */
  async pageBefore(threadId, before, { limit = PAGE, all = false } = {}) {
    const st = this.threads.get(threadId);
    if (!st || st.loaded[0]?.id !== before) return { gone: true, total: st?.messageCount ?? 0 };
    const fresh = await this.fill(st, all ? Number.MAX_SAFE_INTEGER : limit, all ? ALL_TURNS_MAX : PAGE_TURNS_MAX);
    st.loaded = [...fresh, ...st.loaded];
    const messages = turnsToMessages(fresh);
    st.messageCount += messages.length;
    return this.pageOf(st, messages);
  }
}
