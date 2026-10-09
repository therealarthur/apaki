/**
 * ui/app.js
 *
 * latch's full-screen app: the session picker, then the chat screen (Claude
 * Code's layout over the Agent SDK). /resume inside a chat goes back to the
 * picker; picking another session swaps the Claude Code process and lock.
 */

import { render } from 'ink';
import { useState } from 'react';
import { childEnv } from '../auth.js';
import { SessionRunner } from '../runner.js';
import { releaseLock, takeLock } from '../sessions.js';
import { Chat, ChatStore } from './chat.js';
import { h } from './components.js';
import { PickerScreen, makeLoader } from './picker.js';

const CLEAR = '\x1b[2J\x1b[3J\x1b[H';

// The SDK warns that canUseTool is unused in bypassPermissions mode. latch
// keeps the callback on purpose (it is used after Shift+Tab, and questions go
// through a hook), and a stray warning would print over the full-screen UI.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const code = typeof rest[0] === 'object' ? rest[0]?.code : rest[1];
  if (code === 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' || /canUseTool will not be invoked/.test(String(warning))) return;
  emitWarning(warning, ...rest);
};

/**
 * Starts the app. Resolves when the user exits, with the last session id.
 * @param {object} o
 * @param {string|null} o.sessionId   open this session directly (null + o.newSession for a new one)
 * @param {boolean} o.newSession
 * @param {string} o.query            initial picker search
 * @param {object} o.credential       { name, key, source }
 * @param {Array} o.keys              billing choices for /key: [{label, description, value}]
 * @param {Function} o.switchKey      (value) => { name, env } | { error }
 * @param {string} o.cwd             folder for the session opened directly
 * @param {string} o.cwdOverride     folder that always wins (--cwd)
 * @param {string} o.model @param {string} o.effort @param {string} o.permissionMode
 * @param {boolean} o.force           take over a session another latch holds
 * @param {Function} o.onStderr
 */
export function runApp(o) {
  return new Promise((resolveExit) => {
    let runner = null;
    let store = null;
    let lockedId = null;
    let app = null;
    let exiting = false;

    const release = () => { if (lockedId) releaseLock(lockedId); lockedId = null; };

    async function closeChat() {
      if (!runner) return;
      const r = runner;
      runner = null;
      store = null;
      await r.stop();
      release();
    }

    async function exit() {
      if (exiting) return;
      exiting = true;
      const last = runner?.sessionId || lockedId;
      await closeChat();
      app?.unmount();
      resolveExit(last || null);
    }

    /** Builds the chat for a session id (null = new session). Returns an error string or null. */
    function openChat(sessionId, cwd) {
      if (sessionId) {
        const holder = takeLock(sessionId, { force: o.force });
        if (holder) return `Another latch (pid ${holder}) is attached to that session. Start latch with --force to take it over.`;
        lockedId = sessionId;
      }
      const info = {
        credentialName: o.credential.name,
        keys: o.keys,
        switchKey: o.switchKey,
      };
      runner = new SessionRunner({
        sessionId,
        cwd: o.cwdOverride || cwd || process.cwd(),
        env: childEnv(o.credential.key),
        model: o.model,
        effort: o.effort,
        permissionMode: o.permissionMode,
        canUseTool: null,
        onMessage: () => {},
        onStderr: o.onStderr,
      });
      store = new ChatStore({
        runner,
        info,
        onResume: (query) => { setScreen({ name: 'picker', query, message: '' }); },
        onExit: exit,
      });
      // Keep the credential for the next session the user opens.
      const switchKey = info.switchKey;
      info.switchKey = (value) => {
        const next = switchKey(value);
        if (!next.error) o.credential = { ...o.credential, name: next.name, key: next.key ?? null };
        return next;
      };
      runner.start();
      return null;
    }

    let setScreen = () => {};

    function App({ initial }) {
      const [screen, set] = useState(initial);
      setScreen = (next) => {
        if (next.name === 'picker') process.stdout.write(CLEAR);
        set(next);
      };
      if (screen.name === 'picker') {
        return h`<${PickerScreen}
          loader=${loader} initialQuery=${screen.query || ''} billing=${`billing: ${o.credential.name}`}
          message=${screen.message}
          onQuit=${() => (store ? setScreen({ name: 'chat', store }) : exit())}
          onPick=${async (item) => {
    if (store && runner?.sessionId === item.id) { setScreen({ name: 'chat', store }); return; }
    await closeChat();
    const err = openChat(item.id, item.cwd);
    if (err) { setScreen({ name: 'picker', query: screen.query, message: err }); return; }
    process.stdout.write(CLEAR);
    set({ name: 'chat', store });
  }} />`;
      }
      return h`<${Chat} key=${screen.store.runner.sessionId || 'new'} store=${screen.store} />`;
    }

    const loader = makeLoader();
    let initial;
    if (o.sessionId || o.newSession) {
      const err = openChat(o.sessionId || null, o.cwd);
      if (err) { resolveExit(null); throw new Error(err); }
      initial = { name: 'chat', store };
    } else {
      initial = { name: 'picker', query: o.query || '', message: '' };
    }
    process.stdout.write(CLEAR);
    app = render(h`<${App} initial=${initial} />`, { exitOnCtrlC: false, patchConsole: false });
    process.on('exit', release);
  });
}
