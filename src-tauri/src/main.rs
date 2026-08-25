// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine as _;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn ytdlp_command(args: &[&str]) -> Command {
    let mut cmd = Command::new("yt-dlp");
    cmd.args(args);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Build stamp: proves which frontend generation is embedded in this binary.
/// Bump when shipping — grep-able in the exe and returned by yt_check.
const BUILD_STAMP: &str = "exd-build-v28-navigate";

/// Is a yt-dlp binary reachable on PATH? Returns its version + build stamp.
#[tauri::command]
async fn yt_check() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let out = ytdlp_command(&["--version"])
            .output()
            .map_err(|e| format!("yt-dlp not found: {e}"))?;
        if out.status.success() {
            Ok(format!(
                "{} ({})",
                String::from_utf8_lossy(&out.stdout).trim(),
                BUILD_STAMP
            ))
        } else {
            Err("yt-dlp exited with an error".into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
struct YtResult {
    title: String,
    /// bestaudio bytes, base64 — the frontend decodes and hands them to
    /// AudioContext.decodeAudioData exactly like the dev-server path
    b64: String,
}

const MAX_DURATION_SEC: u32 = 1200; // 20 minutes

/// When a fetch produced no output, probe the video's duration so the error
/// can say whether it was filtered for length or is simply unavailable.
fn diagnose_skip(url: &str) -> String {
    let probe = ytdlp_command(&["--no-playlist", "--skip-download", "--print", "duration", url]).output();
    if let Ok(out) = probe {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Ok(dur) = text.trim().parse::<f64>() {
                if dur > MAX_DURATION_SEC as f64 {
                    return format!(
                        "Video is {:.0} minutes — over the {}-minute cap.",
                        dur / 60.0,
                        MAX_DURATION_SEC / 60
                    );
                }
                return "Video was skipped for an unknown reason — try updating yt-dlp.".into();
            }
        }
    }
    "Video unavailable — removed, private, region- or age-locked.".into()
}

/// Fetch bestaudio for a YouTube URL via the system yt-dlp.
/// Mirrors the Vite dev middleware: ≤20 minutes, no playlists.
/// A plain YouTube URL, or a `ytsearch1:` query (used for Spotify matching).
fn is_fetchable(url: &str) -> bool {
    url.starts_with("ytsearch1:")
        || ((url.starts_with("http://") || url.starts_with("https://"))
            && (url.contains("youtube.com/") || url.contains("youtu.be/")))
}

#[tauri::command]
async fn yt_fetch(url: String) -> Result<YtResult, String> {
    if !is_fetchable(&url) {
        return Err("Not a YouTube URL".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let dir = std::env::temp_dir().join("exotica-yt");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let outtmpl = dir.join("%(id)s.%(ext)s");
        let out = ytdlp_command(&[
            "-f",
            "bestaudio",
            "--no-playlist",
            "--match-filter",
            "duration<=1200",
            "--no-simulate",
            "--print",
            "%(title)s",
            "--print",
            "after_move:filepath",
            "-o",
            outtmpl.to_str().ok_or("bad temp path")?,
            "--force-overwrites",
            &url,
        ])
        .output()
        .map_err(|e| format!("failed to start yt-dlp: {e}"))?;

        let stdout = String::from_utf8_lossy(&out.stdout);
        let lines: Vec<&str> = stdout.lines().filter(|l| !l.trim().is_empty()).collect();
        if !out.status.success() || lines.len() < 2 {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let tail: String = stderr.chars().rev().take(400).collect::<String>().chars().rev().collect();
            return Err(if lines.len() < 2 {
                diagnose_skip(&url)
            } else {
                format!("yt-dlp failed: {tail}")
            });
        }
        let filepath = lines[lines.len() - 1].trim();
        let title = lines[..lines.len() - 1].join(" ");
        let bytes = std::fs::read(filepath).map_err(|e| format!("could not read download: {e}"))?;
        let _ = std::fs::remove_file(filepath);
        Ok(YtResult {
            title,
            b64: base64::engine::general_purpose::STANDARD.encode(bytes),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Expand a YouTube playlist/mix URL into its first entries' watch URLs.
#[tauri::command]
async fn yt_expand(url: String) -> Result<Vec<String>, String> {
    if !is_fetchable(&url) {
        return Err("Not a YouTube URL".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let out = ytdlp_command(&["--flat-playlist", "--playlist-end", "8", "--print", "id", &url])
            .output()
            .map_err(|e| format!("failed to start yt-dlp: {e}"))?;
        if !out.status.success() {
            return Err("Playlist could not be read — private or unavailable.".into());
        }
        let ids: Vec<String> = String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .map(|id| format!("https://www.youtube.com/watch?v={id}"))
            .collect();
        if ids.is_empty() {
            Err("Playlist is empty or unavailable.".into())
        } else {
            Ok(ids)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn json_unescape(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('u') => {
                let hex: String = chars.by_ref().take(4).collect();
                if let Ok(n) = u32::from_str_radix(&hex, 16) {
                    if let Some(ch) = char::from_u32(n) {
                        out.push(ch);
                    }
                }
            }
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

/// Read a JSON string value up to its closing unescaped quote.
/// Returns (unescaped value, byte index of the closing quote).
fn read_json_str(s: &str) -> (String, usize) {
    let bytes = s.as_bytes();
    let mut esc = false;
    for (j, &b) in bytes.iter().enumerate() {
        if esc {
            esc = false;
            continue;
        }
        if b == b'\\' {
            esc = true;
            continue;
        }
        if b == b'"' {
            return (json_unescape(&s[..j]), j);
        }
    }
    (json_unescape(s), s.len())
}

/// Adjacent `"title":"…","subtitle":"…"` pairs — the track entries in a
/// Spotify embed page's JSON (title = song, subtitle = artists).
fn scan_track_pairs(doc: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = doc;
    while let Some(i) = rest.find("\"title\":\"") {
        let after = &rest[i + 9..];
        let (title, len) = read_json_str(after);
        let tail = &after[len..];
        if let Some(t2) = tail.strip_prefix("\",\"subtitle\":\"") {
            let (sub, len2) = read_json_str(t2);
            out.push(format!("{title} {sub}"));
            rest = &t2[len2..];
        } else {
            rest = tail;
        }
    }
    out
}

fn scan_str_values(doc: &str, key: &str) -> Vec<String> {
    let pat = format!("\"{key}\":\"");
    let mut vals = Vec::new();
    let mut rest = doc;
    while let Some(i) = rest.find(&pat) {
        let after = &rest[i + pat.len()..];
        let (val, len) = read_json_str(after);
        vals.push(val);
        rest = &after[len..];
    }
    vals
}

fn parse_spotify(url: &str) -> Option<(String, String)> {
    if !url.contains("open.spotify.com/") {
        return None;
    }
    for kind in ["track", "playlist", "album"] {
        if let Some(i) = url.find(&format!("/{kind}/")) {
            let id: String = url[i + kind.len() + 2..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect();
            if id.len() >= 10 {
                return Some((kind.to_string(), id));
            }
        }
    }
    None
}

/// Spotify has no downloadable audio (DRM) — instead, read the public embed
/// page for the track/album/playlist and return "song artist" search queries,
/// which the frontend feeds to yt_fetch as `ytsearch1:` lookups.
#[tauri::command]
async fn spotify_queries(url: String) -> Result<Vec<String>, String> {
    let (kind, id) = parse_spotify(&url).ok_or("Not a Spotify track/album/playlist URL")?;
    tauri::async_runtime::spawn_blocking(move || {
        let embed = format!("https://open.spotify.com/embed/{kind}/{id}");
        let script = format!(
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Invoke-WebRequest -UseBasicParsing '{embed}').Content"
        );
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-Command", &script]);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let out = cmd
            .output()
            .map_err(|e| format!("could not fetch the Spotify page: {e}"))?;
        if !out.status.success() {
            return Err("Spotify page fetch failed — link private or removed?".into());
        }
        let doc = String::from_utf8_lossy(&out.stdout).to_string();
        let mut queries: Vec<String> = scan_track_pairs(&doc)
            .into_iter()
            // the first pair is the playlist/album entity itself: "Name Spotify"
            .filter(|q| !q.ends_with(" Spotify"))
            .filter(|q| q.len() > 3 && q.len() < 150)
            .collect();
        if queries.is_empty() {
            // single-track embed: entity "name" then the artist's "name"
            let names = scan_str_values(&doc, "name");
            if names.len() >= 2 {
                queries.push(format!("{} {}", names[0], names[1]));
            } else if let Some(n) = names.first() {
                queries.push(n.clone());
            }
        }
        queries.dedup();
        queries.truncate(8);
        if queries.is_empty() {
            Err("No tracks found at that Spotify link.".into())
        } else {
            Ok(queries)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            yt_check,
            yt_fetch,
            yt_expand,
            spotify_queries
        ])
        .run(tauri::generate_context!())
        .expect("error while running Exotica Décollage");
}
