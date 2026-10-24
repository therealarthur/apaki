/** Local Kimi files only, with exclusions and no symbolic links. */
import fs from 'node:fs';
import path from 'node:path';

/** Arthur's exclusions also apply to the metadata paths we are willing to open. */
export function kimiExcluded(raw) {
  const s = String(raw || '').replaceAll('\\', '/').toLowerCase();
  return /signalsentry|signalsecure|signal-secure|pantex|soc-usa/.test(s)
    || /(?:^|\/)user_[^/]*\.md(?:\/|$)/.test(s)
    || /(?:^|\/)users\/[^/]+\/(?:documents\/chatgpt|desktop\/desktop\/work|pictures)(?:\/|$)/.test(s);
}

export async function kimiRegular(file, root) {
  if (typeof file !== 'string' || typeof root !== 'string' || kimiExcluded(file)) return null;
  const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  let part = root;
  for (const bit of ['', ...rel.split(path.sep)]) {
    if (bit) part = path.join(part, bit);
    const st = await fs.promises.lstat(part).catch(() => null);
    if (!st || st.isSymbolicLink()) return null;
    if (part === file) return st.isFile() ? st : null;
  }
  return null;
}
/** Validate again after opening so a replaced file cannot redirect this read. */
export async function openKimiFile(file, root) {
  const before = await kimiRegular(file, root);
  if (!before) throw new Error('The Kimi journal is missing, excluded, or linked.');
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    const after = await kimiRegular(file, root);
    if (!after || !stat.isFile() || stat.dev !== after.dev || stat.ino !== after.ino
      || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('The Kimi journal changed while opening it.');
    return { handle, stat };
  } catch (error) { await handle.close(); throw error; }
}
