/**
 * components.js
 *
 * Ink components for latch's Claude Code style UI: transcript items, the
 * spinner, the prompt box with its slash-command menu, select lists, and the
 * permission / question / plan dialogs. Written with htm instead of JSX so
 * there is no build step.
 */

import { Box, Text, useInput } from 'ink';
import htm from 'htm';
import React, { useEffect, useReducer, useRef, useState } from 'react';
import { renderMarkdown } from '../render.js';
import { SPINNER_FRAMES, duration, matchCommands, toolLabel, tokens } from './model.js';

export const h = htm.bind(React.createElement);

/** Colors close to Claude Code's dark theme. */
export const theme = {
  brand: '#D77757',
  user: 'gray',
  dim: 'gray',
  ok: '#4EBA65',
  error: '#FF6B80',
  warn: '#FFC107',
  plan: '#48968C',
  accept: '#AF87FF',
  bypass: '#FF6B80',
  suggestion: '#B1B9F9',
  border: '#888888',
  addBg: '#225c2b',
  delBg: '#7a2936',
};

function md(text) {
  return renderMarkdown(String(text || ''), { color: true }).replace(/\n+$/, '');
}

/* ---------- transcript items ---------- */

function UserItem({ item }) {
  return h`<${Box} marginTop=${1}>
    <${Text} color=${theme.dim}>${'> '}</${Text}>
    <${Box} flexGrow=${1}><${Text} color=${theme.user}>${item.text}</${Text}></${Box}>
  </${Box}>`;
}

function AssistantItem({ item }) {
  return h`<${Box} marginTop=${1}>
    <${Text}>${'⏺ '}</${Text}>
    <${Box} flexDirection="column" flexGrow=${1}><${Text}>${md(item.text)}</${Text}></${Box}>
  </${Box}>`;
}

function DiffView({ lines }) {
  return h`<${Box} flexDirection="column" marginLeft=${5}>
    ${lines.map((l, i) => (l.sign === '…'
    ? h`<${Text} key=${i} color=${theme.dim}>${`  … ${l.text}`}</${Text}>`
    : h`<${Text} key=${i} backgroundColor=${l.sign === '+' ? theme.addBg : theme.delBg}>${` ${l.sign} ${l.text || ' '}`}</${Text}>`))}
  </${Box}>`;
}

function TodoView({ todos }) {
  return h`<${Box} flexDirection="column" marginLeft=${5}>
    ${todos.map((t, i) => {
    if (t.status === 'completed') return h`<${Text} key=${i} color=${theme.dim} strikethrough>${`☒ ${t.text}`}</${Text}>`;
    if (t.status === 'in_progress') return h`<${Text} key=${i} bold>${`◼ ${t.text}`}</${Text}>`;
    return h`<${Text} key=${i}>${`☐ ${t.text}`}</${Text}>`;
  })}
  </${Box}>`;
}

function ToolItem({ item }) {
  const dotColor = item.status === 'running' ? theme.dim : item.status === 'error' ? theme.error : theme.ok;
  const label = item.name === 'TodoWrite' ? 'Update Todos' : toolLabel(item.name);
  const lines = item.lines || [];
  return h`<${Box} flexDirection="column" marginTop=${1}>
    <${Box}>
      <${Text} color=${dotColor}>${'⏺ '}</${Text}>
      <${Box} flexGrow=${1}><${Text}><${Text} bold>${label}</${Text}>${item.args ? `(${item.args})` : ''}</${Text}></${Box}>
    </${Box}>
    ${item.status === 'running' && item.progress ? h`<${Text} color=${theme.dim}>${`  ⎿  ${item.progress}${item.subCount ? `  (${item.subCount} tool use${item.subCount === 1 ? '' : 's'})` : ''}`}</${Text}>` : null}
    ${item.status === 'running' && !item.progress ? h`<${Text} color=${theme.dim}>${'  ⎿  Running…'}</${Text}>` : null}
    ${item.status !== 'running' ? lines.map((l, i) => h`<${Box} key=${i}>
      <${Text} color=${theme.dim}>${i === 0 ? '  ⎿  ' : '     '}</${Text}>
      <${Box} flexGrow=${1}><${Text} color=${item.status === 'error' ? theme.error : theme.dim}>${l}</${Text}></${Box}>
    </${Box}>`) : null}
    ${item.status !== 'running' && item.subCount ? h`<${Text} color=${theme.dim}>${`     Done (${item.subCount} tool use${item.subCount === 1 ? '' : 's'})`}</${Text}>` : null}
    ${item.status === 'ok' && item.diff && item.diff.length ? h`<${DiffView} lines=${item.diff} />` : null}
    ${item.todos && item.todos.length ? h`<${TodoView} todos=${item.todos} />` : null}
  </${Box}>`;
}

function NoteItem({ item }) {
  const color = item.tone === 'error' ? theme.error : item.tone === 'warn' ? theme.warn : item.tone === 'ok' ? theme.ok : theme.dim;
  return h`<${Box} marginTop=${item.tight ? 0 : 1} flexDirection="column">
    ${String(item.text).split('\n').map((l, i) => h`<${Text} key=${i} color=${color}>${l}</${Text}>`)}
  </${Box}>`;
}

function DividerItem({ item }) {
  return h`<${Box} marginTop=${1}><${Text} color=${theme.dim}>${`─── ${item.text} ───`}</${Text}></${Box}>`;
}

/** The welcome box at the top of a chat. */
function BannerItem({ item }) {
  return h`<${Box} borderStyle="round" borderColor=${theme.brand} paddingX=${1} flexDirection="column" marginBottom=${0}>
    <${Text}><${Text} color=${theme.brand}>${'✻ '}</${Text}><${Text} bold>${item.title}</${Text}></${Text}>
    <${Text}> </${Text}>
    <${Text} color=${theme.dim} italic>${'  /help for help, /status for your current setup'}</${Text}>
    <${Text}> </${Text}>
    ${item.rows.map(([k, v], i) => h`<${Text} key=${i} color=${theme.dim}>${`  ${k.padEnd(8)} `}<${Text} color="white">${v}</${Text}></${Text}>`)}
  </${Box}>`;
}

export function ItemView({ item }) {
  switch (item.kind) {
    case 'user': return h`<${UserItem} item=${item} />`;
    case 'assistant': return h`<${AssistantItem} item=${item} />`;
    case 'tool': return h`<${ToolItem} item=${item} />`;
    case 'divider': return h`<${DividerItem} item=${item} />`;
    case 'banner': return h`<${BannerItem} item=${item} />`;
    default: return h`<${NoteItem} item=${item} />`;
  }
}

/* ---------- spinner ---------- */

export function Spinner({ verb, startedAt, outTokens, thinking }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 120);
    return () => clearInterval(t);
  }, []);
  const frame = SPINNER_FRAMES[tick % SPINNER_FRAMES.length];
  const parts = [duration(Date.now() - startedAt)];
  if (outTokens) parts.push(`↓ ${tokens(outTokens)} tokens`);
  if (thinking) parts.push('thinking');
  parts.push('esc to interrupt');
  return h`<${Box} marginTop=${1}>
    <${Text} color=${theme.brand}>${`${frame} ${verb}… `}</${Text}>
    <${Text} color=${theme.dim}>${`(${parts.join(' · ')})`}</${Text}>
  </${Box}>`;
}

/* ---------- select list and dialogs ---------- */

/**
 * Numbered options with a ❯ cursor. Up/Down or the number keys move, Enter
 * picks, Esc cancels (onCancel). With `multi`, Space toggles.
 */
export function SelectList({ options, onPick, onCancel, multi = false, initial = 0, active = true }) {
  const selRef = useRef(Math.min(initial, Math.max(0, options.length - 1)));
  const pickedRef = useRef(new Set());
  const [, redraw] = useReducer((n) => n + 1, 0);
  const setSel = (fn) => { selRef.current = fn(selRef.current); redraw(); };
  const setPicked = (fn) => { pickedRef.current = fn(pickedRef.current); redraw(); };
  const sel = selRef.current;
  const picked = pickedRef.current;
  useInput((input, key) => {
    if (!active) return;
    const sel = selRef.current;
    const picked = pickedRef.current;
    if (key.upArrow || (key.ctrl && input === 'p')) setSel((s) => (s - 1 + options.length) % options.length);
    else if (key.downArrow || (key.ctrl && input === 'n') || key.tab) setSel((s) => (s + 1) % options.length);
    else if (key.escape) onCancel?.();
    else if (multi && input === ' ') {
      setPicked((p) => { const n = new Set(p); n.has(sel) ? n.delete(sel) : n.add(sel); return n; });
    } else if (key.return) {
      if (multi) onPick([...(picked.size ? picked : new Set([sel]))].sort((a, b) => a - b).map((i) => options[i]));
      else onPick(options[sel]);
    } else if (/^[1-9]$/.test(input) && Number(input) <= options.length) {
      const i = Number(input) - 1;
      if (multi) setPicked((p) => { const n = new Set(p); n.has(i) ? n.delete(i) : n.add(i); return n; });
      else onPick(options[i]);
    }
  }, { isActive: active });
  return h`<${Box} flexDirection="column">
    ${options.map((o, i) => {
    const on = i === sel;
    const mark = multi ? (picked.has(i) ? '[✔] ' : '[ ] ') : '';
    return h`<${Box} key=${i} flexDirection="column">
        <${Text} color=${on ? theme.suggestion : undefined}>${`${on ? '❯' : ' '} ${i + 1}. ${mark}${o.label}`}</${Text}>
        ${o.description ? h`<${Text} color=${theme.dim}>${`     ${o.description}`}</${Text}>` : null}
      </${Box}>`;
  })}
  </${Box}>`;
}

/** Bordered dialog frame. */
export function Dialog({ title, color = theme.suggestion, children }) {
  return h`<${Box} borderStyle="round" borderColor=${color} flexDirection="column" paddingX=${1} marginTop=${1}>
    <${Text} bold color=${color}>${title}</${Text}>
    ${children}
  </${Box}>`;
}

/** Free-text line used inside dialogs ("tell Claude what to do instead"). */
export function LineInput({ prompt, onSubmit, onCancel, placeholder = '' }) {
  const [value, setValue] = useState('');
  useInput((input, key) => {
    if (key.escape) onCancel?.();
    else if (key.return) onSubmit(value);
    else if (key.backspace || key.delete) setValue((v) => v.slice(0, -1));
    else if (input && !key.ctrl && !key.meta) setValue((v) => v + input.replace(/\r?\n/g, ' '));
  });
  return h`<${Box}>
    <${Text} color=${theme.suggestion}>${prompt}</${Text}>
    <${Text}>${value}</${Text}><${Text} inverse>${' '}</${Text}>
    ${!value && placeholder ? h`<${Text} color=${theme.dim}>${` ${placeholder}`}</${Text}>` : null}
  </${Box}>`;
}

/** Claude Code's tool permission prompt. Resolves with an SDK PermissionResult. */
export function PermissionDialog({ dialog }) {
  const [typing, setTyping] = useState(false);
  const { toolName, input, detail, resolve } = dialog;
  const title = toolName === 'Bash' || toolName === 'PowerShell' ? `${toolName} command` : toolName.startsWith('mcp__') ? 'Tool use' : `${toolName}`;
  const options = [
    { label: 'Yes', value: 'yes' },
    { label: `Yes, and don't ask again for ${toolLabel(toolName)} this session`, value: 'always' },
    { label: 'No, and tell Claude what to do differently (esc)', value: 'no' },
  ];
  if (typing) {
    return h`<${Dialog} title=${title}>
      <${Text}>${detail}</${Text}>
      <${LineInput} prompt="What should Claude do instead? " onSubmit=${(t) => resolve({ behavior: 'deny', message: t || 'The user declined this tool call.' })} onCancel=${() => resolve({ behavior: 'deny', message: 'The user declined this tool call.' })} />
    </${Dialog}>`;
  }
  return h`<${Dialog} title=${title}>
    <${Box} marginY=${1} flexDirection="column"><${Text}>${detail}</${Text}></${Box}>
    <${Text}>Do you want to proceed?</${Text}>
    <${SelectList} options=${options}
      onCancel=${() => resolve({ behavior: 'deny', message: 'The user declined this tool call.' })}
      onPick=${(o) => (o.value === 'no' ? setTyping(true) : resolve({ behavior: 'allow', updatedInput: input, always: o.value === 'always' }))} />
  </${Dialog}>`;
}

/** AskUserQuestion: one question at a time, options plus a free answer. */
export function QuestionDialog({ dialog }) {
  const { input, resolve } = dialog;
  const questions = input.questions || [];
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState({});
  const [typing, setTyping] = useState(false);
  const q = questions[index];
  const done = (next) => {
    if (index + 1 < questions.length) { setAnswers(next); setIndex(index + 1); setTyping(false); return; }
    resolve({ behavior: 'allow', updatedInput: { ...input, answers: next } });
  };
  if (!q) { resolve({ behavior: 'allow', updatedInput: { ...input, answers } }); return null; }
  const options = [...(q.options || []).map((o) => ({ label: o.label, description: o.description, value: o.label })), { label: 'Type something else', value: '__other' }];
  const head = questions.length > 1 ? `${q.header || 'Question'} (${index + 1}/${questions.length})` : (q.header || 'Question');
  return h`<${Dialog} title=${head} color=${theme.brand}>
    <${Box} marginY=${1}><${Text} bold>${q.question}</${Text}></${Box}>
    ${typing
    ? h`<${LineInput} prompt="› " onSubmit=${(t) => done({ ...answers, [q.question]: t })} onCancel=${() => setTyping(false)} />`
    : h`<${SelectList} key=${index} options=${options} multi=${Boolean(q.multiSelect)}
        onCancel=${() => resolve({ behavior: 'deny', message: 'The user dismissed the question without answering.' })}
        onPick=${(picked) => {
    const list = Array.isArray(picked) ? picked : [picked];
    if (list.some((o) => o.value === '__other')) { setTyping(true); return; }
    done({ ...answers, [q.question]: list.map((o) => o.value).join(', ') });
  }} />`}
    <${Text} color=${theme.dim}>${q.multiSelect ? 'space to toggle · enter to confirm · esc to dismiss' : 'enter to select · esc to dismiss'}</${Text}>
  </${Dialog}>`;
}

/** ExitPlanMode: show the plan, then Claude Code's three choices. */
export function PlanDialog({ dialog }) {
  const { input, resolve, setMode } = dialog;
  const [typing, setTyping] = useState(false);
  const options = [
    { label: 'Yes, and auto-accept edits', value: 'acceptEdits' },
    { label: 'Yes, and manually approve edits', value: 'default' },
    { label: 'No, keep planning', value: 'no' },
  ];
  return h`<${Dialog} title="Ready to code?" color=${theme.plan}>
    <${Text}>Here is Claude's plan:</${Text}>
    <${Box} borderStyle="round" borderColor=${theme.dim} paddingX=${1} marginY=${1}><${Text}>${md(input.plan || '')}</${Text}></${Box}>
    ${typing
    ? h`<${LineInput} prompt="What should change? " onSubmit=${(t) => resolve({ behavior: 'deny', message: t || 'The user wants to keep planning.' })} onCancel=${() => setTyping(false)} />`
    : h`<${SelectList} options=${options}
        onCancel=${() => resolve({ behavior: 'deny', message: 'The user wants to keep planning.' })}
        onPick=${(o) => { if (o.value === 'no') { setTyping(true); return; } setMode(o.value); resolve({ behavior: 'allow', updatedInput: input }); }} />`}
  </${Dialog}>`;
}

/** A generic choice (used by /model, /effort, /key). */
export function ChoiceDialog({ dialog }) {
  return h`<${Dialog} title=${dialog.title}>
    ${dialog.subtitle ? h`<${Text} color=${theme.dim}>${dialog.subtitle}</${Text}>` : null}
    <${Box} marginTop=${1}><${SelectList} options=${dialog.options} initial=${dialog.initial || 0} onPick=${(o) => dialog.resolve(o)} onCancel=${() => dialog.resolve(null)} /></${Box}>
  </${Dialog}>`;
}

/* ---------- prompt box ---------- */

function wordLeft(value, cursor) {
  let i = cursor;
  while (i > 0 && /\s/.test(value[i - 1])) i--;
  while (i > 0 && !/\s/.test(value[i - 1])) i--;
  return i;
}

/**
 * The input box: rounded border, "> " prompt, a block cursor, multi-line
 * (end a line with \ or press Alt+Enter), paste, history on Up/Down, and the
 * slash-command menu (Up/Down to choose, Tab to complete, Enter to run).
 */
export function PromptInput({ commands, history, onSubmit, onShiftTab, onEscape, onCtrlC, busy, placeholder, width }) {
  // Live state in a ref: keys can arrive faster than redraws, and each one
  // must see the text the previous one left.
  const st = useRef({ value: '', cursor: 0, menuSel: 0, hist: -1 });
  const [, redraw] = useReducer((n) => n + 1, 0);
  const menuFor = (v) => (/^\/\S*$/.test(v) ? matchCommands(commands, v.slice(1)) : []);
  const set = (v, c = v.length) => { Object.assign(st.current, { value: v, cursor: c, menuSel: 0 }); redraw(); };
  const setCursor = (fn) => { st.current.cursor = fn(st.current.cursor); redraw(); };
  const setMenuSel = (fn) => { st.current.menuSel = fn(st.current.menuSel); redraw(); };
  const setHist = (n) => { st.current.hist = n; };

  useInput((input, key) => {
    const { value, cursor, menuSel, hist } = st.current;
    const slash = /^\/\S*$/.test(value) ? value.slice(1) : null;
    const menu = menuFor(value);
    if (key.ctrl && input === 'c') { if (value) set(''); else onCtrlC?.(); return; }
    if (key.shift && key.tab) { onShiftTab?.(); return; }
    if (key.escape) { if (menu.length) { set(''); return; } onEscape?.(); return; }
    if (menu.length && (key.upArrow || key.downArrow)) {
      setMenuSel((s) => (s + (key.upArrow ? -1 : 1) + menu.length) % menu.length);
      return;
    }
    if (menu.length && key.tab) { set(`/${menu[menuSel].name} `); return; }
    if (key.return) {
      if (key.meta || value.slice(0, cursor).endsWith('\\')) {
        const before = key.meta ? value.slice(0, cursor) : value.slice(0, cursor - 1);
        set(`${before}\n${value.slice(cursor)}`, before.length + 1);
        return;
      }
      const text = menu.length && slash !== menu[menuSel].name ? `/${menu[menuSel].name}` : value;
      if (!text.trim()) return;
      onSubmit(text);
      set('');
      setHist(-1);
      return;
    }
    if (key.upArrow || key.downArrow) {
      if (value.includes('\n') || !history.length) return;
      const next = key.upArrow ? Math.min(hist + 1, history.length - 1) : hist - 1;
      setHist(next);
      set(next < 0 ? '' : history[history.length - 1 - next]);
      return;
    }
    if (key.leftArrow) { setCursor((c) => (key.ctrl || key.meta ? wordLeft(value, c) : Math.max(0, c - 1))); return; }
    if (key.rightArrow) { setCursor((c) => Math.min(value.length, c + 1)); return; }
    if (key.home || (key.ctrl && input === 'a')) { setCursor(0); return; }
    if (key.end || (key.ctrl && input === 'e')) { setCursor(value.length); return; }
    if (key.ctrl && input === 'u') { set(value.slice(cursor), 0); return; }
    if (key.ctrl && input === 'k') { set(value.slice(0, cursor), cursor); return; }
    if (key.ctrl && input === 'w') { const i = wordLeft(value, cursor); set(value.slice(0, i) + value.slice(cursor), i); return; }
    if (key.backspace || key.delete) {
      if (cursor > 0) set(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      return;
    }
    if (key.ctrl || key.meta || !input) return;
    const text = input.replace(/\r\n?/g, '\n');
    set(value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length);
  });

  const { value, cursor, menuSel } = st.current;
  const menu = menuFor(value);
  const lines = value.split('\n');
  let offset = 0;
  const rendered = lines.map((line, li) => {
    const start = offset;
    offset += line.length + 1;
    const inLine = cursor >= start && cursor <= start + line.length;
    const prefix = li === 0 ? '> ' : '  ';
    if (!inLine) return h`<${Text} key=${li}><${Text} color=${theme.dim}>${prefix}</${Text}>${line}</${Text}>`;
    const at = cursor - start;
    const ch = line[at] || ' ';
    return h`<${Text} key=${li}><${Text} color=${theme.dim}>${prefix}</${Text}>${line.slice(0, at)}<${Text} inverse>${ch}</${Text}>${line.slice(at + 1)}</${Text}>`;
  });
  if (!value && placeholder) {
    rendered[0] = h`<${Text} key=${0}><${Text} color=${theme.dim}>${'> '}</${Text}><${Text} inverse>${placeholder[0]}</${Text}><${Text} color=${theme.dim}>${placeholder.slice(1)}</${Text}></${Text}>`;
  }
  const nameWidth = Math.min(28, Math.max(10, ...menu.map((c) => c.name.length + 1)));
  return h`<${Box} flexDirection="column" marginTop=${1}>
    <${Box} borderStyle="round" borderColor=${busy ? theme.dim : theme.border} paddingX=${1} flexDirection="column" width=${width}>
      ${rendered}
    </${Box}>
    ${menu.length ? h`<${Box} flexDirection="column" paddingX=${2}>
      ${menu.map((c, i) => h`<${Box} key=${c.name}>
        <${Text} color=${i === menuSel ? theme.suggestion : undefined} bold=${i === menuSel}>${`/${c.name}`.padEnd(nameWidth + 2)}</${Text}>
        <${Box} flexGrow=${1}><${Text} color=${i === menuSel ? theme.suggestion : theme.dim} wrap="truncate-end">${c.description || ''}</${Text}></${Box}>
      </${Box}>`)}
    </${Box}>` : null}
  </${Box}>`;
}
