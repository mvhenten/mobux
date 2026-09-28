import { useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import { getPref, setPref } from "../../lib/prefs.js";
import { SelectRow } from "./ui.jsx";

// Reads + writes the server-held `renderer` preference ('xterm' | 'sterk'),
// global across devices. The terminal island reads it on boot, so a change
// applies after an open terminal reloads.

const VALID = new Set(["xterm", "sterk"]);
const DEFAULT = "xterm";
const OPTIONS = [
  { value: "xterm", label: "xterm.js" },
  { value: "sterk", label: "sterk (experimental)" },
];

function read() {
  const v = getPref("renderer");
  return VALID.has(v) ? v : DEFAULT;
}

// Seeded to DEFAULT, not read(): this module evaluates in the static import
// chain before main.jsx's boot() has awaited prefs.hydrate(). The mount
// effect reads the server value, after hydrate() resolved.
const renderer = signal(DEFAULT);
const status = signal(null);

export function RendererRow() {
  const t = useRef(null);

  useEffect(() => {
    renderer.value = read();
  }, []);

  const onChange = (e) => {
    const v = VALID.has(e.target.value) ? e.target.value : DEFAULT;
    renderer.value = v;
    setPref("renderer", v);
    status.value = "Saved. Reload open terminals to apply.";
    clearTimeout(t.current);
    t.current = setTimeout(() => (status.value = null), 3000);
  };

  return (
    <SelectRow
      rowId="renderer-picker"
      row="renderer"
      label="Terminal renderer"
      secondary={
        status.value ? (
          <span class="settings-status settings-status--ok">
            {status.value}
          </span>
        ) : (
          "Applies when a terminal reloads"
        )
      }
      value={renderer.value}
      options={OPTIONS}
      onChange={onChange}
    />
  );
}
