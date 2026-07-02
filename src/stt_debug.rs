//! Temporary on-disk retention of incoming /transcribe clips, for post-hoc
//! debugging of STT decoder issues (e.g. repetition loops). Never allowed to
//! affect the /transcribe response — failures here only log a warning.

use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rand::{distr::Alphanumeric, Rng};
use serde_json::json;

const MAX_CLIPS: usize = 50;

#[derive(Debug, Clone)]
pub struct ProviderContext {
    pub kind: String,
    pub model: String,
    pub host: String,
    pub port: String,
    pub url: String,
}

/// Store the clip and its sidecar under `<data_dir>/stt-debug/`, then evict
/// the oldest clips beyond `MAX_CLIPS`. Never propagates errors — logs a
/// warning and returns, so a full disk can't break transcription.
pub fn store_clip(
    data_dir: &Path,
    audio_bytes: &[u8],
    filename: &str,
    provider: &ProviderContext,
    elapsed: Duration,
    outcome: &Result<String, String>,
) {
    if let Err(e) = try_store_clip(data_dir, audio_bytes, filename, provider, elapsed, outcome) {
        eprintln!("[stt-debug] warning: failed to store debug clip: {e:#}");
    }
}

fn try_store_clip(
    data_dir: &Path,
    audio_bytes: &[u8],
    filename: &str,
    provider: &ProviderContext,
    elapsed: Duration,
    outcome: &Result<String, String>,
) -> anyhow::Result<()> {
    let dir = data_dir.join("stt-debug");
    fs::create_dir_all(&dir)?;

    let ts_ms = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
    let short_id: String = rand::rng()
        .sample_iter(&Alphanumeric)
        .take(6)
        .map(char::from)
        .collect();
    let ext = Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("wav");
    let stem = format!("{ts_ms}-{short_id}");
    let audio_path = dir.join(format!("{stem}.{ext}"));
    let sidecar_path = dir.join(format!("{stem}.json"));

    fs::write(&audio_path, audio_bytes)?;

    let (text, error) = match outcome {
        Ok(text) => (Some(text.as_str()), None),
        Err(err) => (None, Some(err.as_str())),
    };
    let sidecar = json!({
        "timestampMs": ts_ms,
        "clipBytes": audio_bytes.len(),
        "providerKind": provider.kind,
        "model": provider.model,
        "host": provider.host,
        "port": provider.port,
        "url": provider.url,
        "inferenceMs": elapsed.as_millis(),
        "text": text,
        "error": error,
    });
    fs::write(&sidecar_path, serde_json::to_vec_pretty(&sidecar)?)?;

    println!("[stt-debug] stored clip {}", audio_path.display());

    evict_oldest(&dir, MAX_CLIPS)
}

/// Sidecar `.json` files are the canonical list of stored clips (one per
/// write); evict the oldest stems' full file pairs once the count exceeds
/// `cap`. Filenames sort chronologically since they're `<unix_ms>-<id>`.
fn evict_oldest(dir: &Path, cap: usize) -> anyhow::Result<()> {
    let mut stems: Vec<String> = fs::read_dir(dir)?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            entry
                .file_name()
                .to_str()
                .and_then(|name| name.strip_suffix(".json"))
                .map(str::to_string)
        })
        .collect();
    stems.sort();

    if stems.len() <= cap {
        return Ok(());
    }

    let evict_count = stems.len() - cap;
    for stem in &stems[..evict_count] {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let matches_stem = entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(stem.as_str()));
            if matches_stem {
                fs::remove_file(entry.path())?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> ProviderContext {
        ProviderContext {
            kind: "local".to_string(),
            model: "Systran/faster-whisper-small".to_string(),
            host: "http://127.0.0.1".to_string(),
            port: "5200".to_string(),
            url: "http://127.0.0.1:5200/v1/audio/transcriptions".to_string(),
        }
    }

    fn clip_stems(dir: &Path) -> Vec<String> {
        let mut stems: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                e.file_name()
                    .to_str()
                    .and_then(|n| n.strip_suffix(".json"))
                    .map(str::to_string)
            })
            .collect();
        stems.sort();
        stems
    }

    #[test]
    fn stores_audio_and_json_sidecar_with_expected_shape() {
        let dir = tempfile::tempdir().unwrap();
        store_clip(
            dir.path(),
            b"fake-wav-bytes",
            "speech.wav",
            &ctx(),
            Duration::from_millis(250),
            &Ok("ten ten ten".to_string()),
        );

        let stt_dir = dir.path().join("stt-debug");
        let stems = clip_stems(&stt_dir);
        assert_eq!(stems.len(), 1);

        let wav_path = stt_dir.join(format!("{}.wav", stems[0]));
        assert_eq!(fs::read(&wav_path).unwrap(), b"fake-wav-bytes");

        let json_path = stt_dir.join(format!("{}.json", stems[0]));
        let sidecar: serde_json::Value =
            serde_json::from_slice(&fs::read(&json_path).unwrap()).unwrap();
        assert_eq!(sidecar["clipBytes"], 14);
        assert_eq!(sidecar["providerKind"], "local");
        assert_eq!(sidecar["model"], "Systran/faster-whisper-small");
        assert_eq!(sidecar["host"], "http://127.0.0.1");
        assert_eq!(sidecar["port"], "5200");
        assert_eq!(
            sidecar["url"],
            "http://127.0.0.1:5200/v1/audio/transcriptions"
        );
        assert_eq!(sidecar["inferenceMs"], 250);
        assert_eq!(sidecar["text"], "ten ten ten");
        assert!(sidecar["error"].is_null());
        assert!(sidecar["timestampMs"].is_u64());
    }

    #[test]
    fn records_failure_outcome_instead_of_text() {
        let dir = tempfile::tempdir().unwrap();
        store_clip(
            dir.path(),
            b"bytes",
            "speech.webm",
            &ctx(),
            Duration::from_millis(10),
            &Err("provider unavailable: connection refused".to_string()),
        );

        let stt_dir = dir.path().join("stt-debug");
        let stems = clip_stems(&stt_dir);
        let sidecar: serde_json::Value =
            serde_json::from_slice(&fs::read(stt_dir.join(format!("{}.json", stems[0]))).unwrap())
                .unwrap();
        assert!(sidecar["text"].is_null());
        assert_eq!(sidecar["error"], "provider unavailable: connection refused");

        let webm_path = stt_dir.join(format!("{}.webm", stems[0]));
        assert!(webm_path.exists());
    }

    #[test]
    fn evicts_oldest_clips_once_over_the_retention_cap() {
        let dir = tempfile::tempdir().unwrap();
        let stt_dir = dir.path().join("stt-debug");
        fs::create_dir_all(&stt_dir).unwrap();

        // Write 51 clips directly at increasing synthetic timestamps so
        // ordering is deterministic without needing real elapsed time.
        for i in 0..51u128 {
            let stem = format!("{:013}-clip{i}", 1_700_000_000_000u128 + i);
            fs::write(stt_dir.join(format!("{stem}.wav")), b"x").unwrap();
            fs::write(stt_dir.join(format!("{stem}.json")), b"{}").unwrap();
        }

        evict_oldest(&stt_dir, MAX_CLIPS).unwrap();

        let stems = clip_stems(&stt_dir);
        assert_eq!(stems.len(), MAX_CLIPS);
        // The single oldest clip (i == 0) must be gone, newest (i == 50) kept.
        assert!(!stems.iter().any(|s| s.ends_with("clip0")));
        assert!(stems.iter().any(|s| s.ends_with("clip50")));

        let paths: Vec<_> = fs::read_dir(&stt_dir).unwrap().collect();
        assert_eq!(paths.len(), MAX_CLIPS * 2, "wav+json pairs, no orphans");
    }

    #[test]
    fn does_not_evict_when_at_or_under_cap() {
        let dir = tempfile::tempdir().unwrap();
        let stt_dir = dir.path().join("stt-debug");
        fs::create_dir_all(&stt_dir).unwrap();
        for i in 0..MAX_CLIPS {
            let stem = format!("{:013}-clip{i}", 1_700_000_000_000u128 + i as u128);
            fs::write(stt_dir.join(format!("{stem}.wav")), b"x").unwrap();
            fs::write(stt_dir.join(format!("{stem}.json")), b"{}").unwrap();
        }
        evict_oldest(&stt_dir, MAX_CLIPS).unwrap();
        assert_eq!(clip_stems(&stt_dir).len(), MAX_CLIPS);
    }
}
