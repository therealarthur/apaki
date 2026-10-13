/**
 * tune.js: what the effort popup holds beyond the effort levels (Arthur, 2026-10-13: "we also want a way to have ultracode
 * toggleable (and the equivalent for codex) in/near the effort level"). Pure: it builds the popup's rows from a pane's state
 * and says what a pick means, so the window, the phone page and the tests all read the same thing (menu.js draws the rows).
 *
 * A Claude pane's popup: the five efforts (Max included), then Ultracode as an on/off row with one line of explanation and,
 * while it is on, the size of the workflows Claude writes (Small, Medium, Large, No limit). On a phone below Full access the
 * Ultracode row is dimmed and the line says why (the PC refuses it; engine/remote-policy.js capTuneText).
 *
 * A Codex pane's popup: that model's own efforts (Ultra, where a model offers it, is Codex's Ultracode: maximum reasoning
 * with automatic task delegation; there is no separate switch, and the popup says so), then the reasoning summary and,
 * for a model that lists faster tiers, the speed. Nothing here writes ~/.codex/config.toml: the choices ride with the turn.
 *
 * The tune object a pane holds: Claude { ultracode: boolean, size: string | null }, Codex { summary: string | null,
 * speed: string | null } (null: never picked, so the engine sends nothing). The engine keeps the same shapes (engine/tune.js).
 */

import { EFFORTS, effortGrid } from './menu.js';
import { esc } from './markdown.js';

export const EFFORT_HINTS = { low: 'Fastest, least thinking', medium: 'Balanced', high: 'Thinks harder', xhigh: 'Thinks much harder', max: 'Everything it has' };

/** The sizes of the workflows Ultracode may write (Claude Code's workflowSizeGuideline); null is Claude Code's own default. */
export const WORKFLOW_SIZES = [
  { value: 'small', label: 'Small', hint: 'Aims for fewer than 5 agents' },
  { value: 'medium', label: 'Medium', hint: 'Aims for fewer than 10 agents' },
  { value: 'large', label: 'Large', hint: 'Aims for fewer than 50 agents' },
  { value: 'unrestricted', label: 'No limit', hint: 'No size guideline' },
];

/** The reasoning summary choices Codex takes, in the popup's order. */
export const SUMMARIES = [
  { value: 'auto', label: 'Auto', hint: 'Codex decides how much to write out' },
  { value: 'concise', label: 'Short', hint: 'A brief summary of its thinking' },
  { value: 'detailed', label: 'Detailed', hint: 'A fuller summary of its thinking' },
  { value: 'none', label: 'Off', hint: 'No summary of its thinking' },
];

export const ULTRACODE_LINE = 'Claude runs sub-agent workflows by itself. Uses much more.';
export const DEFAULT_SIZE_LINE = 'Size is Claude Code\'s own default: Medium, Small on a Pro plan.';
export const UNAVAILABLE_LINE = 'This model cannot run Ultracode here, so it waits. A model that can picks it up again.';
export const CODEX_ULTRA_LINE = 'Codex has no Ultracode switch. Ultra above is its version.';
export const CODEX_NO_ULTRA_LINE = 'Codex has no Ultracode switch. Its version is Ultra, which this model lacks.';

/** Pick values the popup hands back (a plain effort comes back as the effort's own word). */
export const PICK_ULTRACODE = 'ultracode';
export const PICK_SIZE = 'size:';
export const PICK_SUMMARY = 'summary:';
export const PICK_SPEED = 'speed:';

const SIZES = WORKFLOW_SIZES.map((s) => s.value);
const SUMMARY_VALUES = SUMMARIES.map((s) => s.value);

/** A Claude pane's tune; anything else reads as Ultracode off and Claude Code's default size. */
export function claudeTune(t) {
  const o = t && typeof t === 'object' ? t : {};
  return { ultracode: o.ultracode === true, size: SIZES.includes(o.size) ? o.size : null, ...(o.available === false ? { available: false } : {}) };
}

/** A Codex pane's tune. */
export function codexTune(t) {
  const o = t && typeof t === 'object' ? t : {};
  return {
    summary: SUMMARY_VALUES.includes(o.summary) ? o.summary : null,
    speed: typeof o.speed === 'string' && /^[a-z][a-z0-9_-]{0,23}$/.test(o.speed) ? o.speed : null,
  };
}

/** The tune of a pane of this kind (the shapes differ; a pane that changes kind starts from the new kind's defaults). */
export function tuneFor(kind, t) {
  return kind === 'codex' ? codexTune(t) : claudeTune(t);
}

/** The tune after a change that names only some keys (a null puts a key back to its default). */
export function tuneChange(kind, t, change) {
  const next = tuneFor(kind, t);
  const c = change && typeof change === 'object' ? change : {};
  if (kind === 'codex') {
    if ('summary' in c) next.summary = codexTune({ summary: c.summary }).summary;
    if ('speed' in c) next.speed = codexTune({ speed: c.speed }).speed;
    return next;
  }
  if ('ultracode' in c) next.ultracode = c.ultracode === true;
  if ('size' in c) next.size = claudeTune({ size: c.size }).size;
  if (c.ultracode === false) delete next.available;
  return next;
}

/** Why the Ultracode row is dimmed on a phone below Full access (the PC refuses it too; remote-policy.js capTuneText). */
export function ultracodeLock(cap) {
  if (!cap || cap === 'full') return null;
  return `${cap === 'chat' ? 'Chat only' : cap === 'noshell' ? 'No shell' : 'This access level'} on the PC keeps Ultracode off: it runs sub-agents this phone's limits are not shown to cover.`;
}

/** The effort popup of a Claude pane: { effort, tune, lock } (lock: the text from ultracodeLock, or null). */
export function claudeEffortMenu({ effort, tune, lock = null } = {}) {
  const t = claudeTune(tune);
  const rows = EFFORTS.map((value) => ({ value, html: `${effortGrid(value)}<span class="ml">${value}</span>`, hint: EFFORT_HINTS[value], checked: value === effort }));
  rows.push({ divider: true });
  rows.push({ value: PICK_ULTRACODE, html: '<span class="ml">Ultracode</span>', hint: t.ultracode ? '' : 'Off', checked: t.ultracode && !lock, keep: true, disabled: lock || false });
  rows.push({ note: lock || (t.ultracode && t.available === false ? UNAVAILABLE_LINE : ULTRACODE_LINE) });
  if (t.ultracode && !lock) {
    rows.push({ label: 'Workflow size', seg: WORKFLOW_SIZES.map((s) => ({ value: PICK_SIZE + s.value, label: s.label, hint: s.hint, checked: t.size === s.value })) });
    rows.push({ note: t.size ? `${WORKFLOW_SIZES.find((s) => s.value === t.size).hint}. Pick it again for the default.` : DEFAULT_SIZE_LINE });
  }
  return rows;
}

/** What a pick in a Claude pane's popup means: { effort } or { tune: { ultracode } } or { tune: { size } }. */
export function claudePick(value, tune) {
  const t = claudeTune(tune);
  if (value === PICK_ULTRACODE) return { tune: { ultracode: !t.ultracode } };
  if (typeof value === 'string' && value.startsWith(PICK_SIZE)) {
    const size = value.slice(PICK_SIZE.length);
    if (!SIZES.includes(size)) return null;
    return { tune: { size: t.size === size ? null : size } };
  }
  return EFFORTS.includes(value) ? { effort: value } : null;
}

/** The speeds a Codex model offers: standard first, then the tiers it lists ([{ id, name, description }]). */
export function speedChoices(model) {
  return [{ value: 'default', label: 'Standard', hint: 'The usual speed and usage' }, ...(model?.serviceTiers || []).map((t) => ({ value: t.id, label: t.name || t.id, hint: t.description || '' }))];
}

/**
 * The effort popup of a Codex pane: { model (the engine's row for the pane's model), effort, tune, defaults } (defaults: the
 * speed Codex starts with from the user's own config, so an unpicked row shows what really applies).
 */
export function codexEffortMenu({ model, effort, tune, defaults = null } = {}) {
  const t = codexTune(tune);
  const levels = (model?.efforts || []).map((e) => e.value);
  const rows = (model?.efforts || []).map((e) => ({ value: e.value, html: `${effortGrid(e.value, { levels })}<span class="ml">${esc(e.value)}</span>`, hint: e.description, checked: e.value === effort }));
  rows.push({ divider: true });
  rows.push({ label: 'Reasoning summary', seg: SUMMARIES.map((s) => ({ value: PICK_SUMMARY + s.value, label: s.label, hint: s.hint, checked: (t.summary || 'auto') === s.value })) });
  const speeds = speedChoices(model);
  if (speeds.length > 1) {
    const now = t.speed || (speeds.some((s) => s.value === defaults?.speed) ? defaults.speed : 'default');
    rows.push({ label: 'Speed', seg: speeds.map((s) => ({ value: PICK_SPEED + s.value, label: s.label, hint: s.hint, checked: now === s.value })) });
    const chosen = speeds.find((s) => s.value === now);
    if (chosen?.hint) rows.push({ note: chosen.hint });
  }
  rows.push({ divider: true });
  rows.push({ note: levels.includes('ultra') ? CODEX_ULTRA_LINE : CODEX_NO_ULTRA_LINE });
  return rows;
}

/** What a pick in a Codex pane's popup means: { effort } or { tune: { summary } } or { tune: { speed } }. */
export function codexPick(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith(PICK_SUMMARY)) { const v = value.slice(PICK_SUMMARY.length); return SUMMARY_VALUES.includes(v) ? { tune: { summary: v } } : null; }
  if (value.startsWith(PICK_SPEED)) { const v = value.slice(PICK_SPEED.length); return /^[a-z][a-z0-9_-]{0,23}$/.test(v) ? { tune: { speed: v } } : null; }
  return value ? { effort: value } : null;
}

/**
 * The quiet word after the effort on the chip: "+ ultracode" (a Claude pane with it on; "+ ultra" in a narrow box) or the name
 * of a faster Codex speed ("+ fast"). Null when there is nothing to say. Not a status pill: just two more lowercase words.
 */
export function chipExtra(kind, tune, { model = null } = {}) {
  if (kind === 'codex') {
    const t = codexTune(tune);
    if (!t.speed || t.speed === 'default') return null;
    const name = String((model?.serviceTiers || []).find((s) => s.id === t.speed)?.name || t.speed).toLowerCase();
    return { full: `+ ${name}`, short: `+ ${name}` };
  }
  return claudeTune(tune).ultracode ? { full: '+ ultracode', short: '+ ultra' } : null;
}

/** The chip's tooltip: the effort and, when set, what is on beside it. */
export function chipTitle(kind, effort, tune, { model = null } = {}) {
  const extra = chipExtra(kind, tune, { model });
  if (kind === 'codex') return `Reasoning effort${effort ? `: ${effort}` : ''}${extra ? `, ${extra.full.slice(2)} speed` : ''}`;
  const t = claudeTune(tune);
  return `Effort: ${effort}${t.ultracode ? `, Ultracode on${t.size ? ` (${t.size} workflows)` : ''}${t.available === false ? ', waiting for a model that can run it' : ''}` : ''}`;
}

/** The chip's markup after the effort word. */
export function chipExtraHtml(extra) {
  return extra ? `<span class="uc"><span class="uc-full">${esc(extra.full)}</span><span class="uc-short">${esc(extra.short)}</span></span>` : '';
}
