use std::path::Path;

const SPA_INDEX: &str = "web/static/spa/index.html";

fn main() {
    println!("cargo:rerun-if-changed={SPA_INDEX}");
    println!("cargo:rerun-if-changed=build.rs");

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    let root = Path::new(&manifest_dir);
    if root.join(SPA_INDEX).is_file() {
        return;
    }

    // `cargo package` writes Cargo.toml.orig into every packaged crate, so its
    // presence means this is a published crate (or the publish verification
    // build), where a missing app can only be a packaging fault.
    if root.join("Cargo.toml.orig").is_file() {
        panic!(
            "{SPA_INDEX} is missing from the packaged crate: the settings app was not \
             shipped, so the binary would serve 404 on /app. Run `node web/build.js` \
             before `cargo package` and check the `include` list in Cargo.toml."
        );
    }

    println!(
        "cargo:warning={SPA_INDEX} is missing: /app will 404 until you run `make web` \
         (node web/build.js) and rebuild"
    );
}
