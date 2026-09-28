import { useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import { localGet, localFetch } from "../../lib/api.js";
import { Group, Status, SwitchRow } from "./ui.jsx";

// Reads + writes GET|PUT /api/settings/notifications (snake_case fields) and
// saves on every switch change. Acts on the host that served the page.

const FIELDS = ["bell", "bell_emoji", "program_exit", "program_exit_nonzero"];
const prefs = signal({});
const status = signal(null);

const ROWS = [
  ["bell", "Terminal bell", "The BEL byte (\\x07) from any program"],
  ["bell_emoji", "Bell emoji", "A 🔔 printed by a script or agent"],
  ["program_exit", "Program exit", "Any exit code; needs OSC 133 prompts"],
  [
    "program_exit_nonzero",
    "Failed program exit",
    "Non-zero exits only; needs OSC 133",
  ],
];

export function NotificationsCard() {
  const t = useRef(null);

  const flash = (msg, ok = true) => {
    status.value = { msg, ok };
    clearTimeout(t.current);
    t.current = setTimeout(() => (status.value = null), 1500);
  };

  useEffect(() => {
    localGet("/api/settings/notifications")
      .then((p) => (prefs.value = p || {}))
      .catch((e) => flash("Load failed: " + e.message, false));
  }, []);

  const onToggle = (field) => async (e) => {
    prefs.value = { ...prefs.value, [field]: e.target.checked };
    const body = {};
    for (const k of FIELDS) body[k] = !!prefs.value[k];
    try {
      const res = await localFetch("/api/settings/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("PUT " + res.status);
      flash("Saved.");
    } catch (err) {
      flash("Save failed: " + err.message, false);
    }
  };

  return (
    <>
      <Group id="notifications" title="Notifications" data-row="notifications">
        {ROWS.map(([field, title, small]) => (
          <SwitchRow
            key={field}
            name={field}
            label={title}
            secondary={small}
            checked={!!prefs.value[field]}
            onChange={onToggle(field)}
          />
        ))}
      </Group>
      <Status id="notificationsStatus" status={status.value} />
    </>
  );
}
