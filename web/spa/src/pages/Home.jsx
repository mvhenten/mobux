import { useEffect } from 'preact/hooks';
import { signal } from '@preact/signals';
import { Link } from 'wouter-preact';
import { apiGet } from '../lib/api.js';

// Stub home page for phase 1: lists sessions so the terminal island is
// reachable from the SPA. The full home redesign is a later migration phase.
const sessions = signal(null);
const error = signal(null);

export function HomePage() {
  useEffect(() => {
    apiGet('/api/sessions')
      .then((data) => {
        sessions.value = Array.isArray(data) ? data : data.sessions || [];
      })
      .catch((e) => {
        error.value = String(e);
      });
  }, []);

  return (
    <section class="settings-card">
      <h2>Sessions</h2>
      {error.value && <p>Could not load sessions: {error.value}</p>}
      {sessions.value == null && !error.value && <p>Loading…</p>}
      {sessions.value && sessions.value.length === 0 && <p>No sessions.</p>}
      <ul>
        {(sessions.value || []).map((s) => {
          const name = typeof s === 'string' ? s : s.name;
          return (
            <li key={name}>
              <Link href={`/s/${encodeURIComponent(name)}`}>{name}</Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
