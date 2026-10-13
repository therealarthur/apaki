/**
 * notices.js: what Claude Code shows its users that is not Claude's reply
 * (Arthur, 2026-10-11: "make sure that apaki shows ALL output that would
 * normally be seen by claude code users (including the yellow text that
 * happens when a prompt gets caught/etc) - show it in a similarly different
 * text so users know its not regular response").
 *
 * The Agent SDK sends these as their own messages, and Apaki used to drop
 * them: a prompt a hook blocked ("UserPromptSubmit operation blocked by
 * hook", a system 'informational' at level warning, measured 2026-10-11),
 * hook errors and hook warnings (systemMessage), API retries, usage limit
 * warnings, permission denials, slash command output, model fallbacks,
 * compaction failures, recalled memories, and text the harness adds to the
 * conversation (Stop hook feedback, local command output).
 *
 * noticeFor(msg, seen) turns one SDK message into
 *   { text, tone: 'warn' | 'error' | 'info' | 'dim', label, mono }
 * or null (not a notice, or nothing a Claude Code user would see). The pane
 * draws it as a system line (pane.js sysline), never as Claude's words.
 * Pure and browser safe: the window, the phone page and the tests share it.
 */

/** Hook events Claude Code names in its own messages, for the label. */
const HOOK_WORDS = /\b(PreToolUse|PostToolUse|PostToolUseFailure|UserPromptSubmit|Stop|SubagentStop|SessionStart|SessionEnd|Notification|PreCompact|PermissionRequest)\b.*\bhook\b/i;

/** The limit names Claude Code uses, for rate limit warnings. */
const LIMIT_NAMES = { five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'weekly Opus', seven_day_sonnet: 'weekly Sonnet', seven_day_overage_included: 'weekly', overage: 'extra usage' };

const clean = (s) => String(s ?? '').replace(/\r\n/g, '\n').trim();

/** A hook's JSON output, when its stdout is JSON (hooks answer { decision, reason, systemMessage, ... }). */
function hookJson(msg) {
  const out = clean(msg.stdout || msg.output);
  if (!out.startsWith('{')) return null;
  try { return JSON.parse(out); } catch { return null; }
}

/**
 * True for a hook event a Claude Code user would see: an error, a cancel, a
 * nonzero exit, anything on stderr, or a systemMessage. hook_started,
 * hook_progress and a quiet success are not shown (Claude Code shows them
 * only in its transcript view), so the runner can drop them early.
 */
export function hookWorthShowing(msg) {
  if (msg?.type !== 'system') return false;
  if (msg.subtype !== 'hook_response') return false;
  if (msg.outcome === 'error' || msg.outcome === 'cancelled') return true;
  if (Number.isFinite(msg.exit_code) && msg.exit_code !== 0) return true;
  if (clean(msg.stderr)) return true;
  return Boolean(clean(hookJson(msg)?.systemMessage));
}

/** Local time of an epoch (seconds or milliseconds), for "resets at". */
function when(t) {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n < 1e12 ? n * 1000 : n);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/** Text the harness put in a user message: tags it wraps output in come off. */
function harnessText(msg) {
  const c = msg.message?.content;
  const parts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text) : [];
  return clean(parts.join('\n'));
}

/**
 * One SDK message as a notice, or null. `seen` (a Map the pane keeps) stops a
 * repeated usage warning from showing on every turn.
 */
export function noticeFor(msg, seen = new Map()) {
  if (!msg || msg.parent_tool_use_id) return null;
  if (msg.type === 'rate_limit_event') {
    const r = msg.rate_limit_info || {};
    if (r.status !== 'allowed_warning' && r.status !== 'rejected') return null;
    const name = LIMIT_NAMES[r.rateLimitType] || 'usage';
    const key = `${r.status}:${r.rateLimitType}:${r.resetsAt || ''}`;
    if (seen.get('rate') === key) return null;
    seen.set('rate', key);
    const resets = when(r.resetsAt) ? ` It resets ${when(r.resetsAt)}.` : '';
    if (r.status === 'rejected') return { text: `You have reached your ${name} limit.${resets}`, tone: 'error', label: 'Limit' };
    const u = Number(r.utilization);
    const pct = Number.isFinite(u) ? Math.round(u > 1 ? u : u * 100) : null;
    return { text: `${pct != null ? `You have used ${pct}% of your ${name} limit.` : `You are close to your ${name} limit.`}${resets}`, tone: 'warn', label: 'Limit' };
  }
  if (msg.type === 'user') {
    if (msg.isReplay || msg.origin?.kind === 'task-notification') return null;
    const text = harnessText(msg);
    if (!text) return null;
    const out = text.match(/<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/);
    if (out) return clean(out[2]) ? { text: clean(out[2]), tone: out[1] === 'stderr' ? 'error' : 'dim', label: '', mono: true } : null;
    if (/^(Stop|SubagentStop) hook feedback:/i.test(text) || /hook (feedback|blocking error)/i.test(text.slice(0, 200))) return { text, tone: 'warn', label: 'Hook' };
    if (!msg.isSynthetic) return null;
    // Other text the harness adds: shown quietly, without its tags.
    const plain = clean(text.replace(/<\/?[a-z][\w-]*(?:\s[^>]*)?>/gi, ''));
    return plain ? { text: plain, tone: 'dim', label: '' } : null;
  }
  if (msg.type !== 'system') return null;
  switch (msg.subtype) {
    case 'informational': {
      const text = clean(msg.content);
      if (!text) return null;
      const tone = msg.level === 'warning' ? 'warn' : msg.level === 'info' ? 'dim' : 'info';
      return { text, tone, label: HOOK_WORDS.test(text.split('\n')[0]) ? 'Hook' : '' };
    }
    case 'hook_response': {
      if (!hookWorthShowing(msg)) return null;
      const j = hookJson(msg);
      const name = msg.hook_name || msg.hook_event || 'Hook';
      if (j?.systemMessage && msg.outcome === 'success' && !(msg.exit_code > 0)) return { text: clean(j.systemMessage), tone: 'warn', label: 'Hook' };
      const why = clean(msg.stderr) || clean(j?.reason) || clean(msg.output) || clean(msg.stdout);
      const what = msg.outcome === 'cancelled' ? 'was cancelled' : Number(msg.exit_code) === 2 ? 'blocked this' : 'failed';
      const code = Number.isFinite(msg.exit_code) && msg.exit_code !== 0 && msg.exit_code !== 2 ? ` (exit ${msg.exit_code})` : '';
      return { text: `${name} hook ${what}${code}${why ? `: ${why}` : ''}`, tone: msg.outcome === 'error' && Number(msg.exit_code) !== 2 ? 'error' : 'warn', label: 'Hook' };
    }
    case 'api_retry': {
      const err = typeof msg.error === 'string' ? msg.error : msg.error?.message || msg.error?.type || '';
      const status = msg.error_status ? ` ${msg.error_status}` : '';
      const secs = Math.max(1, Math.round((Number(msg.retry_delay_ms) || 0) / 1000));
      const of = msg.max_retries ? ` of ${msg.max_retries}` : '';
      const stalled = msg.no_response ? `No response after ${Math.round((msg.no_response.waited_ms || 0) / 1000)} s. ` : '';
      return { text: `${stalled}API error${status}${err ? ` (${String(err).replace(/_/g, ' ')})` : ''}. Retrying in ${secs} s, attempt ${msg.attempt}${of}.`, tone: 'warn', label: 'API' };
    }
    case 'notification': {
      const text = clean(msg.text);
      if (!text) return null;
      const key = `n:${msg.key}:${text}`;
      if (seen.get(key)) return null;
      seen.set(key, true);
      return { text, tone: msg.priority === 'high' || msg.priority === 'immediate' ? 'warn' : 'info', label: '' };
    }
    case 'permission_denied': {
      const why = clean(msg.message) || clean(msg.decision_reason);
      return { text: `${msg.tool_name || 'A tool'} was not allowed${why ? `: ${why}` : '.'}`, tone: 'warn', label: 'Permission' };
    }
    case 'local_command_output': {
      const text = clean(msg.content);
      return text ? { text, tone: 'dim', label: '', mono: true } : null;
    }
    case 'model_refusal_fallback':
    case 'model_refusal_no_fallback': {
      const text = clean(msg.content) || (msg.fallback_model ? `Switched from ${msg.original_model} to ${msg.fallback_model}.` : `${msg.original_model} declined this request.`);
      return { text, tone: 'warn', label: 'Model' };
    }
    case 'status':
      if (msg.compact_result === 'failed') return { text: `Compacting failed${msg.compact_error ? `: ${clean(msg.compact_error)}` : '.'}`, tone: 'error', label: '' };
      return null;
    case 'memory_recall': {
      const n = (msg.memories || []).length;
      if (!n) return null;
      const names = (msg.memories || []).slice(0, 4).map((m) => String(m.path || '').split(/[\\/]/).pop()).filter(Boolean).join(', ');
      return { text: `Recalled ${n} ${n === 1 ? 'memory' : 'memories'}${names ? `: ${names}${n > 4 ? ', ...' : ''}` : ''}`, tone: 'dim', label: '' };
    }
    case 'mirror_error':
      return { text: clean(msg.error) || 'Could not save a copy of this conversation.', tone: 'error', label: '' };
    default:
      return null;
  }
}
