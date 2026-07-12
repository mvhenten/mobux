import { useLayoutEffect } from "preact/hooks";
import { TerminalIsland } from "../components/TerminalIsland.jsx";

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
  useLayoutEffect(() => {
    document.body.classList.add("term-body");
    return () => document.body.classList.remove("term-body");
  }, []);

  return (
    <TerminalIsland key={`${node || ""}/${name}`} node={node} session={name} />
  );
}
