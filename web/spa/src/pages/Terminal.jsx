import { useLayoutEffect } from "preact/hooks";
import { TerminalIsland } from "../components/TerminalIsland.jsx";

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

  return (
    <TerminalIsland key={`${node || ""}/${name}`} node={node} session={name} />
  );
}
