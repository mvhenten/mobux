import { useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import { localGet } from "../lib/api.js";

// Native-mobile-style bottom sheet for picking a host, opened from the
// Nodes settings card's target field (issue #193). Detection is best-effort
// (GET /api/host-suggestions merges ssh-config/tailscale/mDNS results) and
// triggered fresh every time the sheet opens; a source badge on each row
// says where it came from, and tailscale peers additionally get an online
// dot. The sheet's own text field IS the target field while the sheet is
// open — closing it (row tap, Done, or backdrop tap) leaves whatever text
// is there, so manual typing is never blocked by detection finding
// nothing (or finding nothing yet).

const suggestions = signal(null); // null = loading, [] = none found

async function loadSuggestions() {
  suggestions.value = null;
  try {
    const data = await localGet("/api/host-suggestions");
    suggestions.value = Array.isArray(data?.hosts) ? data.hosts : [];
  } catch (_e) {
    // Best-effort: a failed fetch means "nothing detected", never an error.
    suggestions.value = [];
  }
}

const SOURCE_LABEL = { ssh: "ssh", tailscale: "tailscale", mdns: "mdns" };

function sourceBadge(source) {
  return SOURCE_LABEL[source] || source;
}

export function HostSuggestionSheet({ open, value, onChange, onClose }) {
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    loadSuggestions();
    inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const list = suggestions.value;

  const pick = (name) => {
    onChange(name);
    onClose();
  };

  return (
    <div
      class="picker-overlay"
      onClick={onClose}
      role="presentation"
      data-testid="host-picker-sheet"
    >
      <div
        class="picker-sheet"
        role="dialog"
        aria-label="Host"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="picker-header">
          <input
            ref={inputRef}
            class="picker-input"
            placeholder="user@host"
            autocomplete="off"
            value={value}
            onInput={(e) => onChange(e.target.value)}
          />
          <button
            type="button"
            class="picker-done"
            onClick={onClose}
            aria-label="Done"
          >
            Done
          </button>
        </div>
        <div class="picker-body">
          {list == null && <p class="hint picker-hint">Searching…</p>}
          {list && list.length === 0 && (
            <p class="hint picker-hint">No hosts detected. Type one above.</p>
          )}
          {list &&
            list.map((h) => (
              <button
                type="button"
                class="picker-row"
                key={`${h.source}:${h.name}`}
                onClick={() => pick(h.name)}
              >
                <span class="picker-row-name">{h.name}</span>
                <span class="picker-row-control">
                  {h.online != null && (
                    <span
                      class={`picker-online-dot${h.online ? " online" : " offline"}`}
                      aria-label={h.online ? "online" : "offline"}
                    />
                  )}
                  <span class="picker-badge" data-source={h.source}>
                    {sourceBadge(h.source)}
                  </span>
                </span>
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
