import { useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { u } from "../../lib/base.js";
import { SelectRow } from "./ui.jsx";

// The theme catalogue + apply logic lives in the backend ES module
// /static/themes.js (also used by the terminal engine), so it is imported at
// runtime rather than re-declared here. On change: persist via the module,
// apply live, and broadcast 'mobux:theme' so an open terminal swaps without
// a reload.

const themes = signal([]);
const current = signal("");
let mod = null;

export function ThemeRow() {
  useEffect(() => {
    // Assembled at runtime so the bundler leaves it as a genuine dynamic
    // import that resolves against the running host.
    const themesUrl = new URL(u("/static/themes.js"), location.origin).href;
    import(/* @vite-ignore */ themesUrl)
      .then((m) => {
        mod = m;
        themes.value = m.THEMES.map((t) => ({ value: t.id, label: t.label }));
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
    <SelectRow
      rowId="theme-picker"
      row="theme"
      label="Colour theme"
      secondary="Terminal, reader and editor"
      value={current.value}
      options={themes.value}
      onChange={onChange}
    />
  );
}
