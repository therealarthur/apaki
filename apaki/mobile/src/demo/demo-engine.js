/**
 * demo-engine.js: a pretend PC for the Apaki app's debug demo mode
 * (apaki/mobile, 2026-10-10). Debug builds made with `npm run build:demo`
 * only; a release build never contains this folder (build-app.mjs).
 *
 * It answers the engine commands the phone sends (the ones
 * apaki/engine/remote-policy.js allows: sessions, search, open, attach,
 * send, interrupt, model, effort, mode, commands, close) with events shaped
 * like apaki/engine/engine.js emits, from sample sessions and one sample
 * conversation, so the app can be shown and screenshotted in the Simulator
 * without a PC, a relay or a pairing.
 *
 * createDemoEngine({ now }).handle(cmd) -> [{ delay, ev }]: the events to
 * deliver and how many milliseconds after the command each one comes.
 * Pure: node --test checks it (apaki/mobile/test/demo-engine.test.js).
 */

export const DEMO_PC = 'Studio PC';
const MODEL = 'claude-opus-5-5';
const BILLING = { name: 'Claude Max', source: 'oauth', follow: true, isKey: false };
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The sample list: what a PC with a few weeks of Claude Code work shows. */
function sampleSessions(now) {
  const s = (id, title, ago, cwd, extra = {}) => ({
    id, title, firstPrompt: title, cwd, branch: 'master', lastModified: now - ago, size: 40_000, codex: false,
    terminal: null, folder: null, headless: false, bare: false, warm: false, subagents: 0, ...extra,
  });
  const repo = 'C:\\Users\\Arthur\\Projects\\claude-latch';
  return [
    s('5f0c1b2a-0001-4c1e-9d3a-a1b2c3d4e5f6', 'Pairing that lasts forever on iPhone', 4 * MIN, repo, { warm: true, folder: 'f-apaki' }),
    s('5f0c1b2a-0002-4c1e-9d3a-a1b2c3d4e5f6', 'Relay budget guard and per-IP limits', 2 * HOUR, repo, { folder: 'f-apaki', subagents: 2 }),
    s('5f0c1b2a-0003-4c1e-9d3a-a1b2c3d4e5f6', 'Questions answered once, stale sheets gone', 5 * HOUR, repo, { folder: 'f-apaki' }),
    s('5f0c1b2a-0004-4c1e-9d3a-a1b2c3d4e5f6', 'Search by meaning with GPU embeddings', 1 * DAY, repo),
    s('5f0c1b2a-0005-4c1e-9d3a-a1b2c3d4e5f6', 'Glass panel: manage accounts', 2 * DAY, repo, { terminal: { name: 'Windows Terminal', status: 'idle', pid: 4120 } }),
    s('5f0c1b2a-0006-4c1e-9d3a-a1b2c3d4e5f6', 'Blockymodel export for the sword set', 3 * DAY, 'C:\\Users\\Arthur\\hytale-asset-factory'),
    s('5f0c1b2a-0007-4c1e-9d3a-a1b2c3d4e5f6', 'Net worth import from the brokerage CSV', 5 * DAY, 'C:\\Users\\Arthur\\Projects\\myrlin-lens'),
    s('5f0c1b2a-0008-4c1e-9d3a-a1b2c3d4e5f6', 'Landing page copy pass', 8 * DAY, 'C:\\Users\\Arthur\\Projects\\myrlin-labs'),
  ];
}

const FOLDERS = [{ id: 'f-apaki', name: 'Apaki', sessions: ['5f0c1b2a-0001-4c1e-9d3a-a1b2c3d4e5f6', '5f0c1b2a-0002-4c1e-9d3a-a1b2c3d4e5f6', '5f0c1b2a-0003-4c1e-9d3a-a1b2c3d4e5f6'], createdAt: '2026-10-01T09:00:00.000Z' }];

/** One sample conversation (the first session); the others get a short one. */
function sampleHistory(session, now) {
  const at = (ago) => new Date(now - ago).toISOString();
  if (session.id.endsWith('0001-4c1e-9d3a-a1b2c3d4e5f6')) {
    return [
      { type: 'user', at: at(9 * MIN), message: { content: 'When I pair my phone it should stay paired forever. Where does the phone keep the pairing today?' } },
      { type: 'assistant', at: at(8.8 * MIN), message: { content: [{ type: 'text', text: 'Let me look at the phone client\'s store first.' }, { type: 'tool_use', id: 'toolu_demo_1', name: 'Read', input: { file_path: 'apaki/web/src/store.js' } }] } },
      { type: 'user', at: at(8.7 * MIN), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_demo_1', is_error: false, content: 'const DB_NAME = \'apaki-phone\';\nconst DB_VERSION = 2;\n...' }] } },
      { type: 'assistant', at: at(8.5 * MIN), message: { content: [{ type: 'text', text: 'Today the pairing lives in **IndexedDB**, and the device key is a non-extractable WebCrypto key stored next to it. That is fine in a browser tab, but iOS may clear website data when space runs low, and then the phone has to scan a new code.\n\nIn the app I would move it to places iOS keeps:\n\n1. The device key in the **Secure Enclave**: it never leaves the chip, the protocol only asks it to sign.\n2. The pairing record and its secret in the **Keychain**, readable after the first unlock, on this device only.\n\n```js\nconst device = await store.newDevice(); // a Secure Enclave key in the app\n```\n\nThe PC side does not change at all.' }] } },
      { type: 'user', at: at(4 * MIN), message: { content: 'Do it, and keep the web client working in a browser.' } },
      { type: 'assistant', at: at(3.5 * MIN), message: { content: [{ type: 'text', text: 'Done. The browser still uses IndexedDB; the app swaps in a store backed by the Keychain, and `protocol.js` signs through the device when it has its own `sign()`. Pairing, reconnecting after a restart and forgetting a PC all work the same way.' }] } },
    ];
  }
  return [
    { type: 'user', at: at(30 * MIN), message: { content: session.firstPrompt || session.title } },
    { type: 'assistant', at: at(29 * MIN), message: { content: [{ type: 'text', text: 'Sure. I read the code around it first, then made the change and ran the tests: all green.' }] } },
  ];
}

const COMMANDS = [
  { name: 'compact', description: 'Clear the conversation but keep a summary in context', argumentHint: '' },
  { name: 'model', description: 'Set the model', argumentHint: '[model]' },
  { name: 'effort', description: 'Set the effort', argumentHint: '[low|medium|high|xhigh|max]' },
  { name: 'review', description: 'Review a pull request', argumentHint: '' },
];

const REPLY = 'Here is what I would do next:\n\n- keep the pairing in the Keychain so iOS never clears it\n- reconnect the moment the app comes back to the foreground\n- tick the haptics where the web client vibrates\n\nWant me to start with the first one?';

export function createDemoEngine({ now = () => Date.now() } = {}) {
  const sessions = sampleSessions(now());
  const panes = new Map();
  let turn = 0;

  const opened = (cmd, session, extra = {}) => ({
    ev: 'opened', reqId: cmd.reqId, paneId: cmd.paneId, sessionId: session?.id || null, cwd: session?.cwd || cmd.cwd || 'C:\\Users\\Arthur\\Projects\\claude-latch',
    title: session?.title || 'New conversation', model: MODEL, effort: 'xhigh', mode: 'bypassPermissions', billing: BILLING, terminal: [], ...extra,
  });

  function open(cmd, attached) {
    const session = sessions.find((x) => x.id === cmd.sessionId) || null;
    panes.set(cmd.paneId, { sessionId: session?.id || null });
    const out = [{ delay: 60, ev: opened(cmd, session, attached ? { attached: true, busy: false } : {}) }];
    if (session) {
      const messages = sampleHistory(session, now());
      out.push({ delay: 140, ev: { ev: 'history', paneId: cmd.paneId, sessionId: session.id, messages, total: messages.length } });
    }
    return out;
  }

  /** A streamed reply, the way the SDK's stream events arrive through the engine. */
  function send(cmd) {
    const pane = panes.get(cmd.paneId) || { sessionId: null };
    const out = [];
    if (!pane.sessionId) {
      pane.sessionId = `5f0c1b2a-demo-${String(++turn).padStart(4, '0')}-9d3a-a1b2c3d4e5f6`;
      panes.set(cmd.paneId, pane);
      out.push({ delay: 120, ev: { ev: 'session_id', paneId: cmd.paneId, sessionId: pane.sessionId } });
    }
    const id = `msg_demo_${++turn}`;
    const sdk = (msg, delay) => out.push({ delay, ev: { ev: 'sdk', paneId: cmd.paneId, msg } });
    sdk({ type: 'stream_event', event: { type: 'message_start', message: { id } } }, 400);
    sdk({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } }, 450);
    const words = REPLY.split(/(?<=\s)/);
    let t = 500;
    for (let i = 0; i < words.length; i += 3) { t += 70; sdk({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: words.slice(i, i + 3).join('') } } }, t); }
    sdk({ type: 'assistant', message: { id, content: [{ type: 'text', text: REPLY }] } }, t + 80);
    out.push({ delay: t + 120, ev: { ev: 'result', paneId: cmd.paneId, durationMs: t + 120, usage: { cache_read_input_tokens: 18400, cache_creation_input_tokens: 1200 }, cost: null } });
    return out;
  }

  function handle(cmd) {
    if (!cmd || typeof cmd.op !== 'string') return [];
    switch (cmd.op) {
      case 'sessions':
        return [{ delay: 80, ev: { ev: 'sessions', reqId: cmd.reqId, items: sessions, folders: FOLDERS, billing: BILLING, voice: false } }];
      case 'search': {
        const q = String(cmd.query || '').toLowerCase();
        const results = sessions.filter((x) => x.title.toLowerCase().includes(q)).map((item) => ({ item, kind: null, snippet: '' }));
        return [{ delay: 120, ev: { ev: 'search', reqId: cmd.reqId, query: cmd.query, elapsed: 4, deep: false, results } }];
      }
      case 'open': return open(cmd, false);
      case 'attach': return open(cmd, true);
      case 'send': return send(cmd);
      case 'interrupt': return [{ delay: 60, ev: { ev: 'result', paneId: cmd.paneId, durationMs: 0, subtype: 'interrupted', usage: {} } }];
      case 'commands': return [{ delay: 40, ev: { ev: 'commands', reqId: cmd.reqId, paneId: cmd.paneId, commands: COMMANDS } }];
      case 'model': case 'effort': case 'mode':
        return [{ delay: 40, ev: { ev: 'settings', paneId: cmd.paneId, model: cmd.op === 'model' ? cmd.model : undefined, effort: cmd.op === 'effort' ? cmd.effort : undefined, mode: cmd.op === 'mode' ? cmd.mode : undefined } }];
      case 'close': panes.delete(cmd.paneId); return [{ delay: 20, ev: { ev: 'closed', paneId: cmd.paneId } }];
      default: return [];
    }
  }

  /** What the PC sends right after the channel opens (apaki/engine/remote.js). */
  const ready = () => ({ ev: 'ready', billing: BILLING, model: MODEL, effort: 'xhigh', mode: 'bypassPermissions', pid: 0, voice: false });

  /** The first events of a connection: ready, then the search indexes' state (broadcast to phones), which fills the list's footer. */
  const opening = () => [
    { delay: 30, ev: ready() },
    { delay: 260, ev: { ev: 'index', ok: true, stats: { blocks_added: 14 }, ms: 640 } },
    { delay: 300, ev: { ev: 'meaning', stage: 'ready', result: { ok: true, passages: 48210 } } },
  ];

  return { handle, ready, opening, sessions };
}
