//! Getting model weights onto a host without ever asking a model host.
//!
//! Weights ride in the release tarball `install.sh` already downloads and
//! sha256-verifies, so a prebuilt install never fetches a model at all. A
//! `cargo install` build arrives with no weights beside it, so it pulls that
//! same published asset and checks every file it unpacks against the lock the
//! source tree was built against.
//!
//! This is the machinery both local model features need: fetch the asset,
//! check it against what the release publishes, unpack one prefix out of it,
//! and refuse anything whose bytes are not the bytes the lock names.

#![cfg_attr(not(feature = "local-tts"), allow(dead_code))]

use std::collections::BTreeMap;
use std::path::Path;
#[cfg(feature = "local-tts")]
use std::path::PathBuf;

#[cfg(feature = "local-tts")]
use futures_util::StreamExt;
#[cfg(feature = "local-tts")]
use sha2::{Digest, Sha256};
#[cfg(feature = "local-tts")]
use tokio::io::AsyncWriteExt;

#[cfg(feature = "local-tts")]
const DOWNLOAD_PROGRESS_STEP: u64 = 4 * 1024 * 1024;

/// How long a download may go without a byte arriving before it is abandoned.
///
/// A connect timeout alone only covers the handshake: a peer that accepts the
/// connection and then stalls, or dribbles, holds the fetch open for as long
/// as it likes — with the prepare lock held and a part file growing in the
/// data dir.
#[cfg(feature = "local-tts")]
const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

#[cfg(feature = "local-tts")]
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// The sidecar is one line; it never needs a streaming budget.
#[cfg(feature = "local-tts")]
const SIDECAR_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// The most the asset may weigh before the download is abandoned.
///
/// The lock knows what the model files weigh, but the tarball carries the
/// mobux binary as well, so the budget is a multiple of the locked payload
/// plus room for a release binary. Without one, a wrong or hostile base URL
/// streams until the disk is full.
#[cfg(feature = "local-tts")]
pub fn download_budget(manifest: &Manifest<'_>) -> u64 {
    let locked: u64 = manifest.files.values().map(|f| f.bytes).sum();
    locked.saturating_mul(3).saturating_add(64 * 1024 * 1024)
}

/// One file, pinned by content. Rewritten only by the maintainer script that
/// refreshes the model.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct LockedFile {
    pub sha256: String,
    pub bytes: u64,
}

/// What to unpack and what it has to hash to.
pub struct Manifest<'a> {
    /// Path inside the tarball the files are packed under, e.g. `tts-voices/x/`.
    pub prefix: String,
    pub files: &'a BTreeMap<String, LockedFile>,
}

impl Manifest<'_> {
    pub fn names(&self) -> Vec<&str> {
        self.files.keys().map(String::as_str).collect()
    }
}

/// How far along the fetch is, for the status endpoint to render.
#[derive(Debug, Clone)]
pub enum Progress {
    Downloading {
        file: String,
        downloaded: u64,
        total: u64,
    },
    Verifying,
}

/// The release tarball carrying the weights for this host, or None on an
/// architecture mobux publishes no prebuilt asset for.
pub fn release_asset_name() -> Option<&'static str> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    match std::env::consts::ARCH {
        "x86_64" => Some("mobux-x86_64-unknown-linux-gnu.tar.gz"),
        "aarch64" => Some("mobux-aarch64-unknown-linux-gnu.tar.gz"),
        _ => None,
    }
}

/// True once every file the manifest names is in `dir`.
pub fn files_present(dir: &Path, names: &[&str]) -> bool {
    names.iter().all(|name| dir.join(name).is_file())
}

/// Check a directory against the lock. Size first, because a truncated
/// download is the common case and hashing it is wasted work.
#[cfg(feature = "local-tts")]
pub fn verify(dir: &Path, manifest: &Manifest<'_>) -> Result<(), String> {
    for (name, locked) in manifest.files {
        let bytes = std::fs::read(dir.join(name))
            .map_err(|e| format!("the release asset carries no usable {name}: {e}"))?;
        if bytes.len() as u64 != locked.bytes {
            return Err(format!(
                "{name} is {} bytes, this build expects {}",
                bytes.len(),
                locked.bytes
            ));
        }
        let digest = hex(Sha256::digest(&bytes));
        if digest != locked.sha256 {
            return Err(format!(
                "sha256 mismatch for {name}: this build expects {}, the release carries {digest}",
                locked.sha256
            ));
        }
    }
    Ok(())
}

/// Fetch the release tarball for this host and unpack the manifest's files out
/// of it into `dir`.
#[cfg(feature = "local-tts")]
pub async fn fetch_into(
    base_url: &str,
    dir: &Path,
    manifest: &Manifest<'_>,
    report: &(dyn Fn(Progress) + Send + Sync),
) -> Result<(), String> {
    let asset = release_asset_name().ok_or_else(|| {
        format!(
            "no prebuilt mobux release for {}/{}",
            std::env::consts::OS,
            std::env::consts::ARCH,
        )
    })?;
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| format!("creating {}: {e}", dir.display()))?;

    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let tarball = dir.join(format!("{asset}.part"));
    report(Progress::Downloading {
        file: asset.to_string(),
        downloaded: 0,
        total: 0,
    });
    let result =
        download_and_unpack(&client, base_url, asset, &tarball, dir, manifest, report).await;
    let _ = tokio::fs::remove_file(&tarball).await;
    result
}

#[allow(clippy::too_many_arguments)]
#[cfg(feature = "local-tts")]
async fn download_and_unpack(
    client: &reqwest::Client,
    base: &str,
    asset: &str,
    tarball: &Path,
    dir: &Path,
    manifest: &Manifest<'_>,
    report: &(dyn Fn(Progress) + Send + Sync),
) -> Result<(), String> {
    let digest = download(
        client,
        &format!("{base}/{asset}"),
        tarball,
        asset,
        download_budget(manifest),
        report,
    )
    .await?;

    report(Progress::Verifying);
    let published = fetch_published_digest(client, base, asset).await?;
    if published != digest {
        return Err(format!(
            "sha256 mismatch for {asset}: the release publishes {published}, the download is {digest}"
        ));
    }

    let tarball = tarball.to_path_buf();
    let dir = dir.to_path_buf();
    let prefix = manifest.prefix.clone();
    let wanted: Vec<String> = manifest.files.keys().cloned().collect();
    let files = manifest.files.clone();
    tokio::task::spawn_blocking(move || {
        let manifest = Manifest {
            prefix,
            files: &files,
        };
        extract(&tarball, &dir, &manifest, &wanted)
    })
    .await
    .map_err(|e| format!("unpacking the model panicked: {e}"))?
}

/// Unpack just the manifest's files, then check them. A file that does not
/// match is removed rather than left behind for the next start to load.
#[cfg(feature = "local-tts")]
fn extract(
    tarball: &Path,
    dir: &Path,
    manifest: &Manifest<'_>,
    wanted: &[String],
) -> Result<(), String> {
    let file =
        std::fs::File::open(tarball).map_err(|e| format!("opening {}: {e}", tarball.display()))?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let entries = archive
        .entries()
        .map_err(|e| format!("reading {}: {e}", tarball.display()))?;

    for entry in entries {
        let mut entry = entry.map_err(|e| format!("reading {}: {e}", tarball.display()))?;
        let path = entry
            .path()
            .map_err(|e| format!("reading {}: {e}", tarball.display()))?
            .to_string_lossy()
            .into_owned();
        let Some(name) = path.strip_prefix(&manifest.prefix) else {
            continue;
        };
        if !wanted.iter().any(|w| w == name) {
            continue;
        }
        entry
            .unpack(dir.join(name))
            .map_err(|e| format!("unpacking {name}: {e}"))?;
    }

    if let Err(err) = verify(dir, manifest) {
        for name in wanted {
            let _ = std::fs::remove_file(dir.join(name));
        }
        return Err(err);
    }
    Ok(())
}

/// Read the `<asset>.sha256` sidecar the release publishes beside the tarball —
/// the same file install.sh checks, in `sha256sum` format.
#[cfg(feature = "local-tts")]
async fn fetch_published_digest(
    client: &reqwest::Client,
    base: &str,
    asset: &str,
) -> Result<String, String> {
    let body = client
        .get(format!("{base}/{asset}.sha256"))
        .timeout(SIDECAR_TIMEOUT)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("fetching {asset}.sha256: {e}"))?
        .text()
        .await
        .map_err(|e| format!("reading {asset}.sha256: {e}"))?;
    parse_sha256sum(&body).ok_or_else(|| format!("{asset}.sha256 is not a sha256sum line"))
}

#[cfg(feature = "local-tts")]
pub fn parse_sha256sum(body: &str) -> Option<String> {
    let digest = body.split_whitespace().next()?;
    if digest.len() != 64 || !digest.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(digest.to_ascii_lowercase())
}

/// Stream `url` to `target`, reporting progress, and return the sha256 of what
/// landed — computed while writing, so nothing is read back to check it.
#[cfg(feature = "local-tts")]
async fn download(
    client: &reqwest::Client,
    url: &str,
    target: &Path,
    file: &str,
    budget: u64,
    report: &(dyn Fn(Progress) + Send + Sync),
) -> Result<String, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("fetching {file}: {e}"))?
        .error_for_status()
        .map_err(|e| format!("fetching {file}: {e}"))?;
    let total = response.content_length().unwrap_or(0);
    if total > budget {
        return Err(over_budget(file, total, budget));
    }

    let mut out = tokio::fs::File::create(target)
        .await
        .map_err(|e| format!("creating {}: {e}", target.display()))?;

    let mut hasher = Sha256::new();
    let mut stream = response.bytes_stream();
    let mut downloaded = 0u64;
    let mut reported = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("downloading {file}: {e}"))?;
        downloaded += chunk.len() as u64;
        if downloaded > budget {
            return Err(over_budget(file, downloaded, budget));
        }
        hasher.update(&chunk);
        out.write_all(&chunk)
            .await
            .map_err(|e| format!("writing {}: {e}", target.display()))?;
        if downloaded - reported >= DOWNLOAD_PROGRESS_STEP {
            reported = downloaded;
            report(Progress::Downloading {
                file: file.to_string(),
                downloaded,
                total,
            });
        }
    }
    out.flush()
        .await
        .map_err(|e| format!("writing {}: {e}", target.display()))?;
    Ok(hex(hasher.finalize()))
}

#[cfg(feature = "local-tts")]
#[cfg(feature = "local-tts")]
fn over_budget(file: &str, got: u64, budget: u64) -> String {
    format!(
        "{file} is at least {got} bytes, past the {budget} this build will accept — \
         the release asset does not weigh that, so this is the wrong URL"
    )
}

#[cfg(feature = "local-tts")]
pub fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
}

/// A directory the operator named is used exactly as given — that is the point
/// of naming it. The cache mobux wrote itself is re-checked against the lock: a
/// self-update can leave a binary whose pinned weights differ from what an
/// earlier version wrote there, and loading those silently would be worse than
/// fetching again.
#[cfg(feature = "local-tts")]
pub fn resolve_existing(
    named: Option<&Path>,
    cached: &Path,
    manifest: &Manifest<'_>,
) -> Option<PathBuf> {
    let names = manifest.names();
    if let Some(named) = named {
        if files_present(named, &names) {
            return Some(named.to_path_buf());
        }
    }
    if files_present(cached, &names) && verify(cached, manifest).is_ok() {
        return Some(cached.to_path_buf());
    }
    None
}

#[cfg(all(test, feature = "local-tts"))]
mod tests {
    use super::*;

    fn manifest_files(bytes: u64, sha: &str) -> BTreeMap<String, LockedFile> {
        BTreeMap::from([(
            "voice.onnx".to_string(),
            LockedFile {
                sha256: sha.to_string(),
                bytes,
            },
        )])
    }

    #[test]
    fn a_sha256sum_line_yields_just_the_digest() {
        let digest = "a".repeat(64);
        assert_eq!(
            parse_sha256sum(&format!("{digest}  mobux.tar.gz\n")),
            Some(digest.clone())
        );
        assert_eq!(parse_sha256sum(&digest.to_uppercase()), Some(digest));
        assert_eq!(parse_sha256sum("not a digest"), None);
        assert_eq!(parse_sha256sum(""), None);
    }

    // A base URL that answers with something enormous — the wrong file, a
    // hostile mirror, a proxy error page that never ends — filled the disk,
    // because only the connect had a timeout and nothing had a size.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_download_past_its_budget_is_abandoned() {
        use axum::routing::get;
        use axum::Router;

        let asset = release_asset_name().expect("a linux asset name");
        let app = Router::new().route(
            &format!("/{asset}"),
            get(|| async { "x".repeat(64 * 1024).repeat(64) }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        // A budget small enough that the served body blows straight through it.
        let client = reqwest::Client::new();
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("asset.part");
        let err = download(
            &client,
            &format!("http://{addr}/{asset}"),
            &target,
            asset,
            4096,
            &|_| {},
        )
        .await
        .expect_err("a body past the budget is not an asset");
        assert!(err.contains("past the"), "{err}");
    }

    #[test]
    fn the_budget_leaves_room_for_the_binary_riding_along() {
        let files = manifest_files(100 * 1024 * 1024, &"0".repeat(64));
        let manifest = Manifest {
            prefix: "tts-voices/x/".to_string(),
            files: &files,
        };
        let budget = download_budget(&manifest);
        assert!(budget > 100 * 1024 * 1024, "{budget}");
        assert!(budget < 1024 * 1024 * 1024, "{budget}");
    }

    #[test]
    fn both_published_architectures_have_an_asset_to_pull_from() {
        assert!(release_asset_name().is_some_and(|a| a.ends_with(".tar.gz")));
    }

    #[test]
    fn verification_rejects_the_wrong_size_before_it_hashes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("voice.onnx"), b"hello").unwrap();
        let files = manifest_files(9, &"0".repeat(64));
        let manifest = Manifest {
            prefix: "tts-voices/x/".to_string(),
            files: &files,
        };
        let err = verify(dir.path(), &manifest).unwrap_err();
        assert!(err.contains("5 bytes"), "{err}");
    }

    #[test]
    fn verification_rejects_the_wrong_bytes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("voice.onnx"), b"hello").unwrap();
        let files = manifest_files(5, &"0".repeat(64));
        let manifest = Manifest {
            prefix: "tts-voices/x/".to_string(),
            files: &files,
        };
        let err = verify(dir.path(), &manifest).unwrap_err();
        assert!(err.contains("sha256 mismatch"), "{err}");
    }

    #[test]
    fn verification_passes_on_the_bytes_the_lock_names() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("voice.onnx"), b"hello").unwrap();
        let files = manifest_files(5, &hex(Sha256::digest(b"hello")));
        let manifest = Manifest {
            prefix: "tts-voices/x/".to_string(),
            files: &files,
        };
        assert!(verify(dir.path(), &manifest).is_ok());
        assert!(files_present(dir.path(), &manifest.names()));
    }

    // A named directory is used as given; a cache that drifted from the lock is
    // not, because a self-update can leave one behind.
    #[test]
    fn a_named_directory_wins_and_a_stale_cache_does_not() {
        let named = tempfile::tempdir().unwrap();
        let cached = tempfile::tempdir().unwrap();
        let files = manifest_files(5, &hex(Sha256::digest(b"hello")));
        let manifest = Manifest {
            prefix: "tts-voices/x/".to_string(),
            files: &files,
        };

        assert_eq!(resolve_existing(None, cached.path(), &manifest), None);

        std::fs::write(cached.path().join("voice.onnx"), b"drift").unwrap();
        assert_eq!(resolve_existing(None, cached.path(), &manifest), None);

        std::fs::write(cached.path().join("voice.onnx"), b"hello").unwrap();
        assert_eq!(
            resolve_existing(None, cached.path(), &manifest),
            Some(cached.path().to_path_buf())
        );

        std::fs::write(named.path().join("voice.onnx"), b"anything at all").unwrap();
        assert_eq!(
            resolve_existing(Some(named.path()), cached.path(), &manifest),
            Some(named.path().to_path_buf())
        );
    }
}
