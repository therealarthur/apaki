/** Glass status projection and provider settings transport. No local preference is stored. */
import { validProviderId } from '../ui/glass-providers.js';

const GLASS_LITE_NOTE = 'Myrlin Workbook is not installed, so Glass works with the live Claude and Codex logins and your API keys. Keeping several Claude and Codex subscription logins and switching between them is Workbook\'s job.';

const accountName = (a) => a?.label || (a?.email ? String(a.email).split('@')[0] : '') || 'Account';

/**
 * One Glass account for the footer and its menu. An API-credit entry is
 * marked isKey and its plan reads "API key" (Arthur, 2026-10-09: it must be
 * apparent when Claude bills a key, not a subscription).
 */
export function glassAccount(a) {
  if (!a) return null;
  const isKey = /api credits/i.test(a.plan || '');
  const windows = (a.windows || [])
    .map((w) => ({ label: w.label, percent: Math.round(w.percent ?? 0), resetsAt: w.resetsAt || null, seconds: Number(w.windowSeconds) || null }));
  return {
    id: a.id, name: accountName(a), plan: isKey ? 'API key' : (a.plan || ''), isKey, state: a.state || 'ok',
    headroom: a.headroom == null ? null : Math.round(a.headroom), detail: a.stateDetail || '', windows, active: Boolean(a.active),
    leftUsd: a.apiCredit?.leftUsd ?? null,
    // 2026-10-10, for the Glass panel: hidden by the user (glass hide), and what rename and reconnect start from.
    hidden: Boolean(a.hidden), label: a.label || '', email: a.email || '',
  };
}

/** The live account and the swappable list for each provider, from glassStatus(). */
export function glassView(st) {
  if (!st) return null;
  const acc = st.accounts || [];
  const live = (p) => glassAccount(acc.find((a) => a.provider === p && a.active));
  const claude = live('claude');
  // A key's dollars live on its API-credit entry, not on the account Glass made for it.
  const credit = claude?.isKey ? (st.apiCredits || []).find((c) => c.id === claude.id) || (st.apiCredits || []).find((c) => c.active) : null;
  if (credit) Object.assign(claude, { leftUsd: credit.leftUsd ?? null, creditUsd: credit.creditUsd ?? null, detail: credit.orgName || claude.detail });
  // Subscriptions come from the accounts; every API-credit org is offered as a key.
  const subs = acc.filter((a) => a.provider === 'claude' && !/api credits/i.test(a.plan || '')).map(glassAccount);
  const keys = (st.apiCredits || []).map((c) => ({
    id: c.id, name: c.label, plan: 'API key', isKey: true, state: c.keyStatus === 'active' ? 'ok' : (c.keyStatus || 'unknown'),
    headroom: c.creditUsd ? Math.round((100 * (c.leftUsd ?? 0)) / c.creditUsd) : null, leftUsd: c.leftUsd ?? null, creditUsd: c.creditUsd ?? null, windows: [],
    active: Boolean(c.active) || Boolean(claude?.isKey && claude.id === c.id), detail: c.orgName || '',
    label: c.label, hidden: false, keyHint: c.usageKeyHint || c.adminKeyHint || '', spentUsd: c.spentUsd ?? null, error: c.error || '',
  }));
  return {
    claude, codex: live('codex'), kimi: live('kimi'),
    lists: { claude: [...keys, ...subs], codex: acc.filter((a) => a.provider === 'codex').map(glassAccount), kimi: acc.filter((a) => a.provider === 'kimi').map(glassAccount) },
    visibleProviders: st.visibleProviders ?? null, knownProviders: st.knownProviders ?? null,
    // 2026-10-10: how Glass runs here. lite = no Myrlin Workbook on this PC: Glass shows the live
    // logins and API-credit entries and switches between the live login and API keys; keeping
    // several subscription logins is Workbook's job (the panel says so).
    mode: {
      lite: Boolean(st.workbook?.lite), swapsEnabled: Boolean(st.swapsEnabled),
      swapsReason: st.swapsDisabledReason || null, signInReason: st.signInDisabledReason || null,
      note: st.workbook?.lite ? GLASS_LITE_NOTE : null,
    },
  };
}

/** A read or one provider delta. Glass retains unknown ids and serializes persistence. */
export function providerSettingsArgs(c = {}) {
  const prefix = String.fromCharCode(45, 45);
  if (c.provider === undefined && c.visible === undefined) return ['settings', 'providers', prefix + 'json'];
  if (!validProviderId(c.provider) || typeof c.visible !== 'boolean') throw new Error('Choose a provider and whether to show it.');
  return ['settings', 'providers', prefix + (c.visible ? 'show' : 'hide'), c.provider, prefix + 'json'];
}

export function readProviderSettings(out) {
  const ids = (v) => Array.isArray(v) && v.every(validProviderId);
  if (!out || !(out.visibleProviders === null || ids(out.visibleProviders)) || !ids(out.knownProviders)) {
    throw new Error('Glass did not return provider settings. Update Glass to use this setting.');
  }
  return { visibleProviders: out.visibleProviders === null ? null : [...new Set(out.visibleProviders)], knownProviders: [...new Set(out.knownProviders)] };
}

export function glassProviderSettings(cli, c, execFile) {
  const args = providerSettingsArgs(c);
  return new Promise((resolve, reject) => {
    execFile(cli, args, { timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      let out;
      try { out = JSON.parse(stdout); } catch { out = null; }
      if (err || out?.error) {
        reject(new Error(String(out?.message || out?.error || stderr || err?.message || 'Glass could not save provider settings.').trim().split('\n')[0].slice(0, 300)));
        return;
      }
      try { resolve(readProviderSettings(out)); } catch (error) { reject(error); }
    });
  });
}
