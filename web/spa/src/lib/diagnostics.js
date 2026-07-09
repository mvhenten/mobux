import { localGet } from "./api.js";
import { recentErrors } from "./errorLog.js";

// Diagnostics bundle (#190, #191): everything a bug report needs to
// reproduce or triage an issue without asking the reporter to dig it up by
// hand. Shared by the fail-hard error page and the ribbon bug-report button.
// Both build-info calls are best-effort (Promise.allSettled) — a diagnostics
// bundle that's missing a hash is still far better than one that never
// renders because /api/build-info itself is down.
export async function collectDiagnostics() {
  const [buildInfo, feInfo] = await Promise.allSettled([
    localGet("/api/build-info"),
    localGet("/static/build-info.json"),
  ]);

  return {
    timestamp: new Date().toISOString(),
    appVersion: settledValue(buildInfo)?.version ?? null,
    serverBuildHash: settledValue(buildInfo)?.build_hash ?? null,
    spaBundleHash: settledValue(feInfo)?.hash ?? null,
    route: location.hash || location.pathname,
    node: nonEmpty(window.MOBUX_NODE),
    session: nonEmpty(window.MOBUX_SESSION),
    userAgent: navigator.userAgent,
    recentErrors: recentErrors(),
  };
}

function settledValue(settled) {
  return settled.status === "fulfilled" ? settled.value : null;
}

function nonEmpty(v) {
  return v ? v : null;
}
