import { useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import { Link } from "wouter-preact";
import { UpdateCard } from "../components/settings/Update.jsx";
import { NotificationsCard } from "../components/settings/Notifications.jsx";
import { RendererCard } from "../components/settings/Renderer.jsx";
import { ThemeCard } from "../components/settings/Theme.jsx";
import { ShellIntegrationCard } from "../components/settings/ShellIntegration.jsx";
import { NodesCard } from "../components/settings/Nodes.jsx";
import { SttCard } from "../components/settings/Stt.jsx";
import { ListenCard } from "../components/settings/Listen.jsx";
import { BuildInfoCard } from "../components/settings/BuildInfo.jsx";

// Settings page. Composes the ported cards in the same order as the
// Rust-rendered /settings page (settings_page in src/main.rs): software update,
// install-app link, notifications, terminal renderer, theme, shell integration,
// nodes, speech-to-text, listen, build info.
//
// Native-mobile row list (#192): every card renders as a `.settings-group` —
// a heading plus edge-to-edge `.settings-row`s, no card chrome. That uniform
// row shape is what makes the search box below cheap: it doesn't know
// anything about STT or nodes or notifications, it just walks the rendered
// `.settings-row`/`.shell-card` elements and hides the ones whose text
// doesn't match, then hides a group entirely once none of its rows do.

const filterQuery = signal("");

function applyFilter(root, query) {
  if (!root) return;
  const q = query.trim().toLowerCase();
  for (const group of root.querySelectorAll(".settings-group")) {
    const rows = group.querySelectorAll(".settings-row, .shell-card");
    if (!q) {
      group.hidden = false;
      for (const row of rows) row.hidden = false;
      continue;
    }
    let anyVisible = rows.length === 0;
    for (const row of rows) {
      const match = row.textContent.toLowerCase().includes(q);
      row.hidden = !match;
      if (match) anyVisible = true;
    }
    group.hidden = !anyVisible && !group.textContent.toLowerCase().includes(q);
  }
}

export function SettingsPage() {
  const rootRef = useRef(null);

  useEffect(() => {
    const root = rootRef.current;
    applyFilter(root, filterQuery.value);
    // Cards resolve their content asynchronously (nodes list, theme
    // options, stt/shell-integration status, ...) well after mount, so
    // re-apply the current filter whenever the row set changes.
    const obs = new MutationObserver(() =>
      applyFilter(root, filterQuery.value),
    );
    obs.observe(root, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    applyFilter(rootRef.current, filterQuery.value);
  }, [filterQuery.value]);

  return (
    <main class="settings-page" ref={rootRef}>
      <div class="settings-search-wrap">
        <input
          type="search"
          class="settings-search"
          placeholder="Search settings"
          value={filterQuery.value}
          onInput={(e) => (filterQuery.value = e.target.value)}
        />
      </div>

      <UpdateCard />

      <section class="settings-group" id="install-app">
        <h2>Install app</h2>
        <Link href="/install" class="settings-row">
          <span class="settings-label">
            <strong>Add to home screen</strong>
            <small>
              CA certificate + APK with step-by-step install instructions.
            </small>
          </span>
          <span class="settings-row-chevron">›</span>
        </Link>
      </section>

      <NotificationsCard />
      <RendererCard />
      <ThemeCard />
      <ShellIntegrationCard />
      <NodesCard />
      <SttCard />
      <ListenCard />
      <BuildInfoCard />
    </main>
  );
}
