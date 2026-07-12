import { useEffect } from "preact/hooks";
import { signal } from "@preact/signals";

// Theme picker. The theme catalogue + apply logic lives in the backend ES
// module /static/themes.js (single source of truth, also used by the terminal
// engine), so we dynamically import it at runtime rather than re-declare the
// palettes here. On change: persist via the module (which writes the
// server-held `theme` preference), apply live, and broadcast the same-doc
// 'mobux:theme' event so an open terminal tab swaps without reload.

const themes = signal([]); // [{ id, label }]
const current = signal("");
let mod = null;

export function ThemeCard() {
  useEffect(() => {
    // Load the backend ES module by absolute URL so it resolves to the running
    // host in both dev (Vite proxy) and prod (served from /static). The URL is
    // assembled at runtime so the bundler treats it as a genuine dynamic import
    // and leaves it external (does not try to resolve /static/themes.js itself).
    const themesUrl = new URL("/static/themes.js", location.origin).href;
    import(/* @vite-ignore */ themesUrl)
      .then((m) => {
        mod = m;
        themes.value = m.THEMES.map((t) => ({ id: t.id, label: t.label }));
        current.value = m.getStoredThemeId();
      })
      .catch((e) => {
        themes.value = [];
        current.value = "";
        console.warn("themes.js load failed", e);
      });
  }, []);

  const onChange = (e) => {
    const id = e.target.value;
    current.value = id;
    if (!mod) return;
    mod.setStoredThemeId(id);
    mod.applyTheme(id);
    window.dispatchEvent(new CustomEvent("mobux:theme", { detail: id }));
  };

  return (
    <section class="settings-group" id="theme-picker">
      <h2>Theme</h2>
      <p class="settings-lede">
        Sets the editor theme, terminal palette and reader palette together. All
        bundles are muted, low-contrast — picked for a phone screen at night.
        Switching applies live to any open terminal tab.
      </p>
      <label class="settings-row">
        <span class="settings-label">
          <strong>Colour theme</strong>
          <small>Synced to this mobux server.</small>
        </span>
        <select
          class="settings-select"
          value={current.value}
          onChange={onChange}
        >
          {themes.value.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}
