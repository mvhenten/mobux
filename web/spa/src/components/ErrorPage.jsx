import { useEffect, useState } from "preact/hooks";
import { collectDiagnostics } from "../lib/diagnostics.js";
import { buildIssueUrl, errorSummary } from "../lib/githubIssue.js";
import { clearFatal } from "../lib/fatalError.js";

// Full-screen page that replaces whatever was on screen: a heading, a summary
// line, optional detail, and the actions that get the user out of it.
export function FullPage({ id, tone = "fatal", title, summary, children }) {
  return (
    <div
      id={id}
      class={`fatal-error-page fatal-error-page--${tone}`}
      role="alert"
    >
      <div class="fatal-error-inner">
        <h1>{title}</h1>
        <p class="fatal-error-summary">{summary}</p>
        {children}
      </div>
    </div>
  );
}

// Full-screen, unmissable fail-hard page (#190). Renders in place of the
// entire app the instant a server API call fails without being caught
// somewhere more specific — see lib/fatalError.js for the trigger.
export function ErrorPage({ error }) {
  const [diagnostics, setDiagnostics] = useState(null);

  useEffect(() => {
    collectDiagnostics().then(setDiagnostics);
  }, []);

  const summary = errorSummary(error);
  const issueUrl = diagnostics
    ? buildIssueUrl({ title: `Bug: ${summary}`, error, diagnostics })
    : null;

  return (
    <FullPage title="Something broke" summary={summary}>
      {error.body && <pre class="fatal-error-block">{error.body}</pre>}

      {error.stack && (
        <details open>
          <summary>Stack</summary>
          <pre class="fatal-error-block">{error.stack}</pre>
        </details>
      )}

      <details>
        <summary>Diagnostics</summary>
        <pre class="fatal-error-block">
          {diagnostics ? JSON.stringify(diagnostics, null, 2) : "collecting…"}
        </pre>
      </details>

      <div class="fatal-error-actions">
        <a
          class="fatal-error-report-btn"
          href={issueUrl || "#"}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={issueUrl ? undefined : "true"}
        >
          Report on GitHub
        </a>
        <button
          type="button"
          class="fatal-error-reload-btn"
          onClick={() => {
            clearFatal();
            location.reload();
          }}
        >
          Reload
        </button>
      </div>
    </FullPage>
  );
}
