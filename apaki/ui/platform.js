/**
 * platform.js: which operating system's words the UI uses (2026-10-13).
 *
 * The Mac shell injects src/mac.js, which sets <html data-platform="mac"> at
 * document start. Everything else (the Windows window, and the phone page,
 * which is this same UI in a phone browser) leaves the flag unset and keeps
 * the Windows / PC wording. The flag is read lazily on every call, never at
 * module load, and a missing `document` (plain Node, tests) counts as not Mac.
 *
 * Exports: isMac(), pc() ('Mac' | 'PC'), explorer() ('Finder' | 'Explorer'),
 * osName() ('macOS' | 'Windows'), badge() ('Dock' | 'taskbar').
 */

/** True when the window runs inside the Mac shell. */
export function isMac() {
  try {
    return globalThis.document?.documentElement?.dataset?.platform === 'mac';
  } catch { return false; }
}

/** The computer the window runs on, as a noun: 'Mac' or 'PC'. */
export const pc = () => (isMac() ? 'Mac' : 'PC');

/** The file manager that "show in folder" opens. */
export const explorer = () => (isMac() ? 'Finder' : 'Explorer');

/** The operating system's name. */
export const osName = () => (isMac() ? 'macOS' : 'Windows');

/** Where the notification count shows: the Dock icon on a Mac, the taskbar button on Windows. */
export const badge = () => (isMac() ? 'Dock' : 'taskbar');
