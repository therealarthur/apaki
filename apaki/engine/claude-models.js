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
    out.push({ id, name: String(m.displayName || id), description: String(m.description || '') });
  }
  return out;
}
