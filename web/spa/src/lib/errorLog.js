// Diagnostics ring buffer (#190, #191). A small always-on window.onerror /
// unhandledrejection log so a bug report carries the last things that went
// wrong in this tab, not just the one that triggered the report. Installed
// as a side effect of importing this module — main.jsx imports it first,
// before anything else, so nothing that boots after it goes uncaptured.

const MAX_ENTRIES = 20;
const buffer = [];
let installed = false;

function truncate(str, max = 800) {
  if (typeof str !== "string") return str;
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

function push(entry) {
  buffer.push({ time: new Date().toISOString(), ...entry });
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

// Recent errors, oldest first — included verbatim in the diagnostics bundle.
export function recentErrors() {
  return buffer.slice();
}

function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (e) => {
    push({
      type: "error",
      message: truncate(e.message),
      source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined,
      stack: truncate(e.error?.stack),
    });
  });

  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    push({
      type: "unhandledrejection",
      message: truncate(reason?.message || String(reason)),
      stack: truncate(reason?.stack),
    });
  });
}

install();
