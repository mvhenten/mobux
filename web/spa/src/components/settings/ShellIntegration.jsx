import { useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import { localGet, localFetch } from "../../lib/api.js";

// Shell integration installer. Ports shell-integration.js: reads
// GET /api/shell-integration/status, drives Install/Uninstall via
// POST /api/shell-integration/{install,uninstall} with a {shell} body. Acts on
// the host that served the page (host-pinned helpers). The OSC-133 snippets are
// static display content (verbatim from the Rust template).

// Verbatim from src/shell_integration.rs's BASH_SNIPPET / ZSH_SNIPPET /
// FISH_SNIPPET (the single Rust source both the installer and tmux.rs's
// session auto-injection build on) — transcribed via
// `serde_json::to_string` on the Rust constants, never hand-typed, so a
// future snippet change can't silently drift from this display copy. A
// Playwright test (`settings: <shell> OSC 133 snippet shown in the UI
// matches what actually gets installed`) pins the two together.
const SHELLS = [
  {
    id: "bash",
    rc: "~/.bashrc",
    snippet:
      "if [ -n \"$TMUX\" ]; then\n    PS0='\\ePtmux;\\e\\e]133;C\\a\\e\\\\'\n    PS1='\\[\\ePtmux;\\e\\e]133;D;$?\\a\\e\\e]133;A\\a\\e\\\\\\]'\"$PS1\"'\\[\\ePtmux;\\e\\e]133;B\\a\\e\\\\\\]'\nelse\n    PS0='\\e]133;C\\a'\n    PS1='\\[\\e]133;D;$?\\a\\e]133;A\\a\\]'\"$PS1\"'\\[\\e]133;B\\a\\]'\nfi",
  },
  {
    id: "zsh",
    rc: "~/.zshrc",
    snippet:
      "if [ -n \"$TMUX\" ]; then\n    preexec() { print -Pn '\\ePtmux;\\e\\e]133;C\\a\\e\\\\' }\n    PROMPT=$'%{\\ePtmux;\\e\\e]133;D;%?\\a\\e\\e]133;A\\a\\e\\\\%}'\"$PROMPT\"\nelse\n    preexec() { print -Pn '\\e]133;C\\a' }\n    precmd()  { print -Pn '\\e]133;D;'$?'\\a\\e]133;A\\a' }\nfi",
  },
  {
    id: "fish",
    rc: "~/.config/fish/config.fish",
    snippet:
      "if test -n \"$TMUX\"\n    function __mobux_osc133_preexec --on-event fish_preexec\n        printf '\\ePtmux;\\e\\e]133;C\\a\\e\\\\'\n    end\n    function __mobux_osc133_postexec --on-event fish_postexec\n        printf '\\ePtmux;\\e\\e]133;D;%s\\a\\e\\\\' $status\n    end\n    function __mobux_osc133_prompt --on-event fish_prompt\n        printf '\\ePtmux;\\e\\e]133;A\\a\\e\\\\'\n    end\nelse\n    function __mobux_osc133_preexec --on-event fish_preexec\n        printf '\\e]133;C\\a'\n    end\n    function __mobux_osc133_postexec --on-event fish_postexec\n        printf '\\e]133;D;%s\\a' $status\n    end\n    function __mobux_osc133_prompt --on-event fish_prompt\n        printf '\\e]133;A\\a'\n    end\nend",
  },
];

const states = signal({}); // { bash: {state, version}, ... }
const status = signal(null); // { msg, ok }

function describe(s) {
  if (!s || !s.state) return { label: "unknown", cls: "" };
  switch (s.state) {
    case "not_present":
      return { label: "rc file not present", cls: "shell-state--missing" };
    case "not_installed":
      return { label: "not installed", cls: "shell-state--off" };
    case "installed":
      return { label: `installed v${s.version}`, cls: "shell-state--on" };
    case "outdated":
      return {
        label: `outdated (v${s.version}→current)`,
        cls: "shell-state--warn",
      };
    default:
      return { label: s.state, cls: "" };
  }
}

export function ShellIntegrationCard() {
  const t = useRef(null);

  useEffect(() => {
    localGet("/api/shell-integration/status")
      .then((p) => (states.value = p || {}))
      .catch((e) => flash("Load failed: " + e.message, false));
  }, []);

  const flash = (msg, ok = true) => {
    status.value = { msg, ok };
    clearTimeout(t.current);
    t.current = setTimeout(() => (status.value = null), 2000);
  };

  const act = async (action, shell) => {
    try {
      const res = await localFetch(`/api/shell-integration/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shell }),
      });
      if (!res.ok)
        throw new Error(`${action} ${res.status}: ${await res.text()}`);
      states.value = await res.json();
      flash(`${shell}: ${action} ok`);
    } catch (err) {
      flash(`${shell} ${action} failed: ${err.message}`, false);
    }
  };

  return (
    <section class="settings-group" id="shell-integration">
      <h2>Shell integration</h2>
      <p class="settings-lede">
        The reader view classifies prompts and command output deterministically
        when your shell emits{" "}
        <a
          href="https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md"
          target="_blank"
          rel="noopener noreferrer"
        >
          OSC 133
        </a>{" "}
        (FinalTerm) markers. Click install — mobux appends a managed, fenced
        block to your rc file and keeps a timestamped backup. Nothing outside
        the fence is touched. The snippet detects <code>$TMUX</code> and wraps
        OSC 133 in tmux's DCS passthrough envelope.
      </p>

      {SHELLS.map((sh) => {
        const s = states.value[sh.id];
        const d = describe(s);
        const isInstalled = s && s.state === "installed";
        const isOutdated = s && s.state === "outdated";
        return (
          <div class="shell-card" data-shell={sh.id} key={sh.id}>
            <div class="shell-card-head">
              <strong>{sh.id}</strong> <code>{sh.rc}</code>
              <span class={"shell-state " + d.cls} data-role="state">
                {d.label}
              </span>
            </div>
            <div class="settings-actions">
              <button
                type="button"
                disabled={isInstalled}
                onClick={() => act("install", sh.id)}
              >
                {isInstalled ? "Reinstall" : isOutdated ? "Update" : "Install"}
              </button>
              <button
                type="button"
                disabled={!(isInstalled || isOutdated)}
                onClick={() => act("uninstall", sh.id)}
              >
                Uninstall
              </button>
            </div>
            <details class="settings-detail">
              <summary>Show snippet</summary>
              <pre class="settings-snippet">
                <code>{sh.snippet}</code>
              </pre>
            </details>
          </div>
        );
      })}

      {status.value && (
        <div
          class="settings-status"
          style={{ color: status.value.ok ? "" : "#f87171" }}
        >
          {status.value.msg}
        </div>
      )}
      <p class="settings-foot">
        Reload the shell after installing. The fenced block is the contract —
        mobux only ever modifies what's between the fences. A timestamped{" "}
        <code>.mobux.bak.&lt;ts&gt;</code> is written next to the rc file before
        any change.
      </p>
    </section>
  );
}
