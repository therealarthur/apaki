/**
 * claude-models.js: Claude Code's model list as the window's model menus use it (2026-11-09).
 *
 * Arthur: "myrlin apaki needs is not picking up fable 5.2". The menus were a fixed list in pane.js; now the engine asks a
 * running Claude Code for supportedModels (engine.js refreshClaudeModels) and turns its rows into menu rows here.
 */

/**
 * Claude Code's ModelInfo rows ({ value, resolvedModel, displayName, description }) as menu rows { id, name, description }:
 * one per model id with aliases resolved ('fable' becomes claude-fable-5-2), the 'default' row left out (another row
 * names the same model), anything that is not a Claude model id dropped. Order kept: Claude Code lists the current
 * models first.
 */
export function claudeModelRows(list) {
  const seen = new Set();
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    const id = String(m?.resolvedModel || m?.value || '');
    if (!/^claude-/.test(id) || m.value === 'default' || seen.has(id)) continue;
    seen.add(id);
    const shown = String(m.displayName || '');
    // A name without its version (some logins' alias rows say just "Opus" or "Fable", 2026-11-16) is made from the id.
    out.push({ id, name: /\d/.test(shown) ? shown : versionedName(id) || shown || id, description: String(m.description || '') });
  }
  return out;
}

/** "claude-opus-5-5" is "Opus 5.5", "claude-haiku-4-5-20251001" is "Haiku 4.5", "claude-sonnet-5" is "Sonnet 5"; else null. */
export function versionedName(id) {
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(String(id || ''));
  if (!m) return null;
  return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}${m[3] ? `.${m[3]}` : ''}${m[4] ? ' (1M)' : ''}`;
}
