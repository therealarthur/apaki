/**
 * folders.js
 *
 * Folders for grouping sessions in latch's picker (Arthur, 2026-10-09: "a way
 * to create folders to group sessions under"). A session sits in at most one
 * folder, like a file in a directory; moving it to another folder takes it out
 * of the first. Folders only group: deleting one never touches a session.
 *
 * Stored in ~/.claude/latch/folders.json:
 *   { version: 1, folders: [{ id, name, sessions: [sessionId], createdAt }] }
 * Written atomically (temp file, then rename), re-read on every call so two
 * latch windows see each other's changes.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_DIR } from './auth.js';

const FILE = () => path.join(process.env.LATCH_DIR || path.join(CLAUDE_DIR, 'latch'), 'folders.json');

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (j && Array.isArray(j.folders)) return j;
  } catch { /* none yet */ }
  return { version: 1, folders: [] };
}

function save(data) {
  const file = FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** All folders, in the order they were made. */
export function listFolders() {
  return load().folders.map((f) => ({ ...f, sessions: [...f.sessions] }));
}

/** sessionId -> folder, for labelling rows. */
export function folderOfSessions() {
  const map = new Map();
  for (const f of load().folders) for (const s of f.sessions) map.set(s, f);
  return map;
}

/** Creates a folder (or returns the existing one with that name). */
export function createFolder(name) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!clean) return { error: 'A folder needs a name.' };
  const data = load();
  const existing = data.folders.find((f) => f.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const folder = { id: crypto.randomUUID().slice(0, 8), name: clean, sessions: [], createdAt: new Date().toISOString() };
  data.folders.push(folder);
  save(data);
  return folder;
}

export function renameFolder(id, name) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!clean) return { error: 'A folder needs a name.' };
  const data = load();
  const f = data.folders.find((x) => x.id === id);
  if (!f) return { error: 'No such folder.' };
  f.name = clean;
  save(data);
  return f;
}

/** Deletes a folder; its sessions just leave it. */
export function deleteFolder(id) {
  const data = load();
  data.folders = data.folders.filter((f) => f.id !== id);
  save(data);
}

/** Puts a session in a folder (taking it out of any other); null id = no folder. */
export function moveToFolder(sessionId, folderId) {
  const data = load();
  for (const f of data.folders) f.sessions = f.sessions.filter((s) => s !== sessionId);
  if (folderId) {
    const f = data.folders.find((x) => x.id === folderId);
    if (!f) return { error: 'No such folder.' };
    f.sessions.push(sessionId);
  }
  save(data);
  return null;
}
