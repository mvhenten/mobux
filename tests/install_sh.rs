use std::process::Command;

#[test]
fn install_script_regression_suite() {
    let repo = env!("CARGO_MANIFEST_DIR");
    let output = Command::new("bash")
        .arg("test/install.test.sh")
        .current_dir(repo)
        .output()
        .expect("failed to run test/install.test.sh");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "install.sh regression suite failed\n--- stdout ---\n{stdout}\n--- stderr ---\n{stderr}"
    );
}
