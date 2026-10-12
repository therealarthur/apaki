/**
 * handoff.js: the text the agent taking over a conversation reads at a Claude / Codex switch.
 *
 * WHY (Arthur, 2026-10-11: "gpt gets a diff of the full transcript ... with EVERYTHING", and on the way back "claude
 * code can see not only evereything thats been done, but also the prompts the user sent to the chatgpt controlled
 * convo, the responses, the artifacts, literally everything"; SWITCH.md, 2026-10-12): each side keeps its own native
 * session, and a switch hands it what happened since it last saw the conversation. Long sessions do not fit in the
 * other model's context, so the packet is a summary plus the recent turns word for word, the other side's tool calls
 * as plain text (tool names differ between the two, so they are described, never replayed), the artifacts, and the
 * real code diff from the git checkpoints (checkpoint.js). The whole record stays behind the ledger tool server.
 *
 * Pure functions over ledger events (ledger.js): no I/O, so the packet is tested on its own.
 */

import { HANDOFF_END, HANDOFF_MARK, commandLine } from './ledger.js';

export { HANDOFF_END, HANDOFF_MARK };

export const AGENT = Object.freeze({ claude: 'Claude', codex: 'Codex' });
const PRODUCT = Object.freeze({ claude: 'Claude Code', codex: 'Codex' });
/** The packet's size budget in characters (about 15k tokens), and the share the recent turns get. */
export const PACKET_CHARS = 60000;
const PATCH_SHARE = 0.25;
const DIGEST_SHARE = 0.1;
const REPLY_CHARS = 8000;
const THINK_CHARS = 600;
const PROMPT_CHARS = 6000;
const DIGEST_LINES = 30;
const FILES_LISTED = 40;
const SUMMARY_CHARS = 3000;
/** Codex's own command and patch tools: shown through the command and file_change events instead when a rollout has them. */
const CODEX_EXEC_TOOLS = new Set(['exec', 'shell', 'exec_command', 'local_shell', 'shell_command', 'unified_exec', 'write_stdin', 'apply_patch']);

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const clip = (s, n) => { const t = str(s); return t.length > n ? `${t.slice(0, n).trimEnd()} [... ${t.length - n} more characters]` : t; };
/** A long message keeps its start and its end (where the conclusion usually is), the middle cut. */
const clipMiddle = (s, n) => { const t = str(s); if (t.length <= n) return t; const a = Math.floor(n * 0.4); return `${t.slice(0, a).trimEnd()}\n[... ${t.length - n} characters cut here ...]\n${t.slice(t.length - (n - a)).trimStart()}`; };
const oneLine = (s, n = 160) => { const t = str(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const firstLine = (s, n = 160) => oneLine(str(s).split('\n').map((l) => l.trim()).find(Boolean) || '', n);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A local time stamp for the header ("2026-10-12 09:30"). */
export function stamp(d) {
  const x = d instanceof Date ? d : new Date(d);
  const p = (v) => String(v).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
}

/* ---------- tool calls as plain text ---------- */

/** The files an apply_patch body names. */
export function patchFiles(patch) {
  const out = [];
  for (const m of str(patch).matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) out.push({ path: m[2].trim(), type: m[1].toLowerCase() });
  return out;
}

/** The command a Codex shell-like call ran: an argument list, a string, or the `cmd:"..."` inside an exec script. */
function codexCommand(input) {
  if (input && typeof input === 'object') {
    const c = input.command ?? input.cmd ?? input.commands;
    if (c != null) return commandLine(c);
  }
  const s = str(input);
  const m = /\bcmd\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(s) || /\bcmd\s*:\s*'((?:[^'\\]|\\.)*)'/.exec(s);
  if (m) { try { return JSON.parse(`"${m[1].replace(/\\'/g, "'")}"`); } catch { return m[1]; } }
  return s ? oneLine(s, 200) : '';
}

/**
 * One tool call in words: "ran `npm test`", "edited src/a.ts", "used figma get_file". Names the files it touched too,
 * for the summary.
 * @returns {{ text: string, files: string[] }}
 */
export function describeCall(ev) {
  const t = str(ev.tool);
  const i = ev.input && typeof ev.input === 'object' ? ev.input : {};
  const file = str(i.file_path || i.notebook_path || i.path);
  if (ev.side === 'codex') {
    if (t === 'apply_patch') { const f = patchFiles(typeof ev.input === 'string' ? ev.input : i.input || i.patch); return { text: `edited ${f.map((x) => `${x.path}${x.type === 'update' ? '' : ` (${x.type})`}`).join(', ') || 'files'}`, files: f.map((x) => x.path) }; }
    if (CODEX_EXEC_TOOLS.has(t)) { const c = codexCommand(ev.input); return { text: c ? `ran \`${oneLine(c, 300)}\`` : 'ran a command', files: [] }; }
    if (t === 'update_plan') return { text: `updated its plan${Array.isArray(i.plan) ? ` (${plural(i.plan.length, 'step')})` : ''}`, files: [] };
    if (t === 'web_search') return { text: `searched the web${i.query ? ` for "${oneLine(i.query, 120)}"` : ''}`, files: [] };
    if (t === 'view_image') return { text: `looked at an image${file ? ` (${file})` : ''}`, files: [] };
    const dot = t.indexOf('.');
    if (dot > 0) return { text: `used ${t.slice(0, dot)} ${t.slice(dot + 1)}`, files: [] };
    return { text: `used ${t || 'a tool'}`, files: [] };
  }
  switch (t) {
    case 'Bash': case 'PowerShell': return { text: `ran \`${oneLine(i.command, 300)}\``, files: [] };
    case 'Read': return { text: `read ${file}`, files: [] };
    case 'Edit': case 'MultiEdit': return { text: `edited ${file}`, files: [file] };
    case 'Write': return { text: `wrote ${file}`, files: [file] };
    case 'NotebookEdit': return { text: `edited the notebook ${file}`, files: [file] };
    case 'Grep': return { text: `searched the code for "${oneLine(i.pattern, 100)}"${i.path ? ` in ${i.path}` : ''}`, files: [] };
    case 'Glob': return { text: `listed files matching ${oneLine(i.pattern, 100)}`, files: [] };
    case 'WebFetch': return { text: `fetched ${oneLine(i.url, 200)}`, files: [] };
    case 'WebSearch': return { text: `searched the web for "${oneLine(i.query, 120)}"`, files: [] };
    case 'Task': case 'Agent': return { text: `ran a subagent: ${oneLine(i.description || i.prompt, 160)}`, files: [] };
    case 'TodoWrite': { const todos = Array.isArray(i.todos) ? i.todos : []; return { text: `updated its checklist (${todos.filter((x) => x?.status === 'completed').length} of ${todos.length} done)`, files: [] }; }
    case 'AskUserQuestion': return { text: `asked the user: ${oneLine(i.questions?.[0]?.question, 160)}`, files: [] };
    case 'ExitPlanMode': return { text: 'presented a plan for approval', files: [] };
    case 'Skill': return { text: `used the skill ${oneLine(i.skill || i.name, 80)}`, files: [] };
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(t);
      if (m) return { text: `used ${m[1]} ${m[2]}`, files: [] };
      return { text: `used ${t || 'a tool'}`, files: [] };
    }
  }
}

/** What came back, in a few words: failures always, a command's exit code, otherwise nothing. */
function resultNote(res, { command = false } = {}) {
  if (!res) return '';
  const code = res.exitCode;
  if (res.isError || (code != null && code !== 0)) return `: failed${code != null ? ` (exit ${code})` : ''}: ${firstLine(res.output, 200)}`;
  if (command && code != null) return ` (exit ${code})`;
  return '';
}

/* ---------- turns ---------- */

/**
 * Groups events into turns: each prompt starts one; whatever came before the first prompt is a turn without one
 * (the end of a turn the bookmark cut). Tool results join their calls; Codex's exec calls give way to its command and
 * patch events when the rollout has them, so a command is never listed twice.
 */
export function toTurns(events) {
  const list = Array.isArray(events) ? events : [];
  const hasItems = list.some((e) => e.kind === 'command' || e.kind === 'file_change');
  const results = new Map();
  for (const e of list) if (e.kind === 'tool_result' && e.callId) results.set(e.callId, e);
  const turns = [];
  let cur = null;
  const start = (prompt) => { cur = { prompt, at: prompt?.at || null, parts: [], tools: 0, failed: 0, files: [], replies: 0 }; turns.push(cur); };
  for (const e of list) {
    if (e.kind === 'prompt') { start(e); continue; }
    if (e.kind === 'tool_result' || e.kind === 'settings') continue;
    if (!cur) start(null);
    if (e.kind === 'tool_call') {
      if (hasItems && e.side === 'codex' && CODEX_EXEC_TOOLS.has(e.tool)) continue;
      const d = describeCall(e);
      const res = results.get(e.callId) || null;
      const line = `${d.text}${resultNote(res)}`;
      cur.parts.push({ kind: 'tool', text: line, at: e.at });
      cur.tools += 1;
      if (res && (res.isError || (res.exitCode != null && res.exitCode !== 0))) cur.failed += 1;
      cur.files.push(...d.files.filter(Boolean));
    } else if (e.kind === 'command') {
      cur.parts.push({ kind: 'tool', text: `ran \`${oneLine(e.command, 300)}\`${resultNote({ exitCode: e.exitCode, output: e.output, isError: false }, { command: true })}`, at: e.at });
      cur.tools += 1;
      if (e.exitCode != null && e.exitCode !== 0) cur.failed += 1;
    } else if (e.kind === 'file_change') {
      const ch = Array.isArray(e.changes) ? e.changes : [];
      cur.parts.push({ kind: 'tool', text: `changed ${ch.map((c) => `${c.path}${c.type && c.type !== 'update' ? ` (${c.type})` : ''}`).join(', ') || 'files'}`, at: e.at });
      cur.tools += 1;
      cur.files.push(...ch.map((c) => c.path));
    } else if (e.kind === 'reply') {
      cur.parts.push({ kind: 'reply', text: str(e.text), at: e.at, phase: e.phase || null });
      cur.replies += 1;
    } else if (e.kind === 'reasoning') {
      cur.parts.push({ kind: 'reasoning', text: str(e.text), at: e.at });
    } else if (e.kind === 'compaction') {
      cur.parts.push({ kind: 'compaction', text: str(e.text), at: e.at });
    }
  }
  return turns;
}

/** One turn word for word: the prompt, then the agent's replies, thinking (short) and tool lines in order. */
export function renderTurn(turn, agent) {
  const out = [];
  if (turn.prompt) {
    const imgs = turn.prompt.images ? ` [with ${plural(turn.prompt.images, 'image')}]` : '';
    out.push(`### The user${turn.at ? ` (${stamp(turn.at)})` : ''}\n${clipMiddle(turn.prompt.text, PROMPT_CHARS)}${imgs}`);
  }
  const body = [];
  let tools = [];
  const flush = () => { if (tools.length) { body.push(tools.map((t) => `- ${t}`).join('\n')); tools = []; } };
  for (const p of turn.parts) {
    if (p.kind === 'tool') { tools.push(p.text); continue; }
    flush();
    if (p.kind === 'reply') body.push(clipMiddle(p.text, REPLY_CHARS));
    else if (p.kind === 'reasoning') body.push(`(thinking) ${clip(oneLine(p.text, 4000), THINK_CHARS)}`);
    else if (p.kind === 'compaction') body.push('(the context was compacted here)');
  }
  flush();
  if (body.length) out.push(`### ${agent}\n${body.join('\n\n')}`);
  return out.join('\n\n');
}

/** A turn in one line, for the turns too old to give word for word. */
function digestLine(turn, agent) {
  const said = turn.prompt ? `the user: "${oneLine(turn.prompt.text, 160)}"` : '(continued)';
  const did = [turn.tools ? plural(turn.tools, 'tool call') : '', turn.failed ? `${turn.failed} failed` : '', turn.replies ? plural(turn.replies, 'reply') : ''].filter(Boolean).join(', ');
  return `- ${turn.at ? `${stamp(turn.at)} ` : ''}${said}${did ? `; ${agent}: ${did}` : ''}`;
}

/* ---------- the packet ---------- */

/**
 * The handoff text.
 * @param {object} o
 * @param {'claude'|'codex'} o.from          the side that worked (its events are in o.events)
 * @param {'claude'|'codex'} o.to            the side taking over
 * @param {object[]} o.events                ledger events since the taking side's bookmark
 * @param {boolean} [o.first]                the taking side has never seen this conversation
 * @param {number} [o.n]                     the switch number
 * @param {string} [o.cwd]
 * @param {string} [o.title]
 * @param {number} [o.skipped]               bytes of the giving side's file left unread (a giant file)
 * @param {object} [o.diff]                  diffBetween's answer, or null
 * @param {object} [o.checkpoint]            { ref, prevRef?, base? } the snapshots the diff is between
 * @param {string} [o.checkpointNote]        why there is no diff (not a git repository...)
 * @param {object[]} [o.artifacts]           [{ title, kind, path?, id }]
 * @param {'inject'|'prepend'} [o.delivery]  inject: a message of its own (Codex); prepend: in front of the user's next message
 * @param {boolean} [o.ledgerTools]          the ledger tool server is there to ask for the rest
 * @param {number} [o.budget]
 * @param {Date} [o.now]
 * @returns {{ text: string, counts: { turns: number, verbatim: number, prompts: number, tools: number, files: number } }}
 */
export function buildPacket(o) {
  const from = o.from === 'codex' ? 'codex' : 'claude';
  const to = from === 'codex' ? 'claude' : 'codex';
  const agent = AGENT[from];
  const budget = Math.max(4000, Number(o.budget) || PACKET_CHARS);
  const turns = toTurns(o.events);
  const prompts = turns.filter((t) => t.prompt).length;
  const tools = turns.reduce((n, t) => n + t.tools, 0);
  const failed = turns.reduce((n, t) => n + t.failed, 0);
  const files = [...new Set(turns.flatMap((t) => t.files).filter(Boolean))];
  const compactions = (o.events || []).filter((e) => e.kind === 'compaction' && str(e.text).trim());
  const when = stamp(o.now || new Date());

  // The header: who is taking over, from whom, where.
  const head = [];
  if (to === 'codex') {
    head.push(`${HANDOFF_MARK} Switch ${o.n || 1}, ${when}: this conversation is moving from Claude Code to you (Codex)${o.cwd ? `, in the same folder: ${o.cwd}` : ''}.`);
    head.push(o.first
      ? 'The user worked on it with Claude until now and switched (usually because Claude\'s usage ran out). Continue the same work: read what happened below, do not redo finished steps, and follow the user\'s working rules. Claude\'s tool calls are described in plain text; they are a record, not calls for you to replay.'
      : 'It went back to Claude for a while; below is everything since you last worked on it. Continue from there.');
    head.push(o.delivery === 'prepend' ? 'The user\'s message follows the handoff.' : 'Nothing below is a new request. The user\'s next message comes after this.');
  } else {
    head.push(`${HANDOFF_MARK} Switch ${o.n || 1}, ${when}: this conversation is ${o.first ? 'moving' : 'coming back'} to you (Claude Code) from Codex${o.cwd ? `, which worked in the same folder: ${o.cwd}` : ''}.`);
    head.push(o.first
      ? 'The user worked on it with Codex until now. Continue the same work: read what happened below and do not redo finished steps. Codex\'s tool calls are described in plain text; they are a record, not calls for you to replay.'
      : 'While you were away the user worked with Codex. Below is everything since you left: the user\'s messages to Codex, its replies, what it ran and changed, its artifacts and the code diff. Then the user\'s message.');
  }

  // The summary.
  const sum = [];
  if (o.title) sum.push(`- Conversation: ${oneLine(o.title, 120)}`);
  if (o.first && turns[0]?.prompt && !o.skipped) sum.push(`- It started with the user asking: "${oneLine(turns[0].prompt.text, 300)}"`);
  sum.push(`- ${o.first ? 'So far' : 'Since then'}: ${plural(prompts, 'message')} from the user, ${plural(turns.reduce((n, t) => n + t.replies, 0), 'reply')} and ${plural(tools, 'tool call')} from ${agent}${failed ? ` (${failed} failed)` : ''}.`);
  if (files.length) sum.push(`- Files ${agent} changed: ${files.slice(0, FILES_LISTED).join(', ')}${files.length > FILES_LISTED ? `, and ${files.length - FILES_LISTED} more` : ''}.`);
  if (o.skipped) sum.push(`- The conversation is long: only its newest part was read for this handoff (about ${Math.round(o.skipped / 1048576)} MB before it were not); the ledger tools reach all of it.`);
  const lastSummary = compactions.at(-1);
  if (lastSummary) sum.push(`- ${agent}'s own summary at its last compaction:\n${clip(lastSummary.text.trim(), SUMMARY_CHARS).split('\n').map((l) => `  ${l}`).join('\n')}`);

  // The code.
  const code = [];
  if (o.diff?.ok) {
    const between = o.checkpoint?.ref ? ` (git: ${o.checkpoint.prevRef || o.checkpoint.base || 'HEAD'} to ${o.checkpoint.ref}; the full patch is \`git diff ${o.checkpoint.prevRef || o.checkpoint.base || 'HEAD'} ${o.checkpoint.ref}\`)` : '';
    if (!o.diff.stat && !o.diff.commits) code.push(`No file changed since ${o.first ? 'the last commit' : 'the last switch'}${between}.`);
    else {
      code.push(`What changed on disk since ${o.first ? 'the last commit' : 'the last switch'}${between}, whoever made it:`);
      if (o.diff.commits) code.push(`Commits made in between:\n${o.diff.commits}`);
      if (o.diff.stat) code.push(`\`\`\`\n${o.diff.stat}\n\`\`\``);
    }
  } else if (o.checkpointNote) code.push(`No code diff: ${o.checkpointNote}.`);

  const arts = (Array.isArray(o.artifacts) ? o.artifacts : []).slice(0, 30).map((a) => `- ${oneLine(a.title, 100)} (${a.kind || 'file'}${a.path ? `: ${a.path}` : ''})`);

  const tail = [];
  if (o.ledgerTools) {
    tail.push(`The whole record of both sides is in the "apaki_ledger" tool server: ledger_search finds words in either conversation, ledger_event shows one event in full (its id is like claude@123 or codex@456), ledger_tool_output gives a tool's whole output, and ledger_recent lists the newest events of a side.${to === 'codex' ? ' ledger_skills lists the user\'s Claude Code skills and ledger_skill reads one; ledger_instructions gives their working rules in full.' : ''}`);
  }
  if (to === 'codex' && o.delivery !== 'prepend') tail.push('End of the handoff.');

  // The fixed parts first, then the recent turns word for word with what is left, newest kept.
  const fixed = [head.join('\n'), `## Summary\n${sum.join('\n')}`, code.length ? `## Code changes\n${code.join('\n\n')}` : '', arts.length ? `## Artifacts ${agent} showed the user\n${arts.join('\n')}` : '', tail.join('\n\n')].filter(Boolean);
  const fixedLen = fixed.join('\n\n').length;
  const patch = o.diff?.ok && o.diff.patch ? o.diff.patch : '';
  // The patch gets up to a quarter of the budget and the one-line digest of older turns up to a tenth; the recent turns
  // get the rest of what the fixed parts leave.
  const digestRoom = Math.floor(budget * DIGEST_SHARE);
  let room = Math.max(2000, budget - fixedLen - Math.min(patch.length, Math.floor(budget * PATCH_SHARE)) - digestRoom - 1000);
  const verbatim = [];
  let firstVerbatim = turns.length;
  for (let k = turns.length - 1; k >= 0; k--) {
    const t = renderTurn(turns[k], agent);
    if (!t) { firstVerbatim = k; continue; }
    if (t.length > room) {
      // The newest turn always goes in, cut to fit, its end kept.
      if (!verbatim.length) { verbatim.unshift(`[... the start of this turn is cut]\n${t.slice(t.length - room)}`); firstVerbatim = k; }
      break;
    }
    verbatim.unshift(t);
    firstVerbatim = k;
    room -= t.length + 2;
  }
  const older = turns.slice(0, firstVerbatim);
  // The newest of the older turns, as many as fit.
  const digest = [];
  let digestLeft = digestRoom;
  for (const t of older.slice(-DIGEST_LINES).reverse()) {
    const line = digestLine(t, agent);
    if (line.length + 1 > digestLeft && digest.length) break;
    digest.unshift(line);
    digestLeft -= line.length + 1;
  }
  const skippedTurns = Math.max(0, older.length - digest.length);

  const sections = [fixed[0], fixed[1]];
  if (digest.length) sections.push(`## Earlier turns, in one line each${skippedTurns ? ` (${skippedTurns} older ones are in the ledger)` : ''}\n${digest.join('\n')}`);
  if (verbatim.length) sections.push(`## The ${verbatim.length === turns.length ? '' : 'most recent '}turns, word for word\n\n${verbatim.join('\n\n')}`);
  else sections.push(`## The turns\nNothing new happened in ${PRODUCT[from]} since ${PRODUCT[to]} last saw this conversation.`);
  for (const f of fixed.slice(2)) sections.push(f);
  // The patch itself goes in with whatever room the budget has left.
  let text = sections.join('\n\n');
  if (patch) {
    const left = budget - text.length - 200;
    if (left > 800) {
      const body = patch.length > left ? `${patch.slice(0, left)}\n[... the rest of the patch is cut here]` : patch;
      const at = text.lastIndexOf('## Code changes');
      const block = `\`\`\`diff\n${body}\n\`\`\``;
      if (at >= 0) {
        const end = text.indexOf('\n## ', at + 3);
        text = end < 0 ? `${text}\n\n${block}` : `${text.slice(0, end)}\n\n${block}${text.slice(end)}`;
      }
    }
  }
  return { text, counts: { turns: turns.length, verbatim: verbatim.length, prompts, tools, files: files.length } };
}

/**
 * The message that goes to Claude: the handoff, its end line, then what the person typed. Content is the SDK's
 * message content (a string, or blocks when pictures go with it); the pictures stay as they are.
 */
export function withHandoff(content, packet) {
  const head = `${str(packet).trimEnd()}\n${HANDOFF_END}\n\n`;
  if (typeof content === 'string') return `${head}${content}`;
  if (!Array.isArray(content)) return head.trimEnd();
  const blocks = content.slice();
  const i = blocks.findIndex((b) => b?.type === 'text');
  if (i >= 0) blocks[i] = { ...blocks[i], text: `${head}${blocks[i].text}` };
  else blocks.push({ type: 'text', text: head.trimEnd() });
  return blocks;
}
