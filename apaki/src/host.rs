//! host.rs: the window's side of the engine's background host.
//!
//! WHY (Arthur, 2026-10-10): "apaki closing should not close the claude
//! sessions that are open - they should all just move to the background
//! until they stop naturally or are stopped". The engine now runs as a
//! detached per-user host (apaki/engine/host.js has the whole design); this
//! window finds it, starts it when none answers, and authenticates.
//!
//! - The host writes ~/.claude/latch/apaki-host.json (apaki-host.<app id>.json
//!   for other app ids) with its port and a random token. This side passes the
//!   exact path to a host it starts (APAKI_HOST_FILE), so both always agree.
//! - Handshake on 127.0.0.1: the host sends a nonce; this side answers with
//!   its own nonce and HMAC-SHA256(token, "apaki-host/v1 client\n" app \n SN \n CN \n window);
//!   the host answers ok with HMAC-SHA256(token, "apaki-host/v1 server\n" app \n CN \n SN),
//!   which is checked here. The token never crosses the connection, and a
//!   process sitting on a dead host's port learns nothing.
//! - Starting a host: `node engine.js --host`, with no window, in its own
//!   process group, out of any job this window is in when Windows allows it,
//!   so closing (or crashing) the window never ends it.

use std::collections::hash_map::RandomState;
use std::fs::File;
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const DEFAULT_APP_ID: &str = "io.myrlin.apaki";
const PROTOCOL: u64 = 1;
const CONNECT_TIMEOUT: Duration = Duration::from_millis(1500);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// What the host file says.
pub struct HostInfo {
    pub port: u16,
    pub pid: u32,
    pub token: String,
}

/// A connection that passed the handshake: the stream to write to, its
/// reader (which may already hold the first events), and the host's ok line.
pub struct Connected {
    pub stream: TcpStream,
    pub reader: BufReader<TcpStream>,
    pub ok: Value,
}

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default()
}

/// ~/.claude/latch, as the engine computes it (CLAUDE_CONFIG_DIR moves ~/.claude).
pub fn latch_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| home().join(".claude")).join("latch")
}

/// The host file of one app id (same names as host.js hostFile).
pub fn host_file(app_id: &str) -> PathBuf {
    if app_id == DEFAULT_APP_ID {
        return latch_dir().join("apaki-host.json");
    }
    let safe: String = app_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' { c } else { '_' }).collect();
    latch_dir().join(format!("apaki-host.{safe}.json"))
}

pub fn read_info(file: &Path) -> Option<HostInfo> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()?;
    Some(HostInfo {
        port: u16::try_from(v.get("port")?.as_u64()?).ok()?,
        pid: v.get("pid").and_then(Value::as_u64).and_then(|p| u32::try_from(p).ok()).unwrap_or(0),
        token: v.get("token")?.as_str()?.to_string(),
    })
}

/// Which build of the engine this window would start: size and modification
/// time (whole seconds) of engine.js, as host.js engineStamp computes it.
pub fn engine_stamp(script: &Path) -> String {
    let Ok(m) = std::fs::metadata(script) else { return String::new() };
    let secs = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
    format!("{}-{}", m.len(), secs)
}

/// Two engine roots are the same folder (case, slashes and a \\?\ prefix aside).
pub fn same_root(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim_start_matches(r"\\?\").replace('/', "\\").trim_end_matches('\\').to_lowercase();
    norm(a) == norm(b)
}

/* ---------- HMAC-SHA256 ---------- */

fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let inner = Sha256::new().chain_update(ipad).chain_update(msg).finalize();
    let outer = Sha256::new().chain_update(opad).chain_update(inner).finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&outer);
    out
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 15) as usize] as char);
    }
    s
}

/// Constant-time comparison (the host's proof).
fn same_bytes(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A fresh nonce: never repeats in this process, and is not guessable from outside it.
fn nonce() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut h = Sha256::new();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    h.update(now.to_le_bytes());
    h.update(std::process::id().to_le_bytes());
    h.update(COUNTER.fetch_add(1, Ordering::Relaxed).to_le_bytes());
    // RandomState is seeded from the OS's random source.
    for i in 0..4u64 {
        let mut x = RandomState::new().build_hasher();
        x.write_u64(i);
        h.update(x.finish().to_le_bytes());
    }
    hex(&h.finalize())
}

/* ---------- connecting ---------- */

fn read_json_line(reader: &mut BufReader<TcpStream>) -> Result<Value, String> {
    let mut line = String::new();
    let n = reader.read_line(&mut line).map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("the host closed the connection".into());
    }
    serde_json::from_str(line.trim_end()).map_err(|_| "not an Apaki host".to_string())
}

/// Connects to the host named in `info` as the window of `app_id` and authenticates.
pub fn connect(info: &HostInfo, app_id: &str) -> Result<Connected, String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], info.port));
    let stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|e| e.to_string())?;
    let _ = stream.set_nodelay(true);
    stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let hello = read_json_line(&mut reader)?;
    let server_nonce = hello.get("nonce").and_then(Value::as_str).unwrap_or("").to_string();
    if hello.get("t").and_then(Value::as_str) != Some("apaki-host") || server_nonce.is_empty() {
        return Err("not an Apaki host".into());
    }
    // Another app id's host (a dev build and the installed app keep separate ones).
    if hello.get("app").and_then(Value::as_str) != Some(app_id) {
        return Err("that host belongs to another Apaki".into());
    }
    let client_nonce = nonce();
    let key = info.token.as_bytes();
    let mac = hex(&hmac_sha256(key, format!("apaki-host/v1 client\n{app_id}\n{server_nonce}\n{client_nonce}\nwindow").as_bytes()));
    let auth = json!({ "t": "auth", "v": PROTOCOL, "role": "window", "nonce": client_nonce, "mac": mac });
    let mut w = stream.try_clone().map_err(|e| e.to_string())?;
    w.write_all(format!("{auth}\n").as_bytes()).and_then(|_| w.flush()).map_err(|e| e.to_string())?;
    let ok = read_json_line(&mut reader)?;
    let want = hex(&hmac_sha256(key, format!("apaki-host/v1 server\n{app_id}\n{client_nonce}\n{server_nonce}").as_bytes()));
    let got = ok.get("mac").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    if ok.get("t").and_then(Value::as_str) != Some("ok") || !same_bytes(got.as_bytes(), want.as_bytes()) {
        return Err("the host did not prove itself".into());
    }
    stream.set_read_timeout(None).map_err(|e| e.to_string())?;
    // The reader's handle too (2026-10-11): on Windows try_clone makes a second socket handle and a read timeout
    // belongs to each handle, so clearing it on `stream` left the reader with the handshake's 5 s. Every quiet
    // moment then ended the connection (os error 10060, TimedOut) and the window reconnected over and over.
    reader.get_ref().set_read_timeout(None).map_err(|e| e.to_string())?;
    Ok(Connected { stream, reader, ok })
}

/* ---------- starting a host ---------- */

/// Starts `node engine.js --host`, detached from this window. Its stderr goes to the engine log.
pub fn spawn_host(node: &Path, script: &Path, root: &Path, envs: &[(&str, std::ffi::OsString)], log: &File) -> Result<Child, String> {
    let make = || -> Result<Command, String> {
        let mut cmd = Command::new(node);
        cmd.arg(script).arg("--host").current_dir(root);
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::from(log.try_clone().map_err(|e| e.to_string())?));
        for (k, v) in envs {
            cmd.env(k, v);
        }
        Ok(cmd)
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        let base = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;
        let mut cmd = make()?;
        cmd.creation_flags(base | CREATE_BREAKAWAY_FROM_JOB);
        match cmd.spawn() {
            Ok(child) => return Ok(child),
            // Inside a job that does not allow breaking away (access denied): start within it.
            Err(e) if e.raw_os_error() == Some(5) => {}
            Err(e) => return Err(e.to_string()),
        }
        let mut cmd = make()?;
        cmd.creation_flags(base);
        cmd.spawn().map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::process::CommandExt;
        let mut cmd = make()?;
        cmd.process_group(0);
        cmd.spawn().map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_matches_rfc4231_case_2() {
        // RFC 4231 test case 2: key "Jefe", data "what do ya want for nothing?".
        let mac = hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?"));
        assert_eq!(mac, "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    }

    #[test]
    fn host_file_names_follow_host_js() {
        assert!(host_file(DEFAULT_APP_ID).ends_with("apaki-host.json"));
        assert!(host_file("apaki dev/host").to_string_lossy().ends_with("apaki-host.apaki_dev_host.json"));
    }

    #[test]
    fn roots_compare_loosely() {
        assert!(same_root(r"\\?\C:\Users\A\Apaki\engine\", "c:/users/a/apaki/engine"));
        assert!(!same_root(r"C:\a", r"C:\b"));
    }

    /// Interop with a live engine host (engine.js --host), run by hand:
    ///   APAKI_TEST_HOST_FILE=<its host file> APAKI_TEST_APP_ID=<its app id> cargo test -- --ignored
    /// Checks the handshake both ways, that the ready event the host sends
    /// right behind ok is not lost, that a command gets its answer, and that a
    /// wrong token is refused.
    #[test]
    #[ignore]
    fn talks_to_a_live_host() {
        let file = std::env::var("APAKI_TEST_HOST_FILE").expect("APAKI_TEST_HOST_FILE");
        let app = std::env::var("APAKI_TEST_APP_ID").unwrap_or_else(|_| "apaki-dev-host-test".into());
        let info = read_info(Path::new(&file)).expect("a host file");
        let Connected { stream, mut reader, ok } = connect(&info, &app).expect("the handshake");
        assert_eq!(ok.get("t").and_then(Value::as_str), Some("ok"));
        stream.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        let mut w = stream.try_clone().unwrap();
        let next = |reader: &mut BufReader<TcpStream>, ev: &str| loop {
            let v = read_json_line(reader).expect("an event");
            if v.get("ev").and_then(Value::as_str) == Some(ev) {
                return v;
            }
        };
        let ready = next(&mut reader, "ready");
        assert!(ready.get("host").is_some());
        w.write_all(b"{\"op\":\"shellHello\",\"version\":1,\"features\":[\"browser\"]}\n{\"op\":\"hostStatus\",\"reqId\":\"rs\"}\n").unwrap();
        let st = next(&mut reader, "host");
        assert_eq!(st.get("window").and_then(Value::as_bool), Some(true));
        let bad = HostInfo { token: "0".repeat(64), ..info };
        assert!(connect(&bad, &app).is_err(), "a wrong token is refused");
    }

    /// Starts a real host the way the window does (spawn_host: no window, own
    /// process group, out of this process's job when Windows allows it) in a
    /// temp config folder under the app id apaki-dev-host-test, connects, asks
    /// it to quit now and checks it exits and removes its host file. By hand:
    ///   APAKI_TEST_ROOT=<repo checkout> cargo test -- --ignored spawns
    #[test]
    #[ignore]
    fn spawns_a_detached_host() {
        use std::ffi::OsString;
        use std::time::Instant;
        let root = PathBuf::from(std::env::var("APAKI_TEST_ROOT").expect("APAKI_TEST_ROOT"));
        let dir = std::env::temp_dir().join(format!("apaki-host-rs-{}", std::process::id()));
        let claude = dir.join("claude");
        std::fs::create_dir_all(claude.join("latch")).unwrap();
        let file = claude.join("latch").join("apaki-host.apaki-dev-host-test.json");
        let envs: Vec<(&str, OsString)> = vec![
            ("CLAUDE_CONFIG_DIR", claude.clone().into()),
            ("LATCH_DIR", claude.join("latch").into()),
            ("APAKI_APP_ID", "apaki-dev-host-test".into()),
            ("APAKI_HOST_FILE", file.clone().into()),
            ("APAKI_REMOTE_DIR", dir.join("remote").into()),
            ("LATCH_GLASS_CLI", dir.join("no-glass.exe").into()),
            ("LATCH_LIVE_LOGIN_FILE", dir.join("no-login.json").into()),
            ("CLAUDE_CREDENTIALS_FILE", dir.join("none.vault").into()),
            ("APAKI_VOICE_DIR", dir.join("voice").into()),
            ("LATCH_NO_INDEX", "1".into()),
            ("LATCH_WARM_NO_KEEPER", "1".into()),
            ("APAKI_SHELL_FEATURES", "browser".into()),
        ];
        let log = File::create(dir.join("host.log")).unwrap();
        let script = root.join("apaki").join("engine").join("engine.js");
        let mut child = spawn_host(Path::new("node"), &script, &root, &envs, &log).expect("spawned");
        let deadline = Instant::now() + Duration::from_secs(45);
        let c = loop {
            std::thread::sleep(Duration::from_millis(150));
            if let Some(info) = read_info(&file) {
                if let Ok(c) = connect(&info, "apaki-dev-host-test") {
                    break c;
                }
            }
            assert!(Instant::now() < deadline, "the host did not start: {}", std::fs::read_to_string(dir.join("host.log")).unwrap_or_default());
        };
        assert_eq!(c.ok.get("pid").and_then(Value::as_u64), Some(u64::from(child.id())));
        // 2026-10-11: the reader's own handle must have no read timeout left from the handshake. It kept 5 s on
        // Windows, so a quiet engine ended the window's connection (os error 10060) and the window reconnected
        // over and over. Wait past the old limit with nothing to read, then read the engine's answer.
        let Connected { stream, mut reader, .. } = c;
        let mut w = stream.try_clone().unwrap();
        w.write_all(b"{\"op\":\"shellHello\",\"version\":1,\"features\":[]}\n").unwrap();
        let mut first = String::new();
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(4) {
            first.clear();
            assert!(reader.read_line(&mut first).expect("reads the engine's first events") > 0);
            if first.contains("\"ready\"") { break; }
        }
        // Drain what the engine sends at connect, then block in a read for 7 s: the question goes out from another
        // thread only then, so a read timeout left on the reader's handle would fail this read.
        let mut w2 = stream.try_clone().unwrap();
        let asker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(7));
            w2.write_all(b"{\"op\":\"hostStatus\",\"reqId\":\"idle-check\"}\n").unwrap();
        });
        let mut got = String::new();
        loop {
            got.clear();
            let n = reader.read_line(&mut got).expect("still connected after 7 s with nothing to read (no read timeout)");
            assert!(n > 0, "the connection is still open");
            if got.contains("idle-check") { break; }
        }
        asker.join().unwrap();
        w.write_all(b"{\"op\":\"hostQuit\",\"now\":true}\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        while !matches!(child.try_wait(), Ok(Some(_))) {
            assert!(Instant::now() < deadline, "the host did not exit");
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(read_info(&file).is_none(), "the host file is gone");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
