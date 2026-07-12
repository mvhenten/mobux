import { useLayoutEffect, useEffect, useState } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { TerminalIsland } from "../components/TerminalIsland.jsx";
import { recallSessionNode, rememberSessionNode } from "../lib/nodes.js";

// Full-bleed terminal route. The engine's CSS (style.css, loaded via the proxy)
// keys its full-screen layout off `body.term-body`, so we toggle that class for
// the lifetime of the route. The island is keyed on (node, session): a
// same-document navigation to a different pair unmounts the old island
// (disposing its engine) and mounts a fresh scaffold for the new one.
export function TerminalPage({ node, name }) {
  useLayoutEffect(() => {
    document.body.classList.add("term-body");
    return () => document.body.classList.remove("term-body");
  }, []);

  // A node-qualified entry (`#/s/<node>/<name>`) is the authoritative record of
  // where this session lives — remember it so a later node-less re-entry
  // (notification, saved link, restored tab) can recover the node instead of
  // silently attaching to the local host.
  useEffect(() => {
    if (node) rememberSessionNode(name, node);
  }, [node, name]);

  return (
    <TerminalIsland key={`${node || ""}/${name}`} node={node} session={name} />
  );
}

// Node-less route (`#/s/<name>`): a re-entry that lost the node segment. The
// node a session lives on rides only in the URL, so a deep-link by name alone
// (push.rs builds a node-less `/s/<name>`; the `/s/<name>` server redirect; a
// saved link) would otherwise boot the engine against the LOCAL host and show
// tmux's bare "can't find session". If we remember a node for this session AND
// it's still configured, redirect to the node-qualified route; otherwise fall
// through to a plain local attach (unchanged behavior, and the only correct
// one when nothing is remembered).
export function NodeLessTerminalRoute({ name }) {
  const [, navigate] = useLocation();
  const remembered = recallSessionNode(name);
  const [resolved, setResolved] = useState(!remembered);

  useEffect(() => {
    if (!remembered) return;
    let cancelled = false;
    (async () => {
      let stillConfigured = false;
      try {
        const res = await fetch("/api/nodes", {
          headers: { Accept: "application/json" },
          redirect: "manual",
        });
        if (res.ok) {
          const d = await res.json();
          stillConfigured = (d.nodes || []).some((n) => n.name === remembered);
        }
      } catch (_) {}
      if (cancelled) return;
      if (stillConfigured) {
        navigate(
          `/s/${encodeURIComponent(remembered)}/${encodeURIComponent(name)}`,
          { replace: true },
        );
        return;
      }
      // The remembered node is gone — never route to an unknown node. Forget it
      // and attach locally.
      rememberSessionNode(name, "");
      setResolved(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [name, remembered, navigate]);

  if (remembered && !resolved) return <div class="term-body-spa" />;
  return <TerminalPage name={name} />;
}
