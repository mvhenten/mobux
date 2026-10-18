import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { TerminalIsland } from "../components/TerminalIsland.jsx";
import { FullPage } from "../components/ErrorPage.jsx";
import { apiGet, apiSend } from "../lib/api.js";
import { withNode } from "../lib/nodes.js";

// Full-bleed terminal route. The engine's CSS (style.css, loaded via the proxy)
// keys its full-screen layout off `body.term-body`, so we toggle that class for
// the lifetime of the route. The island is keyed on (node, session): a
// same-document navigation to a different pair unmounts the old island
// (disposing its engine) and mounts a fresh scaffold for the new one.
//
// A node-less entry (`#/s/<name>`, no node segment) means the local host —
// this component never guesses otherwise. Making a bare session-name link
// (a push notification, a bookmark) resolve to the RIGHT node is a
// server-side concern: `push.rs::session_url` only ever names the hub's own
// local tmux (the alert-bell hook is hub-local only), and the legacy
// `/s/{name}` redirect (`terminal_page` in src/main.rs) resolves an
// ambiguous/hand-typed name against the real session inventory (local +
// every configured node) before it ever reaches the SPA — see
// `resolve_session_location` there (issue #210).
export function TerminalPage({ node, name }) {
  return (
    <TerminalRoute key={`${node || ""}/${name}`} node={node} name={name} />
  );
}

// A bookmarked session can be gone, or its host can have no tmux server at
// all; attaching then leaves tmux's one-line complaint on an empty terminal.
// The session list decides first. A list that cannot be read (a node that is
// unreachable, say) still boots the terminal, which shows the ssh diagnostic.
async function sessionPresence(node, name) {
  const sessions = await apiGet(withNode("/api/sessions", node));
  if (sessions.length === 0) return "no-tmux";
  if (sessions.some((s) => s.name === name)) return "present";
  return "missing";
}

function TerminalRoute({ node, name }) {
  const [presence, setPresence] = useState("checking");

  useEffect(() => {
    sessionPresence(node, name)
      .catch((e) => (e.signedOut ? "signed-out" : "unknown"))
      .then(setPresence);
  }, []);

  if (presence === "checking" || presence === "signed-out") return null;
  if (presence === "missing" || presence === "no-tmux") {
    return (
      <SessionGone
        node={node}
        name={name}
        presence={presence}
        onCreated={() => setPresence("present")}
      />
    );
  }
  return <TerminalScreen node={node} name={name} />;
}

function TerminalScreen({ node, name }) {
  useLayoutEffect(() => {
    document.body.classList.add("term-body");
    return () => document.body.classList.remove("term-body");
  }, []);

  return <TerminalIsland node={node} session={name} />;
}

function SessionGone({ node, name, presence, onCreated }) {
  const [, navigate] = useLocation();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);
  const host = node || "this host";
  const summary =
    presence === "no-tmux"
      ? `${host} has no tmux session running.`
      : `This session no longer exists on ${host}.`;

  const create = () => {
    setCreating(true);
    setCreateError(null);
    apiSend(withNode("/api/sessions", node), {
      method: "POST",
      body: JSON.stringify({ name }),
    })
      .then(onCreated)
      .catch((e) => {
        setCreating(false);
        setCreateError(
          `Could not create session '${name}' on ${host}: ${e.body || e.message}`,
        );
      });
  };

  return (
    <FullPage
      id="sessionGone"
      tone="notice"
      title={`Session '${name}' is gone`}
      summary={summary}
    >
      {createError && <pre class="fatal-error-block">{createError}</pre>}
      <div class="fatal-error-actions">
        <button
          id="sessionGoneHome"
          type="button"
          class="fatal-error-reload-btn"
          onClick={() => navigate("/")}
        >
          Back to dashboard
        </button>
        <button
          id="sessionGoneCreate"
          type="button"
          class="fatal-error-reload-btn"
          disabled={creating}
          onClick={create}
        >
          New session
        </button>
      </div>
    </FullPage>
  );
}
