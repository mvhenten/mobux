// Page and session helpers shared by the specs that drive a live terminal
// through a real tmux session (critical-path, touch-select).

const { execSync } = require("child_process");

// One window, one pane, no half-typed command line, a known prompt and a
// cleared screen.
function resetSession(tmux, session) {
  const firstWindow = tmux(`list-windows -t ${session} -F '#{window_id}'`)
    .toString()
    .trim()
    .split("\n")[0];
  tmux(`kill-window -a -t ${firstWindow}`);
  const firstPane = tmux(`list-panes -t ${firstWindow} -F '#{pane_id}'`)
    .toString()
    .trim()
    .split("\n")[0];
  tmux(`kill-pane -a -t ${firstPane}`);
  tmux(`select-pane -t ${firstPane}`);
  tmux(`send-keys -t ${firstPane} C-c`);
  tmux(`send-keys -t ${firstPane} "PS1='\\$ '" Enter`);
  tmux(`send-keys -t ${firstPane} "clear" Enter`);
  execSync("sleep 0.3");
}

async function bootTerminal(page, base, session) {
  await page.goto(`${base}/app#/s/${session}`, { waitUntil: "load" });
  // Wait for the renderer to mount AND have visible dimensions —
  // renderer-agnostic.
  await page.waitForFunction(
    () => {
      const t = document.getElementById("terminal");
      if (!t || t.classList.contains("hidden")) return false;
      const r = t.getBoundingClientRect();
      return r.width > 50 && r.height > 50;
    },
    { timeout: 8000 },
  );
  // Wait for the WS to be open and the buffer to have at least the
  // initial PS1 redraw.
  await page.waitForFunction(
    () => window.__mobuxView?.test?.wsReady?.() === true,
    { timeout: 8000 },
  );
  // Sterk schedules the initial resize() inside ws.onopen which fires
  // synchronously with the WS handshake. The PTY needs to receive the
  // resize before keystrokes will be processed at the new dimensions;
  // wait one beat for the resize round-trip.
  await page.waitForTimeout(500);
}

// A synthetic single-finger touch on the overlay, in client coordinates.
function touch(page, type, x, y) {
  return page.evaluate(
    ({ type, x, y }) => {
      const overlay = document.getElementById("touchOverlay");
      overlay.style.pointerEvents = "auto";
      const t = new Touch({
        identifier: 1,
        target: overlay,
        clientX: x,
        clientY: y,
        pageX: x + window.scrollX,
        pageY: y + window.scrollY,
      });
      overlay.dispatchEvent(
        new TouchEvent(type, {
          touches: type === "touchend" ? [] : [t],
          changedTouches: [t],
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { type, x, y },
  );
}

module.exports = { resetSession, bootTerminal, touch };
