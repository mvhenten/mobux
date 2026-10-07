// Every URL on screen as a real anchor over the cells it is drawn in, inside
// the touch overlay. A tap on one opens the URL outside the app shell; a
// long-press is left to the browser, so the first one gets its own link menu.
// Touches on an anchor bubble to the overlay, so a swipe that starts on a URL
// still scrolls. The anchors take the overlay's pointer-events, so a mouse
// and select mode reach the renderer and the select layer as before.

import { openExternal } from "./external-link.js";
import { layoutKey, rowsMoved, textGrid } from "./native-select.js";

// Per row, the runs of cells that draw one URL. The second cell of a wide
// character carries no URL of its own but belongs to the run it sits in.
function linkRuns(grid) {
  const runs = [];
  grid.links.forEach((hrefs, row) => {
    let run = null;
    hrefs.forEach((href, col) => {
      const cont = grid.rows[row].cells[col] === "" && run;
      if (cont || (run && href === run.href)) {
        run.end = col;
        return;
      }
      run = href ? { href, row, start: col, end: col } : null;
      if (run) runs.push(run);
    });
  });
  return runs;
}

export function createLinkLayer({ core, overlay }) {
  const layer = document.createElement("div");
  layer.className = "link-layer";
  overlay.append(layer);

  let shown = null;
  let frame = null;

  function render() {
    frame = null;
    const box = overlay.getBoundingClientRect();
    const layout = layoutKey(core);
    const cell = core.cellSize();
    const origin = core.cellOrigin();
    const place = [
      layout,
      origin.x - box.left,
      origin.y - box.top,
      cell.width,
      cell.height,
    ].join(":");
    if (shown && shown.place === place && !rowsMoved(core, shown.grid)) return;

    const grid = textGrid(core);
    shown = { place, grid };
    layer.replaceChildren(
      ...linkRuns(grid).map((run) => {
        const a = document.createElement("a");
        a.href = run.href;
        a.setAttribute("aria-label", run.href);
        a.style.left = `${origin.x - box.left + run.start * cell.width}px`;
        a.style.top = `${origin.y - box.top + run.row * cell.height}px`;
        a.style.width = `${(run.end - run.start + 1) * cell.width}px`;
        a.style.height = `${cell.height}px`;
        return a;
      }),
    );
  }

  const schedule = () => {
    if (frame === null) frame = requestAnimationFrame(render);
  };

  // The delegated external-link handler already opened an off-origin URL;
  // any other one still leaves the shell instead of navigating it.
  const onClick = (e) => {
    const anchor = e.target.closest("a[href]");
    if (!anchor || e.defaultPrevented) return;
    e.preventDefault();
    openExternal(anchor.href);
  };
  layer.addEventListener("click", onClick);

  const drawSub = core.onDraw(schedule);
  const bufferSub = core.onBufferChanged(schedule);
  core.addEventListener("panes", schedule);
  window.addEventListener("resize", schedule);
  schedule();

  return {
    dispose() {
      if (frame !== null) cancelAnimationFrame(frame);
      layer.removeEventListener("click", onClick);
      drawSub.dispose();
      bufferSub.dispose();
      core.removeEventListener("panes", schedule);
      window.removeEventListener("resize", schedule);
      layer.remove();
    },
  };
}
