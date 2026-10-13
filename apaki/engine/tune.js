/**
 * tune.js: the settings that sit beside a pane's effort, turned into what each side takes. Pure functions, no I/O, so the
 * rules are tested on their own (test/apaki-tune.test.js). Added 2026-10-13 (Arthur: "we also want a way to have ultracode
 * toggleable (and the equivalent for codex) in/near the effort level").
 *
 * Claude Code panes: { ultracode: boolean, size: 'small' | 'medium' | 'large' | 'unrestricted' | null }.
 *   ultracode  standing dynamic-workflow orchestration at any effort level (the Agent SDK's `ultracode` setting). Session
 *              scoped: Claude Code never persists it, so Apaki passes it to the process it starts (startSettings) and to a
 *              running one through the SDK's applyFlagSettings (liveSettings). No settings file is ever written.
 *   size       the advisory size of the workflows it writes (`workflowSizeGuideline`); null leaves Claude Code's own default
 *              (medium, small on Pro). Only sent while ultracode is on, so an Apaki pane that never uses Ultracode starts
 *              exactly as before.
 * The SDK rule this file honours (measured 2026-10-13 against the bundled Claude Code, getSettings().applied): an
 * effortLevel that moves the session to a different level, sent without an `ultracode` key, turns ultracode OFF; so every
 * effort change sends both keys (liveSettings).
 *
 * Codex panes: { summary: 'auto' | 'concise' | 'detailed' | 'none' | null, speed: 'default' | <service tier id> | null }.
 *   Codex has no Ultracode switch. Its closest thing is the `ultra` reasoning effort a model may advertise ("Maximum
 *   reasoning with automatic task delegation"; the app-server schema marks multiAgentMode "Ignored. Use effort ultra"), which
 *   is already one of the model's own efforts. What turn/start takes besides effort is `summary` (reasoning summary) and
 *   `serviceTier` (speed: "default" is standard, the model's serviceTiers list the faster ones). Both ride with the turn
 *   (codexTurnFields); ~/.codex/config.toml is never written. null means the person never picked: the turn sends nothing.
 */

export const WORKFLOW_SIZES = Object.freeze(['small', 'medium', 'large', 'unrestricted']);
export const SUMMARIES = Object.freeze(['auto', 'concise', 'detailed', 'none']);
/** A Codex service tier id as a pane may carry it (the app-server's own ids are short lowercase words). */
export const SPEED_RE = /^[a-z][a-z0-9_-]{0,23}$/;

/** One of WORKFLOW_SIZES, else null (Claude Code's own default). */
export function normalizeSize(v) {
  return WORKFLOW_SIZES.includes(v) ? v : null;
}

/** A Claude pane's tune: ultracode is true only when it is exactly true; the size is a known one or null. */
export function claudeTune(t) {
  const o = t && typeof t === 'object' ? t : {};
  return { ultracode: o.ultracode === true, size: normalizeSize(o.size) };
}

/**
 * The tune after a change. Only the keys the change names move: { ultracode: true } keeps the size, { size: 'large' } keeps
 * ultracode, { size: null } goes back to Claude Code's default size.
 */
export function claudeChange(prev, change) {
  const next = claudeTune(prev);
  const c = change && typeof change === 'object' ? change : {};
  if ('ultracode' in c) next.ultracode = c.ultracode === true;
  if ('size' in c) next.size = normalizeSize(c.size);
  return next;
}

/**
 * Settings handed to a Claude Code process as it starts (the SDK's `settings` option, the claude --settings layer). Nothing
 * for a pane that does not use Ultracode, so such a process starts exactly as before.
 *   restricted  the pane belongs to a phone below Full access (remote-policy.js). Workflows run sub-agents whose tool use
 *               the phone's tool limits (disallowedTools, the capability hook) have not been shown to cover, and there is
 *               a second way in, the "ultracode" keyword in a prompt, so such a pane gets no workflows at all.
 *               Measured: disableWorkflows makes getSettings().applied.ultracodeAvailable false.
 */
export function startSettings(tune, { restricted = false } = {}) {
  if (restricted) return { ultracode: false, disableWorkflows: true, workflowKeywordTriggerEnabled: false };
  const t = claudeTune(tune);
  if (!t.ultracode) return {};
  return { ultracode: true, ...(t.size ? { workflowSizeGuideline: t.size } : {}) };
}

/**
 * What to send a running process (query.applyFlagSettings) to go from `prev` to `next`, each { effort, ultracode, size }.
 * Empty when nothing it understands moved.
 *   effort moved    effortLevel AND ultracode, always both (the SDK turns ultracode off on a bare effort change)
 *   only ultracode  ultracode alone (it leaves the effort alone)
 *   size            while ultracode is on; going off clears the size (null falls back to Claude Code's own default)
 */
export function liveSettings(prev, next) {
  const p = { effort: prev?.effort || null, ...claudeTune(prev) };
  const n = { effort: next?.effort || null, ...claudeTune(next) };
  const out = {};
  const effortMoved = Boolean(n.effort) && n.effort !== p.effort;
  const ultracodeMoved = n.ultracode !== p.ultracode;
  const sizeMoved = n.size !== p.size;
  if (effortMoved) { out.effortLevel = n.effort; out.ultracode = n.ultracode; } else if (ultracodeMoved) out.ultracode = n.ultracode;
  if (n.ultracode && (ultracodeMoved || sizeMoved)) out.workflowSizeGuideline = n.size;
  else if (ultracodeMoved && !n.ultracode) out.workflowSizeGuideline = null;
  return out;
}

/** A Codex pane's tune: a known summary and a service tier id, else null for each. */
export function codexTune(t) {
  const o = t && typeof t === 'object' ? t : {};
  return {
    summary: SUMMARIES.includes(o.summary) ? o.summary : null,
    speed: typeof o.speed === 'string' && SPEED_RE.test(o.speed) ? o.speed : null,
  };
}

/** The Codex tune after a change (only the keys the change names move; null puts a key back to "never picked"). */
export function codexChange(prev, change) {
  const next = codexTune(prev);
  const c = change && typeof change === 'object' ? change : {};
  if ('summary' in c) next.summary = codexTune({ summary: c.summary }).summary;
  if ('speed' in c) next.speed = codexTune({ speed: c.speed }).speed;
  return next;
}

/**
 * The turn/start fields for a Codex tune. `model` is the engine's row for the pane's model ({ serviceTiers: [{ id, ... }] }):
 * a speed the model does not offer is left out (a model change can take a tier away), "default" (standard) always goes.
 */
export function codexTurnFields(tune, model) {
  const t = codexTune(tune);
  const out = {};
  if (t.summary) out.summary = t.summary;
  if (t.speed && (t.speed === 'default' || (model?.serviceTiers || []).some((s) => s.id === t.speed))) out.serviceTier = t.speed;
  return out;
}
