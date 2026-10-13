import { useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import { getPref, setPref } from "../../lib/prefs.js";
import { buildIssueUrl } from "../../lib/githubIssue.js";
import {
  RENDERER_LABELS,
  describeProbeFailure,
  probeRenderer,
} from "../../lib/rendererProbe.js";
import { SelectRow } from "./ui.jsx";

// Reads + writes the server-held `renderer` preference ('xterm' | 'sterk'),
// global across devices. The terminal island reads it on boot, so a change
// applies after an open terminal reloads. A switch is saved only after the
// target renderer passes an in-browser probe: a renderer that cannot load
// would leave the phone without a terminal.

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
const checking = signal(false);
const failure = signal(null);

function ProbeFailure({ target, result }) {
  const { what, fix } = describeProbeFailure(target, result);
  const report = buildIssueUrl({
    title: `Renderer check failed: ${RENDERER_LABELS[target]}`,
    diagnostics: { renderer: target, probe: result },
  });
  return (
    <div
      id="renderer-probe-error"
      class="settings-status settings-status--error"
      role="alert"
    >
      <p class="settings-status-full">
        {what} {fix} Kept {RENDERER_LABELS[renderer.value]}.
      </p>
      <a href={report} target="_blank" rel="noopener noreferrer">
        Report an issue
      </a>
    </div>
  );
}

export function RendererRow() {
  const t = useRef(null);

  useEffect(() => {
    renderer.value = read();
  }, []);

  const onChange = async (e) => {
    const target = VALID.has(e.target.value) ? e.target.value : DEFAULT;
    clearTimeout(t.current);
    failure.value = null;
    if (target === renderer.value) return;
    checking.value = true;
    status.value = `Checking ${RENDERER_LABELS[target]}…`;
    const result = await probeRenderer(target);
    checking.value = false;
    if (!result.ok) {
      e.target.value = renderer.value;
      status.value = null;
      failure.value = { target, result };
      return;
    }
    renderer.value = target;
    await setPref("renderer", target);
    status.value = "Saved. Reload open terminals to apply.";
    t.current = setTimeout(() => (status.value = null), 3000);
  };

  return (
    <>
      <SelectRow
        rowId="renderer-picker"
        row="renderer"
        label="Terminal renderer"
        secondary={
          status.value ? (
            <span
              class={
                "settings-status" +
                (checking.value ? "" : " settings-status--ok")
              }
            >
              {status.value}
            </span>
          ) : (
            "Applies when a terminal reloads"
          )
        }
        value={renderer.value}
        options={OPTIONS}
        onChange={onChange}
        disabled={checking.value}
      />
      {failure.value && <ProbeFailure {...failure.value} />}
    </>
  );
}
