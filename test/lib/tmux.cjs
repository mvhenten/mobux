// Shared tmux-invocation safety helper for the Playwright suite.
//
// Every spec that drives a scoped tmux server (smoke, critical-path, spa,
// mesh-relay) goes through here instead of shelling out to `tmux` directly.
// Born from issue #183: a fleet-e2e teardown's `kill-server` hit the real
// default tmux server because $TMUX, inherited from the calling shell,
// outranked the isolation the harness thought it had. tmux resolves its
// socket in priority order -S > -L > $TMUX > TMUX_TMPDIR/default, so an
// inherited $TMUX silently wins over env-based isolation (TMUX_TMPDIR) and
// can confuse even an explicit -L on some builds. This helper enforces two
// things for every invocation:
//
//   1. The child never inherits $TMUX / $TMUX_PANE.
//   2. A command that can't be proven to target an isolated socket refuses
//      to run — loudly — instead of silently falling through to the
//      default. "Proven isolated" means an explicit -L/-S naming something
//      other than "default", or a delegated runner (podman exec ... tmux)
//      whose isolation comes from the container, not the flag.

const { execSync } = require("child_process");

function sanitizedEnv(base = process.env) {
  const env = { ...base };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

const SOCKET_FLAG_RE = /(?:^|\s)-(?:L|S)\s+(\S+)/;

function isDelegatedCommand(cmdPrefix) {
  return !/^\s*tmux(\s|$)/.test(cmdPrefix);
}

function resolveSocketName(cmdPrefix) {
  const match = cmdPrefix.match(SOCKET_FLAG_RE);
  return match ? match[1] : null;
}

function assertIsolated(cmdPrefix, args) {
  const delegated = isDelegatedCommand(cmdPrefix);
  const socket = resolveSocketName(cmdPrefix);
  if (delegated || (socket && socket !== "default")) return;

  throw new Error(
    `tmux-safety: refusing "${cmdPrefix} ${args}" — no explicit -L/-S test ` +
      `socket and not a delegated runner (e.g. podman exec ... tmux). This ` +
      `would target the host's default tmux server. See issue #183.`,
  );
}

function buildInvocation(cmdPrefix, args) {
  assertIsolated(cmdPrefix, args);
  return {
    command: `${cmdPrefix} ${args}`,
    options: { stdio: "pipe", env: sanitizedEnv() },
  };
}

// `envVar`, if set in process.env, overrides the default socket entirely —
// e.g. MOBUX_TEST_TMUX="podman exec mobux-podman tmux" for `make
// podman-test`. Pass envVar: null to disable the override (mesh-relay's
// peer always owns its own dedicated socket, never the podman lane's).
function createTmuxRunner(
  defaultSocket,
  { envVar = "MOBUX_TEST_TMUX", exec = execSync } = {},
) {
  const cmdPrefix =
    (envVar && process.env[envVar]) || `tmux -L ${defaultSocket}`;
  return (args) => {
    const { command, options } = buildInvocation(cmdPrefix, args);
    return exec(command, options);
  };
}

module.exports = {
  createTmuxRunner,
  sanitizedEnv,
  assertIsolated,
  buildInvocation,
};
