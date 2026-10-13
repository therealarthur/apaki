//! The meaning index: finds sessions by what they were about, not only by the
//! words in them (Arthur, 2026-10-09: "i want to find a conversation that was
//! involved in forge.myrlin.io, specifically the marketing and growth related
//! sessions ... can we write an algorithm or chunking/embedding process here
//! that's fast?").
//!
//! Why this is fast enough to run as you type, measured on this PC:
//!   - Of 20.2 GB of transcripts, only ~93 MB is spoken text (typed prompts and
//!     replies); the rest is tool output, file contents and metadata. Only the
//!     spoken text of main sessions is embedded, so the whole index is about
//!     50-80k passages.
//!   - Passages are embedded once, with bge-small-en-v1.5 (384 dimensions) on
//!     the GPU through DirectML: ~360 passages/s on the RTX 3080 (67/s on the
//!     CPU), so the first build is a few minutes and later updates embed only
//!     the passages that were appended.
//!   - Vectors are stored as int8 with one scale each (~30 MB). A query is one
//!     embedding (~15 ms on the CPU) and a brute-force dot product over every
//!     passage (a few ms), so no approximate-nearest-neighbour structure is
//!     needed at this size.
//!
//! Chunking: per transcript, prompts and replies are read in order (each capped
//! at BLOCK_CHARS, so a long paste counts by its start) and joined into windows
//! of about WINDOW_CHARS. Transcripts only grow, so each file keeps its read
//! offset and its unfinished window; the unfinished window is also embedded as
//! a provisional "tail" passage, replaced on the next update, so the newest
//! turns are searchable at once. A session's titles (ai-title, custom-title)
//! become passages of their own.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result};
use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DIM: usize = 384;
/// Bump when chunking or the model changes: the meaning index is rebuilt.
const SEM_VERSION: u32 = 1;
const WINDOW_CHARS: usize = 900;
const BLOCK_CHARS: usize = 1600;
const EMBED_BATCH: usize = 64;
/// bge-small-en-v1.5's instruction for short search queries.
const QUERY_PREFIX: &str = "Represent this sentence for searching relevant passages: ";

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
pub struct ChunkMeta {
    pub sid: u32,
    pub fid: u32,
    /// Byte offset of the transcript line the passage starts at (for snippets).
    pub offset: u64,
    /// 0 prompt, 1 reply, 2 title.
    pub kind: u8,
    pub tail: bool,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct FileProgress {
    offset: u64,
    pending: String,
    pending_offset: u64,
    pending_kind: u8,
    titles: Vec<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct Meta {
    version: u32,
    model: String,
    sessions: Vec<String>,
    files: Vec<String>,
    chunks: Vec<ChunkMeta>,
    progress: HashMap<String, FileProgress>,
}

/// The loaded meaning index.
pub struct Store {
    dir: PathBuf,
    meta: Meta,
    sids: HashMap<String, u32>,
    fids: HashMap<String, u32>,
    vecs: Vec<i8>,
    scales: Vec<f32>,
}

pub fn kind_name(k: u8) -> &'static str {
    match k {
        0 => "prompt",
        1 => "reply",
        _ => "title",
    }
}

fn model_dir() -> PathBuf {
    std::env::var_os("LATCH_MODEL_DIR").map(PathBuf::from).unwrap_or_else(|| crate::claude_dir().join("latch").join("models"))
}

/// Loads the embedding model: DirectML (GPU) first unless `cpu`, falling back
/// to the CPU when no GPU is usable. Returns the model and the device used.
pub fn load_model(cpu: bool) -> Result<(TextEmbedding, &'static str)> {
    let dir = model_dir();
    fs::create_dir_all(&dir).ok();
    let base = || TextInitOptions::new(EmbeddingModel::BGESmallENV15).with_cache_dir(dir.clone()).with_show_download_progress(false).with_max_length(256);
    // DirectML exists on Windows only (macOS port, 2026-10-12: Cargo.toml adds its features for Windows alone);
    // every other platform embeds on the CPU.
    #[cfg(windows)]
    if !cpu && std::env::var_os("LATCH_EMBED_CPU").is_none() {
        let gpu = base().with_execution_providers(vec![ort::ep::DirectML::default().build().error_on_failure()]);
        if let Ok(m) = TextEmbedding::try_new(gpu) {
            return Ok((m, "gpu"));
        }
    }
    #[cfg(not(windows))]
    let _ = cpu;
    let threads = std::thread::available_parallelism().map(|n| (n.get() / 3).max(2)).unwrap_or(4);
    Ok((TextEmbedding::try_new(base().with_intra_threads(threads)).context("loading the embedding model")?, "cpu"))
}

fn quantize(v: &[f32]) -> (Vec<i8>, f32) {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6);
    let max = v.iter().fold(0f32, |m, x| m.max((x / norm).abs())).max(1e-6);
    let scale = max / 127.0;
    (v.iter().map(|x| ((x / norm) / scale).round().clamp(-127.0, 127.0) as i8).collect(), scale)
}

/// Embeds one search query (normalized).
pub fn embed_query(model: &mut TextEmbedding, query: &str) -> Result<Vec<f32>> {
    let mut v = model.embed(vec![format!("{QUERY_PREFIX}{query}")], None)?.pop().unwrap_or_default();
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6);
    for x in &mut v {
        *x /= norm;
    }
    Ok(v)
}

impl Store {
    /// Its own folder next to the keyword index (not inside it: a keyword
    /// format change clears that folder). LATCH_SEMANTIC_DIR overrides.
    pub fn dir() -> PathBuf {
        std::env::var_os("LATCH_SEMANTIC_DIR").map(PathBuf::from).unwrap_or_else(|| crate::claude_dir().join("latch").join("semantic"))
    }

    /// Opens the meaning index (empty when missing or from an older version).
    pub fn open() -> Store {
        let dir = Self::dir();
        let mut meta: Meta = fs::read(dir.join("meta.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let mut vecs = Vec::new();
        let mut scales = Vec::new();
        let ok = meta.version == SEM_VERSION && read_vectors(&dir.join("vectors.bin"), meta.chunks.len(), &mut vecs, &mut scales).is_ok();
        if !ok {
            meta = Meta { version: SEM_VERSION, model: "bge-small-en-v1.5".into(), ..Default::default() };
            vecs.clear();
            scales.clear();
        }
        let sids = meta.sessions.iter().enumerate().map(|(i, s)| (s.clone(), i as u32)).collect();
        let fids = meta.files.iter().enumerate().map(|(i, s)| (s.clone(), i as u32)).collect();
        Store { dir, meta, sids, fids, vecs, scales }
    }

    pub fn len(&self) -> usize {
        self.meta.chunks.len()
    }

    pub fn session_count(&self) -> usize {
        self.meta.sessions.len()
    }

    fn sid(&mut self, s: &str) -> u32 {
        if let Some(i) = self.sids.get(s) {
            return *i;
        }
        let i = self.meta.sessions.len() as u32;
        self.meta.sessions.push(s.to_string());
        self.sids.insert(s.to_string(), i);
        i
    }

    fn fid(&mut self, f: &str) -> u32 {
        if let Some(i) = self.fids.get(f) {
            return *i;
        }
        let i = self.meta.files.len() as u32;
        self.meta.files.push(f.to_string());
        self.fids.insert(f.to_string(), i);
        i
    }

    pub fn file_of(&self, fid: u32) -> &str {
        self.meta.files.get(fid as usize).map(String::as_str).unwrap_or("")
    }

    pub fn session_of(&self, sid: u32) -> &str {
        self.meta.sessions.get(sid as usize).map(String::as_str).unwrap_or("")
    }

    /// Drops every passage matching `pred` (vectors and metadata together).
    fn retain(&mut self, pred: impl Fn(&ChunkMeta) -> bool) {
        let mut chunks = Vec::with_capacity(self.meta.chunks.len());
        let mut vecs = Vec::with_capacity(self.vecs.len());
        let mut scales = Vec::with_capacity(self.scales.len());
        for (i, c) in self.meta.chunks.iter().enumerate() {
            if pred(c) {
                chunks.push(*c);
                vecs.extend_from_slice(&self.vecs[i * DIM..(i + 1) * DIM]);
                scales.push(self.scales[i]);
            }
        }
        self.meta.chunks = chunks;
        self.vecs = vecs;
        self.scales = scales;
    }

    pub fn save(&self) -> Result<()> {
        fs::create_dir_all(&self.dir)?;
        let tmp = self.dir.join("vectors.bin.tmp");
        {
            let mut f = std::io::BufWriter::new(File::create(&tmp)?);
            f.write_all(&(self.meta.chunks.len() as u32).to_le_bytes())?;
            f.write_all(&(DIM as u32).to_le_bytes())?;
            for s in &self.scales {
                f.write_all(&s.to_le_bytes())?;
            }
            let bytes: Vec<u8> = self.vecs.iter().map(|x| *x as u8).collect();
            f.write_all(&bytes)?;
        }
        let mtmp = self.dir.join("meta.json.tmp");
        fs::write(&mtmp, serde_json::to_vec(&self.meta)?)?;
        fs::rename(&tmp, self.dir.join("vectors.bin"))?;
        fs::rename(&mtmp, self.dir.join("meta.json"))?;
        Ok(())
    }

    /// Brings the meaning index up to date with `files` (path, session, size).
    /// Only main transcripts are embedded (not subagents or workflows).
    /// `progress(done, total)` is called as passages are embedded.
    pub fn update(&mut self, model: &mut TextEmbedding, files: &[(PathBuf, String, u64)], mut progress: impl FnMut(usize, usize)) -> Result<(usize, usize)> {
        let main: Vec<&(PathBuf, String, u64)> = files.iter().filter(|(p, s, _)| is_main(p, s)).collect();
        let on_disk: std::collections::HashSet<String> = main.iter().map(|(p, _, _)| p.to_string_lossy().to_string()).collect();

        // Transcripts that are gone, or shrank (rewritten), lose their passages.
        let mut reset: Vec<String> = self.meta.progress.keys().filter(|k| !on_disk.contains(*k)).cloned().collect();
        for (p, _, size) in &main {
            let key = p.to_string_lossy().to_string();
            if self.meta.progress.get(&key).is_some_and(|pr| *size < pr.offset) {
                reset.push(key);
            }
        }
        if !reset.is_empty() {
            let gone: std::collections::HashSet<u32> = reset.iter().filter_map(|k| self.fids.get(k).copied()).collect();
            self.retain(|c| !gone.contains(&c.fid));
            for k in &reset {
                self.meta.progress.remove(k);
            }
        }

        // New passages from what was appended since last time.
        let mut todo: Vec<(ChunkMeta, String)> = Vec::new();
        let mut changed_fids = std::collections::HashSet::new();
        for (p, session, size) in &main {
            let key = p.to_string_lossy().to_string();
            let mut pr = self.meta.progress.get(&key).cloned().unwrap_or_default();
            if *size == pr.offset {
                continue;
            }
            let sid = self.sid(session);
            let fid = self.fid(&key);
            let folder = p.parent().and_then(|d| d.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let new = read_passages(p, &mut pr, &folder).unwrap_or_default();
            changed_fids.insert(fid);
            for (offset, kind, text) in new {
                todo.push((ChunkMeta { sid, fid, offset, kind, tail: false }, text));
            }
            if !pr.pending.trim().is_empty() {
                todo.push((ChunkMeta { sid, fid, offset: pr.pending_offset, kind: pr.pending_kind, tail: true }, pr.pending.clone()));
            }
            self.meta.progress.insert(key, pr);
        }
        // The provisional tail of every changed file is replaced.
        self.retain(|c| !(c.tail && changed_fids.contains(&c.fid)));

        let total = todo.len();
        let mut done = 0usize;
        let mut since_save = Instant::now();
        for batch in todo.chunks(EMBED_BATCH) {
            let texts: Vec<String> = batch.iter().map(|(_, t)| t.clone()).collect();
            let vs = model.embed(texts, Some(EMBED_BATCH))?;
            for ((meta, _), v) in batch.iter().zip(vs) {
                let (q, s) = quantize(&v);
                self.vecs.extend_from_slice(&q);
                self.scales.push(s);
                self.meta.chunks.push(*meta);
            }
            done += batch.len();
            progress(done, total);
            // A long first build is saved as it goes, so it resumes if stopped.
            if since_save.elapsed().as_secs() > 20 {
                self.save()?;
                since_save = Instant::now();
            }
        }
        if total > 0 || !reset.is_empty() {
            self.save()?;
        }
        Ok((total, reset.len()))
    }

    /// Sessions by meaning: (session, score, best passage) best first.
    pub fn search(&self, q: &[f32], limit: usize) -> Vec<(String, f32, ChunkMeta)> {
        use rayon::prelude::*;
        if q.len() != DIM || self.meta.chunks.is_empty() {
            return vec![];
        }
        let scores: Vec<f32> = self
            .vecs
            .par_chunks(DIM)
            .zip(self.scales.par_iter())
            .map(|(v, s)| v.iter().zip(q).map(|(a, b)| *a as f32 * b).sum::<f32>() * s)
            .collect();
        // Per session, three signals: its best passage (a part that is about
        // this), its average passage (how much of the session is about this,
        // which keeps huge sessions that mention everything from winning), and
        // its best title. Dot products are linear, so the average passage score
        // is the score against the session's mean vector.
        struct Agg {
            best: f32,
            best_i: usize,
            sum: f32,
            n: u32,
            title: f32,
        }
        let mut agg: HashMap<u32, Agg> = HashMap::new();
        for (i, sc) in scores.iter().enumerate() {
            let c = &self.meta.chunks[i];
            let e = agg.entry(c.sid).or_insert(Agg { best: f32::MIN, best_i: i, sum: 0.0, n: 0, title: f32::MIN });
            if c.kind == 2 {
                e.title = e.title.max(*sc);
            } else {
                e.sum += sc;
                e.n += 1;
            }
            if *sc > e.best {
                e.best = *sc;
                e.best_i = i;
            }
        }
        let mut ranked: Vec<(u32, f32, usize)> = agg
            .into_iter()
            .map(|(sid, a)| {
                let mean = if a.n > 0 { a.sum / a.n as f32 } else { a.best };
                let title = if a.title > f32::MIN { a.title } else { mean };
                (sid, 0.5 * a.best + 0.3 * mean + 0.2 * title, a.best_i)
            })
            .collect();
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        ranked.into_iter().take(limit).map(|(sid, sc, i)| (self.session_of(sid).to_string(), sc, self.meta.chunks[i])).collect()
    }
}

fn read_vectors(path: &Path, n: usize, vecs: &mut Vec<i8>, scales: &mut Vec<f32>) -> Result<()> {
    let mut f = BufReader::new(File::open(path)?);
    let mut u = [0u8; 4];
    f.read_exact(&mut u)?;
    let count = u32::from_le_bytes(u) as usize;
    f.read_exact(&mut u)?;
    let dim = u32::from_le_bytes(u) as usize;
    anyhow::ensure!(count == n && dim == DIM, "vector file does not match the metadata");
    let mut sb = vec![0u8; count * 4];
    f.read_exact(&mut sb)?;
    *scales = sb.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    let mut vb = vec![0u8; count * DIM];
    f.read_exact(&mut vb)?;
    *vecs = vb.into_iter().map(|b| b as i8).collect();
    Ok(())
}

/// A main session transcript (embedded), as opposed to a subagent or workflow
/// run stored under the session's folder.
fn is_main(path: &Path, session: &str) -> bool {
    if session.starts_with("codex:") {
        return true;
    }
    path.file_stem().is_some_and(|s| s.to_string_lossy() == session)
}

/// The title entries Claude Code writes into a transcript.
fn title_of(entry: &Value) -> Option<String> {
    let t = entry.get("type").and_then(Value::as_str)?;
    let v = match t {
        "ai-title" => entry.get("aiTitle"),
        "custom-title" => entry.get("customTitle"),
        "summary" => entry.get("summary"),
        _ => None,
    }?;
    v.as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Reads `path` from `pr.offset` and returns finished passages as
/// (line offset, kind, text); the unfinished window stays in `pr.pending`.
fn read_passages(path: &Path, pr: &mut FileProgress, folder: &str) -> Result<Vec<(u64, u8, String)>> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(pr.offset))?;
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut out = Vec::new();
    let mut line = Vec::with_capacity(64 * 1024);
    let finders = [
        memchr::memmem::Finder::new(b"\"type\":\"user\""),
        memchr::memmem::Finder::new(b"\"type\":\"assistant\""),
        memchr::memmem::Finder::new(b"\"type\":\"response_item\""),
        memchr::memmem::Finder::new(b"\"type\":\"ai-title\""),
        memchr::memmem::Finder::new(b"\"type\":\"custom-title\""),
    ];
    let mut offset = pr.offset;
    loop {
        line.clear();
        let n = reader.read_until(b'\n', &mut line)?;
        if n == 0 || line.last() != Some(&b'\n') {
            break;
        }
        let at = offset;
        offset += n as u64;
        if !finders.iter().any(|f| f.find(&line).is_some()) {
            continue;
        }
        let Ok(entry) = serde_json::from_slice::<Value>(&line) else { continue };
        if let Some(t) = title_of(&entry) {
            if !pr.titles.contains(&t) {
                pr.titles.push(t.clone());
                out.push((at, 2, format!("{t} ({})", folder.replace('-', " "))));
            }
            continue;
        }
        for (kind, text) in crate::extract_any(&entry) {
            let k = match kind.as_str() {
                "prompt" => 0u8,
                "reply" => 1u8,
                _ => continue,
            };
            let t: String = crate::cap(text.trim(), BLOCK_CHARS).split_whitespace().collect::<Vec<_>>().join(" ");
            if t.len() < 12 {
                continue;
            }
            if pr.pending.is_empty() {
                pr.pending_offset = at;
                pr.pending_kind = k;
            } else {
                pr.pending.push('\n');
            }
            pr.pending.push_str(if k == 0 { "User: " } else { "Assistant: " });
            pr.pending.push_str(&t);
            if pr.pending.len() >= WINDOW_CHARS {
                out.push((pr.pending_offset, pr.pending_kind, std::mem::take(&mut pr.pending)));
            }
        }
    }
    pr.offset = offset;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantized_vectors_keep_their_direction() {
        let v: Vec<f32> = (0..DIM).map(|i| (i as f32 * 0.37).sin()).collect();
        let (q, s) = quantize(&v);
        let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        let back: f32 = v.iter().zip(&q).map(|(a, b)| (a / norm) * (*b as f32 * s)).sum();
        assert!(back > 0.999, "self-similarity after int8 was {back}");
    }

    #[test]
    fn passages_are_windows_of_spoken_text_with_titles_apart() {
        let dir = std::env::temp_dir().join(format!("latch-sem-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("abc.jsonl");
        let long = "growth funnel ".repeat(80);
        let lines = [
            r#"{"type":"user","message":{"content":"Plan the Forge marketing site launch and the GA4 funnel"}}"#.to_string(),
            r#"{"type":"ai-title","aiTitle":"Forge growth plan"}"#.to_string(),
            format!(r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"{long}"}},{{"type":"tool_use","name":"Bash","input":{{"command":"ls"}}}}]}}}}"#),
            r#"{"type":"user","message":{"content":"short tail question here"}}"#.to_string(),
        ];
        fs::write(&p, lines.join("\n") + "\n").unwrap();
        let mut pr = FileProgress::default();
        let out = read_passages(&p, &mut pr, "C--Users-Arthur-Projects-forge").unwrap();
        assert_eq!(out.len(), 2, "one title passage and one full window");
        assert_eq!(out[0].1, 2);
        assert!(out[0].2.starts_with("Forge growth plan"));
        assert!(out[1].2.starts_with("User: Plan the Forge"));
        assert!(!out[1].2.contains("Bash"), "tool calls are not embedded");
        assert!(pr.pending.contains("short tail question"), "the unfinished window waits for more");
        assert_eq!(pr.offset, fs::metadata(&p).unwrap().len());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn only_main_transcripts_are_embedded() {
        assert!(is_main(Path::new("C:/x/proj/abc.jsonl"), "abc"));
        assert!(!is_main(Path::new("C:/x/proj/abc/subagents/agent-1.jsonl"), "abc"));
        assert!(is_main(Path::new("C:/x/rollout-1.jsonl"), "codex:1"));
    }
}
