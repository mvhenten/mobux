import { useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import { localGet, localFetch } from "../../lib/api.js";

// Notifications card. Ports settings.js: reads + writes
// GET|PUT /api/settings/notifications (snake_case fields), auto-saves on every
// checkbox change. Prefs act on the host that served the page, so this uses the
// host-pinned helpers.

const FIELDS = ["bell", "bell_emoji", "program_exit", "program_exit_nonzero"];
const prefs = signal({});
const status = signal(null); // { msg, ok }

export function NotificationsCard() {
  const t = useRef(null);

  useEffect(() => {
    localGet("/api/settings/notifications")
      .then((p) => (prefs.value = p || {}))
      .catch((e) => flash("Load failed: " + e.message, false));
  }, []);

  const flash = (msg, ok = true) => {
    status.value = { msg, ok };
    clearTimeout(t.current);
    t.current = setTimeout(() => (status.value = null), 1500);
  };

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

  const row = (field, title, small) => (
    <label class="settings-row">
      <input
        type="checkbox"
        name={field}
        checked={!!prefs.value[field]}
        onChange={onToggle(field)}
      />
      <span class="settings-label">
        <strong>{title}</strong>
        <small>{small}</small>
      </span>
    </label>
  );

  return (
    <section class="settings-group">
      <h2>Notifications</h2>
      <p class="settings-lede">
        Pick what fires a push to subscribed devices. Everything is detected by
        parsing the PTY stream — no shell hooks needed except the OSC-133 prompt
        for the exit toggles.
      </p>
      {row(
        "bell",
        "Terminal bell (\\x07)",
        "Standard ASCII BEL byte. Most apps fire this on tab-complete failures, vim errors, irc highlights.",
      )}
      {row(
        "bell_emoji",
        "🔔 emoji in output",
        "Used for intentional pings — Claude, scripts, anything that prints the bell glyph.",
      )}
      {row(
        "program_exit",
        "Program exit (any code)",
        "Detected via OSC 133;D semantic prompt. Requires Starship, Powerlevel10k, or a PS1 that emits the exit marker.",
      )}
      {row(
        "program_exit_nonzero",
        "Program exit (non-zero only)",
        "Same OSC 133;D detection, fires only on failures.",
      )}
      {status.value && (
        <div
          class="settings-status"
          style={{ color: status.value.ok ? "" : "#f87171" }}
        >
          {status.value.msg}
        </div>
      )}
    </section>
  );
}
