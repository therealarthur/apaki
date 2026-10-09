//! latch-index: an incremental full-text index over every Claude Code
//! transcript on this machine (~/.claude/projects/**/*.jsonl, subagent and
//! workflow runs included), so latch can search inside all conversations in
//! well under a second.
//!
//! WHY (Arthur, 2026-10-09): search "needs to be deep, thorough and system
//! wide ... within 3 seconds". The transcripts are 18+ GB, too much to scan per
//! query in any language, so this keeps an index and only reads what changed.
//!
//! What is indexed, per user/assistant entry: typed prompts, replies, tool
//! calls (name and main input) and tool results, for main sessions and
//! subagents. Injected context (isMeta entries, <system-reminder> blocks) is
//! skipped. The index stores only where each block lives (file and byte
//! offset of its line), never the text, so it stays small; snippets are cut
//! from the transcript line at search time.
//!
//! Transcripts are append-only, so an update reads each file from the last
//! indexed byte. A file that shrank is re-indexed from the start; a deleted
//! file has its entries removed. Work is committed in batches, so an
//! interrupted first build resumes where it stopped.
//!
//! Usage:
//!   latch-index update            bring the index up to date, print JSON stats
//!   latch-index search <words>    best sessions as JSON (--limit N, default 40)
//!   latch-index status            entries, files, size on disk
//!   latch-index serve             stay running: JSON commands on stdin, one
//!                                 JSON reply per line (search by words and
//!                                 meaning, update, status); see serve()
//!   latch-index hybrid <words>    one search by words and meaning (testing)
//! Env: LATCH_INDEX_DIR (default ~/.claude/latch/index), CLAUDE_CONFIG_DIR,
//!      LATCH_MODEL_DIR (embedding model, default ~/.claude/latch/models),
//!      LATCH_EMBED_CPU=1 (never use the GPU).
//!
//! The meaning index (semantic.rs, 2026-10-09) lives in ~/.claude/latch/semantic
//! (LATCH_SEMANTIC_DIR) and is searched together with the keyword index.

mod semantic;

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use anyhow::{bail, Result};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::{Field, Schema, Value as _, FAST, INDEXED, STORED, STRING, TEXT};
use tantivy::{doc, Index, IndexWriter, TantivyDocument, Term};

/// Bump when the schema or extraction rules change: the index is rebuilt.
const FORMAT_VERSION: u32 = 1;
/// Indexed characters per block. Prompts and replies are rarely longer;
/// tool output past this is mostly file contents already indexed elsewhere.
const MAX_SPOKEN_CHARS: usize = 32 * 1024;
const MAX_TOOL_CHARS: usize = 8 * 1024;
/// Files per commit during an update, so a long first build is resumable.
const FILES_PER_BATCH: usize = 400;
const WRITER_MEMORY: usize = 1_000_000_000;
/// Hits considered before grouping by session.
const MAX_HITS: usize = 20_000;

#[derive(Serialize, Deserialize, Default, Clone, Copy)]
struct FileState {
    /// Bytes indexed so far; always ends on a line break.
    offset: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct State {
    version: u32,
    files: HashMap<String, FileState>,
}

struct Fields {
    text: Field,
    session: Field,
    file: Field,
    offset: Field,
    kind: Field,
    ts: Field,
}

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default()
}

fn claude_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| home().join(".claude"))
}

fn index_dir() -> PathBuf {
    std::env::var_os("LATCH_INDEX_DIR").map(PathBuf::from).unwrap_or_else(|| claude_dir().join("latch").join("index"))
}

fn schema() -> (Schema, Fields) {
    let mut b = Schema::builder();
    let text = b.add_text_field("text", TEXT);
    let session = b.add_text_field("session", STRING | STORED);
    let file = b.add_text_field("file", STRING | STORED);
    let offset = b.add_u64_field("offset", STORED | INDEXED | FAST);
    let kind = b.add_text_field("kind", STRING | STORED);
    let ts = b.add_text_field("ts", STORED);
    (b.build(), Fields { text, session, file, offset, kind, ts })
}

/// Opens the index, creating it, or recreating it when the format changed.
fn open_index(dir: &Path, state: &mut State) -> Result<(Index, Fields)> {
    let (schema, fields) = schema();
    if state.version != FORMAT_VERSION && dir.join("meta.json").exists() {
        // Remove the old index files but keep the folder's provenance note.
        if let Ok(rd) = fs::read_dir(dir) {
            for e in rd.flatten() {
                if e.file_name() != "_WHY_THIS_IS_HERE.md" {
                    let p = e.path();
                    if p.is_dir() { fs::remove_dir_all(&p).ok(); } else { fs::remove_file(&p).ok(); }
                }
            }
        }
        state.files.clear();
    }
    state.version = FORMAT_VERSION;
    fs::create_dir_all(dir)?;
    let index = if dir.join("meta.json").exists() {
        Index::open_in_dir(dir)?
    } else {
        Index::create_in_dir(dir, schema)?
    };
    Ok((index, fields))
}

fn state_path(dir: &Path) -> PathBuf {
    dir.join("latch-state.json")
}

fn load_state(dir: &Path) -> State {
    fs::read(state_path(dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_state(dir: &Path, state: &State) -> Result<()> {
    let tmp = dir.join("latch-state.json.tmp");
    fs::write(&tmp, serde_json::to_vec(state)?)?;
    fs::rename(&tmp, state_path(dir))?;
    Ok(())
}

fn codex_dir() -> PathBuf {
    std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".codex"))
}

/// Codex sessions (~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl),
/// as session "codex:<uuid>". Added 2026-10-09 (Arthur: "yes index codex
/// sessions too"); they are shown read-only, continued in Codex itself.
fn codex_transcripts(sessions: &Path) -> Vec<(PathBuf, String, u64)> {
    fn walk(dir: &Path, out: &mut Vec<(PathBuf, String, u64)>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                walk(&p, out);
            } else if p.extension().is_some_and(|x| x == "jsonl") {
                let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                let id = if stem.len() >= 36 { stem[stem.len() - 36..].to_string() } else { stem.clone() };
                if let Ok(m) = e.metadata() {
                    out.push((p, format!("codex:{id}"), m.len()));
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(sessions, &mut out);
    out
}

/// Every transcript with the session it belongs to. A top-level
/// `<project>/<id>.jsonl` is session <id>; anything under `<project>/<id>/`
/// (subagents, workflows) belongs to session <id>.
fn transcripts(projects: &Path) -> Vec<(PathBuf, String, u64)> {
    fn walk(dir: &Path, session: &str, out: &mut Vec<(PathBuf, String, u64)>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                walk(&p, session, out);
            } else if p.extension().is_some_and(|x| x == "jsonl") {
                if let Ok(m) = e.metadata() {
                    out.push((p, session.to_string(), m.len()));
                }
            }
        }
    }
    let mut out = Vec::new();
    let Ok(projects_rd) = fs::read_dir(projects) else { return out };
    for project in projects_rd.flatten() {
        let Ok(rd) = fs::read_dir(project.path()) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if name != "memory" {
                    walk(&p, &name, &mut out);
                }
            } else if let Some(stem) = name.strip_suffix(".jsonl") {
                if let Ok(m) = e.metadata() {
                    out.push((p, stem.to_string(), m.len()));
                }
            }
        }
    }
    out
}

fn strip_reminders(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find("<system-reminder>") {
        out.push_str(&rest[..i]);
        match rest[i..].find("</system-reminder>") {
            Some(j) => rest = &rest[i + j + "</system-reminder>".len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

fn is_injected(t: &str) -> bool {
    let t = t.trim_start();
    ["<command-name", "<command-message", "<local-command-", "<task-notification", "<relayed-turns"]
        .iter()
        .any(|p| t.starts_with(p))
}

fn cap(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn tool_result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|c| c.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn tool_use_text(block: &Value) -> String {
    let name = block.get("name").and_then(Value::as_str).unwrap_or("");
    let input = block.get("input").cloned().unwrap_or(Value::Null);
    let mut parts = vec![name.to_string()];
    if let Value::Object(map) = &input {
        for (_, v) in map {
            match v {
                Value::String(s) => parts.push(s.clone()),
                Value::Number(_) | Value::Bool(_) => {}
                other => parts.push(other.to_string()),
            }
        }
    }
    parts.join(" ")
}

/// Codex instructions and environment blocks it injects as user messages.
fn codex_injected(t: &str) -> bool {
    let t = t.trim_start();
    ["# AGENTS.md instructions", "<environment_context>", "<user_instructions>", "<INSTRUCTIONS>", "<turn_aborted>"]
        .iter()
        .any(|p| t.starts_with(p))
}

fn text_items(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|c| c.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// The searchable blocks of one Codex `response_item` entry as (kind, text).
fn extract_codex(entry: &Value) -> Vec<(String, String)> {
    if entry.get("type").and_then(Value::as_str) != Some("response_item") {
        return vec![];
    }
    let Some(p) = entry.get("payload") else { return vec![] };
    let mut out = Vec::new();
    let mut push = |kind: &str, text: String, max: usize| {
        let t = text.trim();
        if !t.is_empty() {
            out.push((kind.to_string(), cap(t, max).to_string()));
        }
    };
    let name = p.get("name").and_then(Value::as_str).unwrap_or("");
    match p.get("type").and_then(Value::as_str) {
        Some("message") => {
            let text = text_items(p.get("content"));
            match p.get("role").and_then(Value::as_str) {
                Some("user") if !codex_injected(&text) => push("prompt", text, MAX_SPOKEN_CHARS),
                Some("assistant") => push("reply", text, MAX_SPOKEN_CHARS),
                _ => {}
            }
        }
        Some("agent_message") => {
            let text = p.get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| text_items(p.get("content")));
            push("reply", text, MAX_SPOKEN_CHARS);
        }
        Some("function_call") => {
            push("tool", format!("{name} {}", p.get("arguments").and_then(Value::as_str).unwrap_or("")), MAX_TOOL_CHARS)
        }
        Some("custom_tool_call") => {
            let input = p.get("input").map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())).unwrap_or_default();
            push("tool", format!("{name} {input}"), MAX_TOOL_CHARS)
        }
        Some("function_call_output") | Some("custom_tool_call_output") => {
            let o = p.get("output").map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())).unwrap_or_default();
            push("result", o, MAX_TOOL_CHARS)
        }
        _ => {}
    }
    out
}

/// Blocks of an entry from either transcript format.
fn extract_any(entry: &Value) -> Vec<(String, String)> {
    if entry.get("payload").is_some() {
        extract_codex(entry)
    } else {
        extract(entry)
    }
}

/// The searchable blocks of one transcript entry as (kind, text).
fn extract(entry: &Value) -> Vec<(String, String)> {
    let kind_of = entry.get("type").and_then(Value::as_str).unwrap_or("");
    if kind_of != "user" && kind_of != "assistant" {
        return vec![];
    }
    if entry.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return vec![];
    }
    let agent = entry.get("isSidechain").and_then(Value::as_bool) == Some(true);
    let prefix = if agent { "agent-" } else { "" };
    let Some(content) = entry.get("message").and_then(|m| m.get("content")) else { return vec![] };
    let mut out = Vec::new();
    let mut push = |kind: &str, text: String, max: usize| {
        let t = text.trim();
        if !t.is_empty() {
            out.push((format!("{prefix}{kind}"), cap(t, max).to_string()));
        }
    };
    match content {
        Value::String(s) if kind_of == "user" => {
            let t = strip_reminders(s);
            if !is_injected(&t) {
                push("prompt", t, MAX_SPOKEN_CHARS);
            }
        }
        Value::Array(blocks) => {
            for b in blocks {
                match b.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let raw = b.get("text").and_then(Value::as_str).unwrap_or("");
                        let t = strip_reminders(raw);
                        if is_injected(&t) {
                            continue;
                        }
                        push(if kind_of == "user" { "prompt" } else { "reply" }, t, MAX_SPOKEN_CHARS);
                    }
                    Some("tool_use") => push("tool", tool_use_text(b), MAX_TOOL_CHARS),
                    Some("tool_result") => {
                        push("result", tool_result_text(b.get("content").unwrap_or(&Value::Null)), MAX_TOOL_CHARS)
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    out
}

/// Indexes `path` from byte `from`; returns the new offset (end of the last
/// complete line) and the number of blocks added.
fn index_file(writer: &IndexWriter, f: &Fields, path: &Path, session: &str, from: u64) -> Result<(u64, u64)> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(from))?;
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let path_str = path.to_string_lossy().to_string();
    let finder_user = memchr::memmem::Finder::new(b"\"type\":\"user\"");
    let finder_assistant = memchr::memmem::Finder::new(b"\"type\":\"assistant\"");
    let finder_codex = memchr::memmem::Finder::new(b"\"type\":\"response_item\"");
    let mut offset = from;
    let mut added = 0u64;
    let mut line = Vec::with_capacity(64 * 1024);
    loop {
        line.clear();
        let n = reader.read_until(b'\n', &mut line)?;
        if n == 0 || line.last() != Some(&b'\n') {
            break; // end of file, or a line still being written
        }
        let line_offset = offset;
        offset += n as u64;
        if finder_user.find(&line).is_none() && finder_assistant.find(&line).is_none() && finder_codex.find(&line).is_none() {
            continue;
        }
        let Ok(entry) = serde_json::from_slice::<Value>(&line) else { continue };
        let ts = entry.get("timestamp").and_then(Value::as_str).unwrap_or("").to_string();
        for (kind, text) in extract_any(&entry) {
            writer.add_document(doc!(
                f.text => text,
                f.session => session,
                f.file => path_str.as_str(),
                f.offset => line_offset,
                f.kind => kind,
                f.ts => ts.as_str(),
            ))?;
            added += 1;
        }
    }
    Ok((offset, added))
}

fn update() -> Result<Value> {
    let started = Instant::now();
    let dir = index_dir();
    fs::create_dir_all(&dir)?;
    let mut state = load_state(&dir);
    let (index, f) = open_index(&dir, &mut state)?;
    let mut writer: IndexWriter = match index.writer(WRITER_MEMORY) {
        Ok(w) => w,
        Err(tantivy::TantivyError::LockFailure(..)) => {
            return Ok(json!({ "ok": true, "busy": true, "note": "another update is running" }));
        }
        Err(e) => return Err(e.into()),
    };

    let mut files = transcripts(&claude_dir().join("projects"));
    files.extend(codex_transcripts(&codex_dir().join("sessions")));
    let on_disk: std::collections::HashSet<String> = files.iter().map(|(p, _, _)| p.to_string_lossy().to_string()).collect();

    // Removed transcripts lose their entries.
    let gone: Vec<String> = state.files.keys().filter(|k| !on_disk.contains(*k)).cloned().collect();
    for k in &gone {
        writer.delete_term(Term::from_field_text(f.file, k));
        state.files.remove(k);
    }

    // Work: files that grew, new files, and files that shrank (rewritten).
    let mut work: Vec<(PathBuf, String, u64)> = Vec::new();
    for (p, session, size) in files {
        let key = p.to_string_lossy().to_string();
        let done = state.files.get(&key).map(|s| s.offset).unwrap_or(0);
        if size < done {
            writer.delete_term(Term::from_field_text(f.file, &key));
            work.push((p, session, 0));
        } else if size > done {
            work.push((p, session, done));
        }
    }
    let total_bytes: u64 = work.iter().map(|(p, _, from)| fs::metadata(p).map(|m| m.len().saturating_sub(*from)).unwrap_or(0)).sum();

    let added = AtomicU64::new(0);
    let mut errors = 0usize;
    for batch in work.chunks(FILES_PER_BATCH) {
        let results: Vec<(String, Result<(u64, u64)>)> = batch
            .par_iter()
            .map(|(p, session, from)| (p.to_string_lossy().to_string(), index_file(&writer, &f, p, session, *from)))
            .collect();
        for (key, r) in results {
            match r {
                Ok((offset, n)) => {
                    added.fetch_add(n, Ordering::Relaxed);
                    state.files.insert(key, FileState { offset });
                }
                Err(_) => errors += 1,
            }
        }
        writer.commit()?;
        save_state(&dir, &state)?;
    }
    if work.is_empty() && !gone.is_empty() {
        writer.commit()?;
        save_state(&dir, &state)?;
    }
    if work.is_empty() && gone.is_empty() {
        save_state(&dir, &state)?;
    }
    drop(writer);

    Ok(json!({
        "ok": true,
        "files_changed": work.len(),
        "files_removed": gone.len(),
        "bytes_read": total_bytes,
        "blocks_added": added.load(Ordering::Relaxed),
        "errors": errors,
        "elapsed_ms": started.elapsed().as_millis() as u64,
    }))
}

/// Lowercased query words for snippet placement (operators and quotes dropped).
fn query_words(q: &str) -> Vec<String> {
    q.split(|c: char| c.is_whitespace() || c == '"')
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase())
        .filter(|w| !w.is_empty() && w != "and" && w != "or" && w != "not")
        .collect()
}

/// The text of the block of `kind` on the line at `offset`, cut around the
/// first query word it contains.
fn snippet(file: &str, offset: u64, kind: &str, words: &[String]) -> String {
    let Ok(mut fh) = File::open(file) else { return String::new() };
    if fh.seek(SeekFrom::Start(offset)).is_err() {
        return String::new();
    }
    let mut line = Vec::new();
    if BufReader::new(fh).read_until(b'\n', &mut line).is_err() {
        return String::new();
    }
    let Ok(entry) = serde_json::from_slice::<Value>(&line) else { return String::new() };
    let blocks = extract_any(&entry);
    let lower_words: Vec<&str> = words.iter().map(String::as_str).collect();
    let pick = blocks
        .iter()
        .filter(|(k, _)| k == kind)
        .find(|(_, t)| {
            let lt = t.to_lowercase();
            lower_words.iter().any(|w| lt.contains(w))
        })
        .or_else(|| blocks.iter().find(|(k, _)| k == kind))
        .map(|(_, t)| t.as_str())
        .unwrap_or("");
    let flat: String = pick.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = flat.chars().collect();
    let lower: String = flat.to_lowercase();
    let lower_chars: Vec<char> = lower.chars().collect();
    // Position (in chars) of the earliest query word.
    let mut best: Option<usize> = None;
    if lower_chars.len() == chars.len() {
        for w in &lower_words {
            if let Some(byte) = lower.find(w) {
                let pos = lower[..byte].chars().count();
                best = Some(best.map_or(pos, |b: usize| b.min(pos)));
            }
        }
    }
    let center = best.unwrap_or(0);
    let start = center.saturating_sub(70);
    let end = (center + 130).min(chars.len());
    let mut s: String = chars[start..end].iter().collect();
    if start > 0 {
        s = format!("…{s}");
    }
    if end < chars.len() {
        s.push('…');
    }
    s
}

fn search(query: &str, limit: usize) -> Result<Value> {
    let started = Instant::now();
    let dir = index_dir();
    if !dir.join("meta.json").exists() {
        bail!("no index yet: run `latch-index update`");
    }
    let index = Index::open_in_dir(&dir)?;
    let (_, f) = schema();
    let reader = index.reader()?;
    let searcher = reader.searcher();
    let mut parser = QueryParser::for_index(&index, vec![f.text]);
    parser.set_conjunction_by_default();
    let (q, _errors) = parser.parse_query_lenient(query);
    let hits = searcher.search(&q, &TopDocs::with_limit(MAX_HITS).order_by_score())?;

    struct Group {
        best: f32,
        count: u32,
        spoken: u32,
        doc: tantivy::DocAddress,
        latest: String,
    }
    let mut groups: HashMap<String, Group> = HashMap::new();
    for (score, addr) in &hits {
        let d: TantivyDocument = searcher.doc(*addr)?;
        let session = d.get_first(f.session).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let kind = d.get_first(f.kind).and_then(|v| v.as_str()).unwrap_or("");
        let ts = d.get_first(f.ts).and_then(|v| v.as_str()).unwrap_or("").to_string();
        // What people typed or read counts more than tool output.
        let spoken = kind == "prompt" || kind == "reply";
        let weighted = if spoken { score * 1.5 } else { *score };
        let g = groups.entry(session).or_insert(Group { best: 0.0, count: 0, spoken: 0, doc: *addr, latest: String::new() });
        g.count += 1;
        if spoken {
            g.spoken += 1;
        }
        if weighted > g.best {
            g.best = weighted;
            g.doc = *addr;
        }
        if ts > g.latest {
            g.latest = ts;
        }
    }
    let mut ranked: Vec<(String, Group)> = groups.into_iter().collect();
    ranked.sort_by(|a, b| {
        let sa = a.1.best * (1.0 + (a.1.count as f32).ln() * 0.15);
        let sb = b.1.best * (1.0 + (b.1.count as f32).ln() * 0.15);
        sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
    });
    let words = query_words(query);
    let mut sessions = Vec::new();
    for (session, g) in ranked.into_iter().take(limit) {
        let d: TantivyDocument = searcher.doc(g.doc)?;
        let file = d.get_first(f.file).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let offset = d.get_first(f.offset).and_then(|v| v.as_u64()).unwrap_or(0);
        let kind = d.get_first(f.kind).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let ts = d.get_first(f.ts).and_then(|v| v.as_str()).unwrap_or("").to_string();
        sessions.push(json!({
            "session": session,
            "score": g.best,
            "hits": g.count,
            "spoken_hits": g.spoken,
            "kind": kind,
            "ts": ts,
            "latest": g.latest,
            "file": file,
            "snippet": snippet(&file, offset, &kind, &words),
        }));
    }
    Ok(json!({
        "ok": true,
        "query": query,
        "total_hits": hits.len(),
        "capped": hits.len() >= MAX_HITS,
        "elapsed_ms": started.elapsed().as_millis() as u64,
        "sessions": sessions,
    }))
}

/* ---------- search by words and meaning (2026-10-09) ---------- */

/// Words that say how to search rather than what for ("find the session
/// where we talked about..."), dropped before the keyword search. The meaning
/// search still sees the whole question.
const FILLER: &[&str] = &[
    "a", "about", "after", "all", "also", "an", "and", "any", "are", "around", "as", "at", "be", "been", "before", "but", "by",
    "can", "chat", "chats", "conversation", "conversations", "could", "did", "discussed", "do", "does", "doing", "find", "for",
    "from", "had", "has", "have", "how", "i", "if", "in", "into", "involved", "involving", "is", "it", "its", "just", "like",
    "looking", "me", "mentioned", "my", "of", "on", "one", "ones", "or", "our", "related", "relating", "session", "sessions",
    "show", "so", "some", "specifically", "stuff", "talked", "that", "the", "their", "them", "there", "these", "thing", "things",
    "this", "those", "thread", "threads", "to", "us", "want", "was", "we", "were", "what", "when", "where", "which", "while",
    "who", "why", "will", "with", "work", "worked", "working", "would", "you", "your",
];

/// The keyword searches for a question: one per meaningful word, a phrase for
/// dotted or hyphenated names (forge.myrlin.io, claude-latch), quoted phrases
/// kept whole. At most 10.
fn lexical_terms(q: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    let mut rest = String::new();
    for (i, part) in q.split('"').enumerate() {
        if i % 2 == 1 {
            let p = part.trim();
            if !p.is_empty() {
                terms.push(format!("\"{p}\""));
            }
        } else {
            rest.push(' ');
            rest.push_str(part);
        }
    }
    for raw in rest.split_whitespace() {
        let w = raw.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
        if w.is_empty() || FILLER.contains(&w.as_str()) || (w.len() < 2 && !w.chars().all(|c| c.is_ascii_digit())) {
            continue;
        }
        let pieces: Vec<&str> = w.split(|c: char| !c.is_alphanumeric()).filter(|s| !s.is_empty()).collect();
        // Dots, hyphens and underscores join a name (forge.myrlin.io,
        // claude-latch): one phrase. Anything else (a slash) separates words.
        let named = pieces.len() > 1 && w.contains(['.', '-', '_']);
        let found: Vec<String> = if named {
            vec![format!("\"{}\"", pieces.join(" "))]
        } else {
            pieces.iter().filter(|p| !FILLER.contains(p) && (p.len() > 1 || p.chars().all(|c| c.is_ascii_digit()))).map(|p| p.to_string()).collect()
        };
        for t in found {
            if !terms.contains(&t) {
                terms.push(t);
            }
        }
    }
    terms.truncate(10);
    terms
}

struct LexSession {
    score: f32,
    coverage: usize,
    hits: u32,
    best: (f32, tantivy::DocAddress),
    /// The best prompt or reply (coverage, score, doc): shown as the snippet
    /// when it matches nearly as many terms, since a raw tool call reads poorly.
    spoken: Option<(usize, f32, tantivy::DocAddress)>,
    latest: String,
}

/// Sessions by words, scored by their best PASSAGE: how many of the terms
/// appear together in one prompt, reply or tool block, then how well. A
/// session where one reply talks about forge.myrlin.io marketing and growth
/// beats a 15 MB session that mentions each word somewhere. A second signal,
/// how many blocks match at least two terms, says how much of the session is
/// about it.
fn lexical_rank(searcher: &tantivy::Searcher, parser: &QueryParser, f: &Fields, terms: &[String]) -> Result<Vec<(String, LexSession)>> {
    use tantivy::collector::DocSetCollector;
    use tantivy::query::{BooleanQuery, Occur, Query};
    let mut sets = Vec::new();
    let mut clauses: Vec<(Occur, Box<dyn Query>)> = Vec::new();
    for term in terms {
        let (q, _) = parser.parse_query_lenient(term);
        sets.push(searcher.search(&q, &DocSetCollector)?);
        clauses.push((Occur::Should, q));
    }
    // Blocks ranked by BM25 over all terms (more terms matched, higher).
    let any = BooleanQuery::new(clauses);
    let hits = searcher.search(&any, &TopDocs::with_limit(6000).order_by_score())?;
    let mut sessions: HashMap<String, LexSession> = HashMap::new();
    for (score, addr) in hits {
        let coverage = sets.iter().filter(|s| s.contains(&addr)).count();
        let d: TantivyDocument = searcher.doc(addr)?;
        let session = d.get_first(f.session).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let kind = d.get_first(f.kind).and_then(|v| v.as_str()).unwrap_or("");
        let ts = d.get_first(f.ts).and_then(|v| v.as_str()).unwrap_or("");
        let spoken = kind == "prompt" || kind == "reply";
        let w = if spoken { score * 1.4 } else { score };
        let e = sessions.entry(session).or_insert(LexSession { score: 0.0, coverage: 0, hits: 0, best: (0.0, addr), spoken: None, latest: String::new() });
        e.hits += 1;
        if spoken && e.spoken.map_or(true, |(c, sc, _)| coverage > c || (coverage == c && w > sc)) {
            e.spoken = Some((coverage, w, addr));
        }
        if ts > e.latest.as_str() {
            e.latest = ts.to_string();
        }
        // Best passage: most terms together first, then score.
        if coverage > e.coverage || (coverage == e.coverage && w > e.score) {
            e.coverage = coverage;
            e.score = w;
            e.best = (w, addr);
        }
    }
    let mut ranked: Vec<(String, LexSession)> = sessions.into_iter().collect();
    let key = |s: &LexSession| s.score * (1.0 + (s.hits as f32).ln() * 0.05);
    ranked.sort_by(|a, b| b.1.coverage.cmp(&a.1.coverage).then(key(&b.1).partial_cmp(&key(&a.1)).unwrap_or(std::cmp::Ordering::Equal)));
    Ok(ranked)
}

/// What a search by words and meaning needs open: the keyword index reader,
/// the meaning index, and the query embedder (CPU; ~15 ms per query).
struct Searchers {
    index: Option<(Index, tantivy::IndexReader)>,
    store: std::sync::Arc<std::sync::RwLock<semantic::Store>>,
    embedder: std::sync::Arc<std::sync::Mutex<Option<fastembed::TextEmbedding>>>,
}

impl Searchers {
    fn open_index() -> Option<(Index, tantivy::IndexReader)> {
        let dir = index_dir();
        if !dir.join("meta.json").exists() {
            return None;
        }
        let index = Index::open_in_dir(&dir).ok()?;
        let reader = index.reader().ok()?;
        Some((index, reader))
    }
}

/// Reciprocal-rank fusion of the word ranking and the meaning ranking, per
/// session. A session found both ways rises; one found only by meaning still
/// shows, so "marketing and growth" finds GA4 and landing-page work.
fn hybrid(s: &mut Searchers, query: &str, limit: usize) -> Result<Value> {
    // Small K: the top of each ranking counts much more than its tail.
    const K: f32 = 20.0;
    let started = Instant::now();
    if s.index.is_none() {
        s.index = Searchers::open_index();
    }
    let terms = lexical_terms(query);
    let (_, f) = schema();
    let mut lex: Vec<(String, LexSession)> = Vec::new();
    let mut searcher_opt = None;
    if let Some((index, reader)) = &s.index {
        reader.reload().ok();
        let searcher = reader.searcher();
        if !terms.is_empty() {
            let parser = QueryParser::for_index(index, vec![f.text]);
            lex = lexical_rank(&searcher, &parser, &f, &terms)?;
        }
        searcher_opt = Some(searcher);
    }
    let lex_ms = started.elapsed().as_millis() as u64;

    let mut sem: Vec<(String, f32, semantic::ChunkMeta)> = Vec::new();
    let mut semantic_on = false;
    let qv = {
        let mut guard = s.embedder.lock().unwrap();
        match guard.as_mut() {
            Some(m) => semantic::embed_query(m, query).ok(),
            None => None,
        }
    };
    let store = s.store.read().unwrap();
    if let Some(qv) = qv {
        if store.len() > 0 {
            semantic_on = true;
            sem = store.search(&qv, 200);
        }
    }

    struct Fused {
        score: f32,
        lex: Option<usize>,
        sem: Option<usize>,
    }
    let mut fused: HashMap<String, Fused> = HashMap::new();
    for (r, (session, _)) in lex.iter().take(300).enumerate() {
        fused.entry(session.clone()).or_insert(Fused { score: 0.0, lex: None, sem: None }).lex = Some(r);
    }
    for (r, (session, _, _)) in sem.iter().enumerate() {
        fused.entry(session.clone()).or_insert(Fused { score: 0.0, lex: None, sem: None }).sem = Some(r);
    }
    // A long question in plain words leans on meaning; a few names lean on words.
    let wordy = query.split_whitespace().count() >= 6;
    let w_sem = if wordy { 1.25 } else { 0.9 };
    for v in fused.values_mut() {
        v.score = v.lex.map_or(0.0, |r| 1.0 / (K + r as f32)) + w_sem * v.sem.map_or(0.0, |r| 1.0 / (K + r as f32));
    }
    let mut ranked: Vec<(String, Fused)> = fused.into_iter().collect();
    ranked.sort_by(|a, b| b.1.score.partial_cmp(&a.1.score).unwrap_or(std::cmp::Ordering::Equal));

    let words = query_words(query);
    let mut out = Vec::new();
    for (session, fz) in ranked.into_iter().take(limit) {
        let mut sources = Vec::new();
        let mut snippet_text = String::new();
        let mut kind = String::new();
        let mut hits = 0u32;
        let mut latest = String::new();
        let mut file = String::new();
        if let (Some(r), Some(searcher)) = (fz.lex, searcher_opt.as_ref()) {
            sources.push("words");
            let ls = &lex[r].1;
            hits = ls.hits;
            latest = ls.latest.clone();
            let pick = match ls.spoken { Some((c, _, a)) if c + 1 >= ls.coverage => a, _ => ls.best.1 };
            let d: TantivyDocument = searcher.doc(pick)?;
            file = d.get_first(f.file).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let offset = d.get_first(f.offset).and_then(|v| v.as_u64()).unwrap_or(0);
            kind = d.get_first(f.kind).and_then(|v| v.as_str()).unwrap_or("").to_string();
            snippet_text = snippet(&file, offset, &kind, &words);
        }
        if let Some(r) = fz.sem {
            sources.push("meaning");
            if snippet_text.is_empty() {
                let c = sem[r].2;
                kind = semantic::kind_name(c.kind).to_string();
                file = store.file_of(c.fid).to_string();
                if c.kind != 2 {
                    snippet_text = snippet(&file, c.offset, &kind, &words);
                }
            }
        }
        out.push(json!({
            "session": session,
            "score": fz.score,
            "sources": sources,
            "meaning": fz.sem.map(|r| sem[r].1),
            "ranks": { "words": fz.lex, "meaning": fz.sem, "coverage": fz.lex.map(|r| lex[r].1.coverage) },
            "hits": hits,
            "kind": kind,
            "latest": latest,
            "file": file,
            "snippet": snippet_text,
        }));
    }
    Ok(json!({
        "ok": true,
        "query": query,
        "terms": terms,
        "semantic": semantic_on,
        "passages": store.len(),
        "words_ms": lex_ms,
        "elapsed_ms": started.elapsed().as_millis() as u64,
        "sessions": out,
    }))
}

/// Every transcript, Claude Code and Codex.
fn all_transcripts() -> Vec<(PathBuf, String, u64)> {
    let mut files = transcripts(&claude_dir().join("projects"));
    files.extend(codex_transcripts(&codex_dir().join("sessions")));
    files
}

/// `latch-index serve`: one long-running process for the app, so every search
/// reuses the open indexes and the loaded model instead of starting a process.
///
/// Commands, one JSON object per line on stdin:
///   {"id":1,"op":"search","query":"...","limit":60}   words + meaning
///   {"id":2,"op":"update"}       keyword update, then meaning update (background)
///   {"id":3,"op":"status"}
/// Replies carry the command's id. Background work reports with "ev" lines:
///   {"ev":"semantic","stage":"loading|embedding|ready","done":n,"total":n,"device":"gpu|cpu"}
///   {"ev":"updated","keyword":{...},"semantic":{...}}
fn serve() -> Result<()> {
    use std::sync::{Arc, Mutex, RwLock};
    let say = |v: Value| {
        let mut out = std::io::stdout().lock();
        let _ = std::io::Write::write_all(&mut out, format!("{v}\n").as_bytes());
        let _ = std::io::Write::flush(&mut out);
    };
    let store = Arc::new(RwLock::new(semantic::Store::open()));
    let embedder: Arc<Mutex<Option<fastembed::TextEmbedding>>> = Arc::new(Mutex::new(None));
    {
        // The query embedder loads in the background; searches use words only until then.
        let embedder = embedder.clone();
        std::thread::spawn(move || {
            if let Ok((m, _)) = semantic::load_model(true) {
                *embedder.lock().unwrap() = Some(m);
            }
        });
    }
    let updating = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut s = Searchers { index: Searchers::open_index(), store: store.clone(), embedder };
    say(json!({ "ev": "ready", "passages": store.read().unwrap().len() }));

    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(cmd) = serde_json::from_str::<Value>(&line) else { continue };
        let id = cmd.get("id").cloned().unwrap_or(Value::Null);
        match cmd.get("op").and_then(Value::as_str).unwrap_or("") {
            "search" => {
                let q = cmd.get("query").and_then(Value::as_str).unwrap_or("");
                let limit = cmd.get("limit").and_then(Value::as_u64).unwrap_or(60) as usize;
                let mut r = hybrid(&mut s, q, limit).unwrap_or_else(|e| json!({ "ok": false, "error": format!("{e:#}") }));
                r["id"] = id;
                say(r);
            }
            "status" => {
                let st = store.read().unwrap();
                let mut r = status().unwrap_or_else(|e| json!({ "ok": false, "error": format!("{e:#}") }));
                r["passages"] = json!(st.len());
                r["semantic_sessions"] = json!(st.session_count());
                r["updating"] = json!(updating.load(Ordering::Relaxed));
                r["id"] = id;
                say(r);
            }
            "update" => {
                if updating.swap(true, Ordering::SeqCst) {
                    say(json!({ "id": id, "ok": true, "busy": true }));
                    continue;
                }
                say(json!({ "id": id, "ok": true, "started": true }));
                let store = store.clone();
                let updating = updating.clone();
                std::thread::spawn(move || {
                    let say = |v: Value| {
                        let mut out = std::io::stdout().lock();
                        let _ = std::io::Write::write_all(&mut out, format!("{v}\n").as_bytes());
                        let _ = std::io::Write::flush(&mut out);
                    };
                    let keyword = update().unwrap_or_else(|e| json!({ "ok": false, "error": format!("{e:#}") }));
                    say(json!({ "ev": "keyword", "result": keyword }));
                    let sem = (|| -> Result<Value> {
                        // Copy the store, embed into the copy, then swap it in, so
                        // searches keep running on the old one during a long build.
                        let mut work = semantic::Store::open();
                        say(json!({ "ev": "semantic", "stage": "loading" }));
                        let (mut model, device) = semantic::load_model(false)?;
                        let started = Instant::now();
                        let mut last = Instant::now();
                        let (added, reset) = work.update(&mut model, &all_transcripts(), |done, total| {
                            if last.elapsed().as_millis() > 700 || done == total {
                                last = Instant::now();
                                say(json!({ "ev": "semantic", "stage": "embedding", "done": done, "total": total, "device": device }));
                            }
                        })?;
                        let n = work.len();
                        *store.write().unwrap() = work;
                        Ok(json!({ "ok": true, "added": added, "files_reset": reset, "passages": n, "device": device, "elapsed_ms": started.elapsed().as_millis() as u64 }))
                    })()
                    .unwrap_or_else(|e| json!({ "ok": false, "error": format!("{e:#}") }));
                    say(json!({ "ev": "semantic", "stage": "ready", "result": sem.clone() }));
                    say(json!({ "ev": "updated", "keyword": keyword, "semantic": sem }));
                    updating.store(false, Ordering::SeqCst);
                });
            }
            "quit" => break,
            other => say(json!({ "id": id, "ok": false, "error": format!("unknown op {other}") })),
        }
    }
    Ok(())
}

/// `latch-index semantic-update`: builds or updates the meaning index from the command line.
fn semantic_update(cpu: bool) -> Result<Value> {
    let mut store = semantic::Store::open();
    let (mut model, device) = semantic::load_model(cpu)?;
    let started = Instant::now();
    let mut last = Instant::now();
    let (added, reset) = store.update(&mut model, &all_transcripts(), |done, total| {
        if last.elapsed().as_secs() >= 5 || done == total {
            last = Instant::now();
            eprintln!("{done}/{total} passages ({device}, {:.0}/s)", done as f64 / started.elapsed().as_secs_f64().max(0.001));
        }
    })?;
    Ok(json!({ "ok": true, "added": added, "files_reset": reset, "passages": store.len(), "sessions": store.session_count(), "device": device, "elapsed_ms": started.elapsed().as_millis() as u64 }))
}

fn status() -> Result<Value> {
    let dir = index_dir();
    let state = load_state(&dir);
    let mut bytes = 0u64;
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    let docs = if dir.join("meta.json").exists() {
        let index = Index::open_in_dir(&dir)?;
        index.reader()?.searcher().num_docs()
    } else {
        0
    };
    Ok(json!({ "ok": true, "dir": dir, "blocks": docs, "files": state.files.len(), "bytes_on_disk": bytes }))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("update") => update(),
        Some("status") => status(),
        Some("search") => {
            let mut limit = 40usize;
            let mut words = Vec::new();
            let mut it = args.iter().skip(1);
            while let Some(a) = it.next() {
                if a == "--limit" {
                    limit = it.next().and_then(|v| v.parse().ok()).unwrap_or(limit);
                } else {
                    words.push(a.clone());
                }
            }
            if words.is_empty() {
                Err(anyhow::anyhow!("usage: latch-index search <words> [--limit N]"))
            } else {
                search(&words.join(" "), limit)
            }
        }
        Some("serve") => serve().map(|_| json!({ "ok": true, "stopped": true })),
        Some("semantic-update") => semantic_update(args.iter().any(|a| a == "--cpu")),
        Some("hybrid") => {
            let words: Vec<String> = args.iter().skip(1).cloned().collect();
            let mut s = Searchers {
                index: Searchers::open_index(),
                store: std::sync::Arc::new(std::sync::RwLock::new(semantic::Store::open())),
                embedder: std::sync::Arc::new(std::sync::Mutex::new(semantic::load_model(true).ok().map(|(m, _)| m))),
            };
            hybrid(&mut s, &words.join(" "), 20)
        }
        _ => Err(anyhow::anyhow!("usage: latch-index update | search <words> [--limit N] | status | serve | hybrid <words> | semantic-update [--cpu]")),
    };
    match result {
        Ok(v) => println!("{v}"),
        Err(e) => {
            println!("{}", json!({ "ok": false, "error": format!("{e:#}") }));
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_prompts_replies_tools_and_results_but_not_injected_text() {
        let user: Value = serde_json::from_str(r#"{"type":"user","message":{"content":"hello <system-reminder>secret</system-reminder> world"}}"#).unwrap();
        assert_eq!(extract(&user), vec![("prompt".to_string(), "hello  world".to_string())]);
        let meta: Value = serde_json::from_str(r#"{"type":"user","isMeta":true,"message":{"content":"skill text"}}"#).unwrap();
        assert!(extract(&meta).is_empty());
        let cmd: Value = serde_json::from_str(r#"{"type":"user","message":{"content":"<command-name>/model</command-name>"}}"#).unwrap();
        assert!(extract(&cmd).is_empty());
        let asst: Value = serde_json::from_str(
            r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"done"},{"type":"tool_use","name":"Bash","input":{"command":"ls -la","timeout":5}}]}}"#,
        )
        .unwrap();
        assert_eq!(
            extract(&asst),
            vec![("agent-reply".to_string(), "done".to_string()), ("agent-tool".to_string(), "Bash ls -la".to_string())]
        );
        let result: Value =
            serde_json::from_str(r#"{"type":"user","message":{"content":[{"type":"tool_result","content":[{"type":"text","text":"out"}]}]}}"#).unwrap();
        assert_eq!(extract(&result), vec![("result".to_string(), "out".to_string())]);
    }

    #[test]
    fn query_words_drop_operators_and_quotes() {
        assert_eq!(query_words("\"ground truth\" AND SignalSentry"), vec!["ground", "truth", "signalsentry"]);
    }

    #[test]
    fn lexical_terms_drop_filler_and_keep_names_whole() {
        assert_eq!(
            lexical_terms("i want to find a conversation/session that was involved in forge.myrlin.io, specifically the marketing and growth related sessions"),
            vec!["\"forge myrlin io\"", "marketing", "growth"]
        );
        assert_eq!(lexical_terms("\"ground truth\" SignalSentry"), vec!["\"ground truth\"", "signalsentry"]);
    }

    #[test]
    fn cap_respects_char_boundaries() {
        assert_eq!(cap("héllo", 2), "h");
    }
}

#[cfg(test)]
mod codex_tests {
    use super::*;

    #[test]
    fn extracts_codex_prompts_replies_and_tools_but_not_injected_instructions() {
        let user: Value = serde_json::from_str(r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"fix the walk detector"}]}}"#).unwrap();
        assert_eq!(extract_any(&user), vec![("prompt".to_string(), "fix the walk detector".to_string())]);
        let agents: Value = serde_json::from_str(r##"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions\n..."}]}}"##).unwrap();
        assert!(extract_any(&agents).is_empty());
        let call: Value = serde_json::from_str(r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"cmd\":\"ls\"}"}}"#).unwrap();
        assert_eq!(extract_any(&call), vec![("tool".to_string(), "shell {\"cmd\":\"ls\"}".to_string())]);
        let meta: Value = serde_json::from_str(r#"{"type":"session_meta","payload":{"id":"x"}}"#).unwrap();
        assert!(extract_any(&meta).is_empty());
    }
}
