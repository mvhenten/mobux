import { useLayoutEffect } from "preact/hooks";
import { TerminalIsland } from "../components/TerminalIsland.jsx";

// Full-bleed terminal route. The engine's CSS (style.css, loaded via the proxy)
// keys its full-screen layout off `body.term-body`, so we toggle that class for
// the lifetime of the route. The island itself never re-renders.
export function TerminalPage({ node, name }) {
  useLayoutEffect(() => {
    const html = document.documentElement;
    const prevHtmlAc = html.getAttribute("autocomplete");
    const prevBodyAc = document.body.getAttribute("autocomplete");
    document.body.classList.add("term-body");
    html.setAttribute("autocomplete", "off");
    document.body.setAttribute("autocomplete", "off");
    return () => {
      document.body.classList.remove("term-body");
      if (prevHtmlAc === null) html.removeAttribute("autocomplete");
      else html.setAttribute("autocomplete", prevHtmlAc);
      if (prevBodyAc === null) document.body.removeAttribute("autocomplete");
      else document.body.setAttribute("autocomplete", prevBodyAc);
    };
  }, []);

  return <TerminalIsland node={node} session={name} />;
}
