import { openExternal } from "./external-link.js";
import { layoutKey, linkRuns, textGrid } from "./terminal-text.js";

const anchorOf = (target) => target?.closest?.(".link-layer a");

export function createLinkLayer({ core, overlay }) {
  const layer = document.createElement("div");
  layer.className = "link-layer";
  overlay.append(layer);

  let shown = "";
  let frame = null;

  function render() {
    frame = null;
    const grid = textGrid(core);
    const box = overlay.getBoundingClientRect();
    const x = grid.origin.x - box.left;
    const y = grid.origin.y - box.top;
    const { width, height } = grid.cell;
    const key = [layoutKey(core), grid.top, x, y, width, height, ...grid.keys];
    if (key.join("\n") === shown) return;
    shown = key.join("\n");
    layer.replaceChildren(
      ...linkRuns(grid.rows).map((run) => {
        const a = document.createElement("a");
        a.href = run.href;
        a.setAttribute("aria-label", run.href);
        a.style.left = `${x + run.start * width}px`;
        a.style.top = `${y + run.row * height}px`;
        a.style.width = `${(run.end - run.start + 1) * width}px`;
        a.style.height = `${height}px`;
        return a;
      }),
    );
  }

  const schedule = () => {
    if (frame === null) frame = requestAnimationFrame(render);
  };

  const drawSub = core.onDraw(schedule);
  window.addEventListener("resize", schedule);
  schedule();

  return {
    holds: (target) => !!anchorOf(target),
    open(target) {
      openExternal(anchorOf(target).href);
    },
    dispose() {
      if (frame !== null) cancelAnimationFrame(frame);
      drawSub.dispose();
      window.removeEventListener("resize", schedule);
      layer.remove();
    },
  };
}
