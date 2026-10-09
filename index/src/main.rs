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
//! Env: LATCH_INDEX_DIR (default ~/.claude/latch/index), CLAUDE_CONFIG_DIR.

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
        if finder_user.find(&line).is_none() && finder_assistant.find(&line).is_none() {
            continue;
        }
        let Ok(entry) = serde_json::from_slice::<Value>(&line) else { continue };
        let ts = entry.get("timestamp").and_then(Value::as_str).unwrap_or("").to_string();
        for (kind, text) in extract(&entry) {
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

    let files = transcripts(&claude_dir().join("projects"));
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
    let blocks = extract(&entry);
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
        _ => Err(anyhow::anyhow!("usage: latch-index update | search <words> [--limit N] | status")),
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
    fn cap_respects_char_boundaries() {
        assert_eq!(cap("héllo", 2), "h");
    }
}
