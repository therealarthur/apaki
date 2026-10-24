/** Glass owns the preference. These helpers only interpret its latest response. */
export const PROVIDER_NAMES = Object.freeze({ claude: 'Claude', codex: 'Codex', kimi: 'Kimi' });
export const KIMI_LOGIN_HINT = 'Open the Kimi CLI on this computer and run /login. Glass captures the new login automatically.';
export const validProviderId = (id) => typeof id === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(id);
export const providerVisible = (data, id) => !Array.isArray(data?.visibleProviders) || data.visibleProviders.includes(id);

/** Include future ids already in the allowlist, even if this client cannot draw their accounts yet. */
export function providerChoices(data) {
  const known = Array.isArray(data?.knownProviders) ? data.knownProviders : Object.keys(PROVIDER_NAMES);
  return [...new Set([...known, ...(data?.visibleProviders || [])])].filter(validProviderId);
}

/** Old Glass has no Kimi provider. Do not add an empty row until Glass knows it or returns an account. */
export function displayProviders(data) {
  return Object.keys(PROVIDER_NAMES).filter((id) => providerVisible(data, id)
    && (id !== 'kimi' || data?.knownProviders?.includes(id) || data?.[id] || data?.lists?.[id]?.length));
}
