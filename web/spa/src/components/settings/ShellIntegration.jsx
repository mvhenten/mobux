import { useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { localGet, localFetch } from "../../lib/api.js";
import { Actions, Button, Group, Lede, NavRow, Status } from "./ui.jsx";

// Shell integration installer. Ports shell-integration.js: reads
// GET /api/shell-integration/status, drives Install/Uninstall via
// POST /api/shell-integration/{install,uninstall} with a {shell} body. Acts on
// the host that served the page (host-pinned helpers). The OSC-133 snippets are
// static display content (verbatim from the Rust template).

// Static literal snippets kept in sync manually with the Rust installer.
// The Playwright test verifySnippetMatchesInstalled (test/spa.spec.cjs)
// guards against drift: it fails CI if the displayed snippet diverges from
// what actually gets installed.
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
const loaded = signal(false);

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

let flashTimer = null;
function flash(msg, ok = true) {
  status.value = { msg, ok };
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (status.value = null), ok ? 2000 : 6000);
}

function load() {
  localGet("/api/shell-integration/status")
    .then((p) => {
      states.value = p || {};
      loaded.value = true;
    })
    .catch((e) => flash("Load failed: " + e.message, false));
}

function installedSummary() {
  if (!loaded.value) return "…";
  const on = SHELLS.filter((sh) => {
    const st = states.value[sh.id]?.state;
    return st === "installed" || st === "outdated";
  }).map((sh) => sh.id);
  return on.length ? on.join(", ") : "None";
}

export function ShellIntegrationRow() {
  useEffect(load, []);
  return (
    <NavRow
      row="shell"
      to="/settings/shell"
      label="Shell integration"
      secondary="OSC 133 prompt markers"
      value={installedSummary()}
    />
  );
}

export function ShellIntegrationCard() {
  useEffect(load, []);

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
    <div id="shell-integration">
      <Lede>
        The reader sorts prompts from output exactly when your shell emits{" "}
        <a
          href="https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md"
          target="_blank"
          rel="noopener noreferrer"
        >
          OSC 133
        </a>{" "}
        markers. Install adds a fenced block to the rc file, backs the file up
        first, and touches nothing outside the fence. Restart the shell after.
      </Lede>

      {SHELLS.map((sh) => {
        const s = states.value[sh.id];
        const d = describe(s);
        const isInstalled = s && s.state === "installed";
        const isOutdated = s && s.state === "outdated";
        return (
          <Group key={sh.id}>
            <div class="shell-card" data-shell={sh.id}>
              <div class="settings-row">
                <span class="settings-label">
                  <span class="settings-title">{sh.id}</span>
                  <small>
                    <code>{sh.rc}</code>
                  </small>
                </span>
                <span class={"shell-state " + d.cls} data-role="state">
                  {d.label}
                </span>
              </div>
              <Actions>
                <Button
                  variant="primary"
                  disabled={isInstalled}
                  onClick={() => act("install", sh.id)}
                >
                  {isInstalled
                    ? "Reinstall"
                    : isOutdated
                      ? "Update"
                      : "Install"}
                </Button>
                <Button
                  variant="secondary"
                  disabled={!(isInstalled || isOutdated)}
                  onClick={() => act("uninstall", sh.id)}
                >
                  Uninstall
                </Button>
              </Actions>
              <details class="settings-detail">
                <summary class="settings-row">
                  <span class="settings-title">Show snippet</span>
                </summary>
                <pre class="settings-snippet">
                  <code>{sh.snippet}</code>
                </pre>
              </details>
            </div>
          </Group>
        );
      })}

      <Status id="shellStatus" status={status.value} />
    </div>
  );
}
