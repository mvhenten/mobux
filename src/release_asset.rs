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

#![cfg_attr(
    not(any(feature = "local-tts", feature = "local-stt")),
    allow(dead_code)
)]

use std::collections::BTreeMap;
use std::path::Path;
#[cfg(any(feature = "local-tts", feature = "local-stt"))]
use std::path::PathBuf;

#[cfg(any(feature = "local-tts", feature = "local-stt"))]
use futures_util::StreamExt;
#[cfg(any(feature = "local-tts", feature = "local-stt"))]
use sha2::{Digest, Sha256};
#[cfg(any(feature = "local-tts", feature = "local-stt"))]
use tokio::io::AsyncWriteExt;

#[cfg(any(feature = "local-tts", feature = "local-stt"))]
const DOWNLOAD_PROGRESS_STEP: u64 = 4 * 1024 * 1024;

/// How long a download may go without a byte arriving before it is abandoned.
///
/// A connect timeout alone only covers the handshake: a peer that accepts the
/// connection and then stalls, or dribbles, holds the fetch open for as long
/// as it likes — with the prepare lock held and a part file growing in the
/// data dir.
#[cfg(any(feature = "local-tts", feature = "local-stt"))]
pub const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

#[cfg(any(feature = "local-tts", feature = "local-stt"))]
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// The sidecar is one line; it never needs a streaming budget.
#[cfg(any(feature = "local-tts", feature = "local-stt"))]
const SIDECAR_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// The most the asset may weigh before the download is abandoned. Without a
/// cap, a wrong or hostile base URL streams until the disk is full.
///
/// One tarball carries the binary and every vendored model — the voice and the
/// speech-to-text checkpoint — so the cap is sized to the whole asset, not to
/// the one manifest being unpacked from it. Sized off a single manifest, the
/// voice's download refused the combined asset outright.
#[cfg(any(feature = "local-tts", feature = "local-stt"))]
pub const DOWNLOAD_BUDGET: u64 = 512 * 1024 * 1024;

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
#[cfg(any(feature = "local-tts", feature = "local-stt"))]
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

/// Where to fetch an asset from and how much of it to accept.
#[cfg(any(feature = "local-tts", feature = "local-stt"))]
pub struct Source<'a> {
    pub base: &'a str,
    pub asset: &'a str,
    pub budget: u64,
    pub read_timeout: std::time::Duration,
}

/// The platform tarball for this host, or a sentence saying there is none.
#[cfg(feature = "local-tts")]
pub fn platform_asset() -> Result<&'static str, String> {
    release_asset_name().ok_or_else(|| {
        format!(
            "no prebuilt mobux release for {}/{}",
            std::env::consts::OS,
            std::env::consts::ARCH,
        )
    })
}

/// Fetch a release asset and unpack the manifest's files out of it into `dir`.
/// The part file is removed however the fetch ends.
#[cfg(any(feature = "local-tts", feature = "local-stt"))]
pub async fn fetch_into(
    source: &Source<'_>,
    dir: &Path,
    manifest: &Manifest<'_>,
    report: &(dyn Fn(Progress) + Send + Sync),
) -> Result<(), String> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| format!("creating {}: {e}", dir.display()))?;

    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let tarball = dir.join(format!("{}.part", source.asset));
    report(Progress::Downloading {
        file: source.asset.to_string(),
        downloaded: 0,
        total: 0,
    });
    let result = download_and_unpack(&client, source, &tarball, dir, manifest, report).await;
    let _ = tokio::fs::remove_file(&tarball).await;
    result
}

#[cfg(any(feature = "local-tts", feature = "local-stt"))]
async fn download_and_unpack(
    client: &reqwest::Client,
    source: &Source<'_>,
    tarball: &Path,
    dir: &Path,
    manifest: &Manifest<'_>,
    report: &(dyn Fn(Progress) + Send + Sync),
) -> Result<(), String> {
    let (base, asset) = (source.base, source.asset);
    let digest = download(
        client,
        &format!("{base}/{asset}"),
        tarball,
        asset,
        source.budget,
        source.read_timeout,
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
#[cfg(any(feature = "local-tts", feature = "local-stt"))]
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
        // Regular files only. `unpack` validates no entry type of its own —
        // only `unpack_in` does — so a Symlink or Link entry was created in the
        // target directory pointing at any absolute path the archive named, and
        // the lock check that follows then read through it: the "sha256
        // mismatch" rendered in the settings card described whatever file the
        // link resolved to. tar's own unlink-before-create stops a later entry
        // writing through such a link today, but that is the crate's choice and
        // not a guarantee this code should rest on.
        if !entry.header().entry_type().is_file() {
            continue;
        }
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
#[cfg(any(feature = "local-tts", feature = "local-stt"))]
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

#[cfg(any(feature = "local-tts", feature = "local-stt"))]
pub fn parse_sha256sum(body: &str) -> Option<String> {
    let digest = body.split_whitespace().next()?;
    if digest.len() != 64 || !digest.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(digest.to_ascii_lowercase())
}

/// Stream `url` to `target`, reporting progress, and return the sha256 of what
/// landed — computed while writing, so nothing is read back to check it.
#[cfg(any(feature = "local-tts", feature = "local-stt"))]
async fn download(
    client: &reqwest::Client,
    url: &str,
    target: &Path,
    file: &str,
    budget: u64,
    read_timeout: std::time::Duration,
    report: &(dyn Fn(Progress) + Send + Sync),
) -> Result<String, String> {
    let response = tokio::time::timeout(read_timeout, client.get(url).send())
        .await
        .map_err(|_| format!("fetching {file}: no response within {read_timeout:?}"))?
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
    // Every chunk gets a clock of its own: a host that answers and then stops
    // sending otherwise holds the fetch, and whatever lock its caller took,
    // open for good.
    while let Some(chunk) = tokio::time::timeout(read_timeout, stream.next())
        .await
        .map_err(|_| format!("downloading {file}: stalled for {read_timeout:?}"))?
    {
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

#[cfg(any(feature = "local-tts", feature = "local-stt"))]
fn over_budget(file: &str, got: u64, budget: u64) -> String {
    format!(
        "{file} is at least {got} bytes, past the {budget}-byte budget this build will \
         accept — the release asset does not weigh that, so this is the wrong URL"
    )
}

#[cfg(any(feature = "local-tts", feature = "local-stt"))]
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
#[cfg(any(feature = "local-tts", feature = "local-stt"))]
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

#[cfg(all(test, any(feature = "local-tts", feature = "local-stt")))]
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
            READ_TIMEOUT,
            &|_| {},
        )
        .await
        .expect_err("a body past the budget is not an asset");
        assert!(err.contains("past the"), "{err}");
    }

    // Build a .tar.gz holding the given entries: a regular file, or a link of
    // either kind pointing at an absolute path.
    enum Entry<'a> {
        File(&'a str, &'a [u8]),
        Link(&'a str, &'a Path, tar::EntryType),
    }

    fn tarball(path: &Path, entries: &[Entry<'_>]) {
        let out = std::fs::File::create(path).unwrap();
        let gz = flate2::write::GzEncoder::new(out, flate2::Compression::fast());
        let mut builder = tar::Builder::new(gz);
        for entry in entries {
            match entry {
                Entry::File(name, bytes) => {
                    let mut header = tar::Header::new_gnu();
                    header.set_size(bytes.len() as u64);
                    header.set_mode(0o644);
                    header.set_entry_type(tar::EntryType::Regular);
                    header.set_cksum();
                    builder.append_data(&mut header, name, *bytes).unwrap();
                }
                Entry::Link(name, target, kind) => {
                    let mut header = tar::Header::new_gnu();
                    header.set_size(0);
                    header.set_mode(0o777);
                    header.set_entry_type(*kind);
                    builder.append_link(&mut header, name, target).unwrap();
                }
            }
        }
        builder.into_inner().unwrap().finish().unwrap();
    }

    // Nothing an archive says may put bytes outside the directory being
    // unpacked into, and nothing it says may leave a link inside one. tar's own
    // unlink-before-create happens to stop the write-through half in the
    // version pinned today; this pins the invariant rather than that detail.
    #[test]
    fn a_symlink_entry_never_becomes_a_write_outside_the_target() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let victim = elsewhere.path().join("authorized_keys");
        std::fs::write(&victim, b"original").unwrap();

        let archive = dir.path().join("asset.tar.gz");
        let unpack_to = dir.path().join("voice");
        std::fs::create_dir_all(&unpack_to).unwrap();
        tarball(
            &archive,
            &[
                Entry::Link("tts-voices/x/voice.onnx", &victim, tar::EntryType::Symlink),
                Entry::File("tts-voices/x/voice.onnx", b"pwned"),
            ],
        );

        // The lock matches the payload, so nothing but the symlink decides
        // where those bytes land.
        let files = manifest_files(5, &hex(Sha256::digest(b"pwned")));
        let manifest = Manifest {
            prefix: "tts-voices/x/".to_string(),
            files: &files,
        };
        let wanted = vec!["voice.onnx".to_string()];
        extract(&archive, &unpack_to, &manifest, &wanted).unwrap();

        assert_eq!(
            std::fs::read(&victim).unwrap(),
            b"original",
            "the archive wrote through a symlink and outside its directory"
        );
        let landed = unpack_to.join("voice.onnx");
        assert!(
            !landed.symlink_metadata().unwrap().file_type().is_symlink(),
            "a symlink was created in the target directory"
        );
        assert_eq!(std::fs::read(&landed).unwrap(), b"pwned");
    }

    // The disclosure half. A link entry named as one of the wanted files used
    // to be created, and the lock check then read straight through it — so the
    // "sha256 mismatch" the settings card renders described a file the archive
    // merely pointed at. Both link kinds, because both resolve on read.
    #[test]
    fn an_archive_of_nothing_but_links_extracts_nothing_and_refuses() {
        for kind in [tar::EntryType::Symlink, tar::EntryType::Link] {
            let dir = tempfile::tempdir().unwrap();
            let secret = dir.path().join("secret");
            std::fs::write(&secret, b"classified").unwrap();

            let archive = dir.path().join("asset.tar.gz");
            let unpack_to = dir.path().join("voice");
            std::fs::create_dir_all(&unpack_to).unwrap();
            tarball(
                &archive,
                &[Entry::Link("tts-voices/x/voice.onnx", &secret, kind)],
            );

            let files = manifest_files(10, &hex(Sha256::digest(b"classified")));
            let manifest = Manifest {
                prefix: "tts-voices/x/".to_string(),
                files: &files,
            };
            let wanted = vec!["voice.onnx".to_string()];
            let err = extract(&archive, &unpack_to, &manifest, &wanted)
                .expect_err("an archive carrying no file carries no voice");
            assert!(
                err.contains("carries no usable"),
                "{kind:?} leaked through the lock check: {err}"
            );

            assert!(
                unpack_to.join("voice.onnx").symlink_metadata().is_err(),
                "a {kind:?} was left behind in the target directory"
            );
            assert_eq!(std::fs::read(&secret).unwrap(), b"classified");
        }
    }

    // The guard must not reject what the release actually ships: GNU tar
    // types a regular file as '0', and scripts/build-release-asset.sh builds
    // the asset with the system tar.
    #[test]
    fn an_archive_built_by_the_system_tar_still_extracts() {
        let dir = tempfile::tempdir().unwrap();
        let stage = dir.path().join("stage/tts-voices/x");
        std::fs::create_dir_all(&stage).unwrap();
        std::fs::write(stage.join("voice.onnx"), b"weights").unwrap();

        let archive = dir.path().join("asset.tar.gz");
        let built = std::process::Command::new("tar")
            .arg("-C")
            .arg(dir.path().join("stage"))
            .arg("-czf")
            .arg(&archive)
            .arg("tts-voices")
            .status()
            .expect("the system tar runs");
        assert!(built.success());

        let unpack_to = dir.path().join("voice");
        std::fs::create_dir_all(&unpack_to).unwrap();
        let files = manifest_files(7, &hex(Sha256::digest(b"weights")));
        let manifest = Manifest {
            prefix: "tts-voices/x/".to_string(),
            files: &files,
        };
        extract(&archive, &unpack_to, &manifest, &["voice.onnx".to_string()])
            .expect("a release-shaped archive extracts");
        assert_eq!(
            std::fs::read(unpack_to.join("voice.onnx")).unwrap(),
            b"weights"
        );
    }

    // The platform tarball carries the binary, the voice and the vendored
    // speech-to-text checkpoint. A budget sized off the voice alone came to
    // 256 MiB, under the roughly 270 MB the combined asset weighs.
    #[test]
    fn the_budget_holds_the_whole_combined_asset_with_headroom() {
        const BINARY_ALLOWANCE: u64 = 64 * 1024 * 1024;
        let voice: u64 = crate::local_tts::voice_lock()
            .files
            .values()
            .map(|f| f.bytes)
            .sum();
        let vendored = &crate::local_stt::model_lock().vendored;
        let speech: u64 = crate::local_stt::locked_model(vendored)
            .expect("the vendored checkpoint is in the catalog")
            .files
            .values()
            .map(|f| f.bytes)
            .sum();
        let combined = voice + speech + BINARY_ALLOWANCE;
        assert!(
            DOWNLOAD_BUDGET >= combined + combined / 2,
            "{DOWNLOAD_BUDGET} leaves no headroom over {combined}"
        );
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
