import { useLayoutEffect } from "preact/hooks";
import { TerminalIsland } from "../components/TerminalIsland.jsx";

// Full-bleed terminal route. The engine's CSS (style.css, loaded via the proxy)
// keys its full-screen layout off `body.term-body`, so we toggle that class for
// the lifetime of the route. The island itself never re-renders.
export function TerminalPage({ name }) {
  useLayoutEffect(() => {
    document.body.classList.add("term-body");
    return () => document.body.classList.remove("term-body");
  }, []);

  return <TerminalIsland session={name} />;
}
