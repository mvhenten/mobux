import { signal } from "@preact/signals";

// Fail-hard error page state (#190). Set once — from the FIRST unhandled
// failure, since a later one would just bury the context the user is
// already looking at.
export const fatalError = signal(null);

export function reportFatal(details) {
  if (fatalError.value) return;
  fatalError.value = { at: new Date().toISOString(), ...details };
}

export function clearFatal() {
  fatalError.value = null;
}

// Duck-typed rather than `instanceof ApiError` — the check only needs the
// shape (an error object with the fields ApiError sets), which also makes it
// exercisable from a test without reaching into the bundle's module graph.
function isApiError(reason) {
  return (
    !!reason &&
    typeof reason === "object" &&
    reason.name === "ApiError" &&
    "method" in reason
  );
}

function detailsFromApiError(err) {
  return {
    method: err.method,
    url: err.url,
    status: err.status,
    statusText: err.statusText,
    body: err.body,
    stack: err.stack,
  };
}

// The centralizing piece (#190): apiGet/apiSend/localGet (./api.js) throw an
// ApiError on any non-ok response or network failure. A call site that
// already handles it — a try/catch, a `.catch()` that flashes an inline
// status — keeps working exactly as before, since that rejection is not
// "unhandled". This only fires for the ones nobody catches: precisely the
// "swallowed error / dead widget" pattern the fail-hard page exists to end,
// with no per-call boilerplate required — importing this module once (from
// app.jsx) arms it for every current and future call site.
if (typeof window !== "undefined") {
  window.addEventListener("unhandledrejection", (event) => {
    if (isApiError(event.reason)) {
      reportFatal(detailsFromApiError(event.reason));
    }
  });
}
