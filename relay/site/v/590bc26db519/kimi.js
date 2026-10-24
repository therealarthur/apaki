/** Kimi values for the existing chips and rows. No provider-specific layout. */
export const KIMI_MODEL = 'kimi-code/k3.1-pro';
export const KIMI_EFFORT = 'max';
export const isKimiId = (id) => typeof id === 'string' && id.startsWith('kimi:');
export const isKimiRow = (s) => Boolean(s?.kimi || s?.kind === 'kimi' || isKimiId(s?.id));
export const KIMI_MODES = [
  { value: 'default', label: 'Ask permissions', short: 'Ask', mark: '?', hint: 'Kimi asks before tools that require approval' },
  { value: 'plan', label: 'Plan', mark: '◇', hint: 'Kimi planning mode' },
  { value: 'auto', label: 'Auto', mark: '✓', hint: 'Kimi automatically approves safe operations' },
  { value: 'yolo', label: 'Full access', short: 'Full', mark: '!', hint: 'Kimi automatically approves everything' },
];
export function kimiChoices(which, mode = 'default') {
  if (which === 'model') return [{ value: KIMI_MODEL, label: 'Kimi K3.1 Pro', checked: true }];
  if (which === 'effort') return [{ value: KIMI_EFFORT, label: 'Max', checked: true }];
  return KIMI_MODES.map((m) => ({ ...m, checked: m.value === mode }));
}
export const KIMI_LOCAL = [
  { name: 'new', description: 'Start a new conversation' }, { name: 'resume', description: 'Find a conversation' },
  { name: 'model', description: 'Kimi K3.1 Pro' }, { name: 'effort', description: 'Max effort' },
  { name: 'mode', description: 'Kimi permissions' }, { name: 'folder', description: 'Add to an Apaki folder' },
];
