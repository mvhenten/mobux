// Prefilled GitHub new-issue link (#190, #191). Title/body carry the
// diagnostics bundle so a bug can be filed in one tap with no manual
// copy-pasting — the browser's own GitHub session handles auth, no tokens
// involved. Mirrors the reporting convention already used by the dictation
// fault overlay (web/static/mic-overlay.js).
const REPORT_REPO = "mvhenten/mobux";
const MAX_BODY = 6000;
const MAX_TITLE = 200;

export function buildIssueUrl({ title, error, diagnostics }) {
  const body = truncate(formatBody(error, diagnostics), MAX_BODY);
  const params = new URLSearchParams({
    title: truncate(title, MAX_TITLE),
    body,
  });
  return `https://github.com/${REPORT_REPO}/issues/new?${params.toString()}`;
}

function formatBody(error, diagnostics) {
  const lines = [];
  if (error) {
    lines.push("## Error", "```", errorSummary(error));
    if (error.body) lines.push("", error.body);
    lines.push("```");
    if (error.stack) lines.push("", "### Stack", "```", error.stack, "```");
  }
  lines.push(
    "",
    "## Diagnostics",
    "```json",
    JSON.stringify(diagnostics, null, 2),
    "```",
  );
  return lines.join("\n");
}

export function errorSummary(error) {
  return `${error.method || ""} ${error.url || ""} -> ${
    error.status ?? "network error"
  }${error.statusText ? ` ${error.statusText}` : ""}`.trim();
}

function truncate(text, max) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 20)}\n…[truncated]` : text;
}
