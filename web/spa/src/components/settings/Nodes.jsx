import { useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { apiPutJSON } from "../../lib/api.js";
import { HostSuggestionSheet } from "../HostSuggestionSheet.jsx";

// Nodes card — the inventory behind the Home node picker (#176 phase 3).
// A node is {name, target}; the whole list is replaced on every change
// (PUT /api/settings/nodes), mirroring the fixed API contract. SSH keys are
// deliberately out of scope: the hub's key must already be authorized on the
// node, and the card says so instead of growing key-management UI.
//
// Host suggestions (#193): the target field is read-only — tapping it opens
// a full-screen picker (HostSuggestionSheet) whose own text field IS the
// target value while open, so manual entry is never blocked by detection
// finding nothing. It only opens once the list has loaded (`editable`
// below): the same "don't let the field do anything until a real list is
// confirmed" rule that disables the rest of the add form, so a pre-load tap
// can never stage a value for a save that PUTs the whole (unconfirmed)
// list back.

const nodes = signal(null); // null = loading OR load failed — never editable
const loadFailed = signal(false); // true = the initial GET didn't confirm a real list
const status = signal(null); // { msg, ok }
const name = signal("");
const target = signal("");
const pickerOpen = signal(false);

function flash(msg, ok) {
  status.value = { msg, ok };
}

// A load failure must NEVER collapse into an editable `[]` — that's
// indistinguishable from a real "zero nodes configured" server response, and
// Add/Remove do a FULL-LIST PUT (see saveList). A stale empty list from a
// transient GET failure (mid self-update/restart is the common window),
// followed by one "Add", silently wipes every previously-configured node —
// this is exactly how the live nodes table got wiped out from under a
// running remote session. So: nodes.value stays `null` (never `[]`) on any
// failure, loadFailed gates the form, and only a confirmed GET populates a
// real (possibly empty) array.
function markLoadFailed(msg) {
  nodes.value = null;
  loadFailed.value = true;
  flash(msg, false);
}

async function saveList(next) {
  let r;
  try {
    r = await apiPutJSON("/api/settings/nodes", { nodes: next });
  } catch (e) {
    flash(`Save failed: ${e.message}`, false);
    return false;
  }
  if (!r.ok) {
    flash(`Save failed: PUT /api/settings/nodes -> ${r.status}`, false);
    return false;
  }
  nodes.value = next;
  flash("Saved ✓", true);
  return true;
}

export function NodesCard() {
  const load = async () => {
    loadFailed.value = false;
    let res;
    try {
      // redirect:"manual" — an absent route lands on the catch-all 307;
      // following it leaves an abandoned body in flight (stalls the page's
      // network-idle state).
      res = await fetch("/api/settings/nodes", {
        headers: { Accept: "application/json" },
        redirect: "manual",
      });
    } catch (e) {
      markLoadFailed(`Failed to load nodes: ${e.message}`);
      return;
    }
    if (res.status === 404 || res.type === "opaqueredirect") {
      // A confirmed, stable signal (this exact server has no node route at
      // all) — not the transient failure this guard is about — so it's safe
      // to treat as a real, editable, empty list.
      nodes.value = [];
      loadFailed.value = false;
      flash("This server has no node support — update mobux.", false);
      return;
    }
    if (!res.ok) {
      res.text().catch(() => {});
      markLoadFailed(
        `Failed to load nodes: GET /api/settings/nodes -> ${res.status}`,
      );
      return;
    }
    let d;
    try {
      d = await res.json();
    } catch (e) {
      markLoadFailed(`Failed to load nodes: ${e.message}`);
      return;
    }
    nodes.value = d.nodes || [];
    loadFailed.value = false;
    status.value = null;
  };

  useEffect(() => {
    // `nodes`/`loadFailed` are module-level signals, so they persist across
    // mounts — this page can unmount/remount via SPA navigation (Home <->
    // Settings). Without resetting here, a remount would show the PREVIOUS
    // mount's confirmed list as already editable before a fresh GET for
    // THIS mount has confirmed anything, letting an Add/Remove fire against
    // stale data. Force back to "loading, not yet editable" on every mount.
    nodes.value = null;
    loadFailed.value = false;
    pickerOpen.value = false;
    load();
  }, []);

  const add = async (e) => {
    e.preventDefault();
    if (nodes.value == null) {
      flash("Nodes haven't loaded yet — retry before adding.", false);
      return;
    }
    const n = name.value.trim();
    const t = target.value.trim();
    if (!n || !t) {
      flash("Both name and SSH target are required.", false);
      return;
    }
    if (nodes.value.some((x) => x.name === n)) {
      flash(`A node named '${n}' already exists.`, false);
      return;
    }
    const ok = await saveList([...nodes.value, { name: n, target: t }]);
    if (ok) {
      name.value = "";
      target.value = "";
    }
  };

  const remove = (n) => {
    if (nodes.value == null) return;
    saveList(nodes.value.filter((x) => x.name !== n));
  };

  const list = nodes.value;
  const editable = list != null;

  return (
    <section class="settings-group" id="nodes-settings">
      <h2>Nodes</h2>
      <p class="settings-lede">
        Remote hosts this hub can open tmux sessions on over SSH. SSH keys are
        your job: the hub's key must already be authorized on the node — there
        is no key management here.
      </p>

      {list == null && !loadFailed.value && <p class="hint">Loading…</p>}
      {list == null && loadFailed.value && (
        <p class="hint">
          Could not load the node list — editing is disabled until it does.{" "}
          <button type="button" id="nodesRetryBtn" onClick={load}>
            Retry
          </button>
        </p>
      )}
      {list &&
        list.map((n) => (
          <div class="settings-row node-row" data-name={n.name} key={n.name}>
            <span class="node-name">{n.name}</span>
            <span class="node-target">{n.target}</span>
            <button
              type="button"
              class="node-remove"
              aria-label={`Remove ${n.name}`}
              onClick={() => remove(n.name)}
            >
              Remove
            </button>
          </div>
        ))}
      {list && list.length === 0 && (
        <p class="hint">No nodes configured. Sessions run on this host.</p>
      )}

      <form class="node-add" onSubmit={add}>
        <input
          id="nodeName"
          class="settings-input"
          placeholder="name (e.g. devbox)"
          autocomplete="off"
          disabled={!editable}
          value={name.value}
          onInput={(e) => (name.value = e.target.value)}
        />
        <input
          id="nodeTarget"
          class="settings-input"
          placeholder="user@host"
          autocomplete="off"
          readOnly
          disabled={!editable}
          value={target.value}
          onClick={() => editable && (pickerOpen.value = true)}
        />
        <button type="submit" id="nodeAddBtn" disabled={!editable}>
          Add
        </button>
      </form>

      <HostSuggestionSheet
        open={pickerOpen.value}
        value={target.value}
        onChange={(v) => (target.value = v)}
        onClose={() => (pickerOpen.value = false)}
      />

      {status.value && (
        <div
          id="nodesStatus"
          class="settings-status"
          style={{ color: status.value.ok ? "#7ec87e" : "#c87e7e" }}
        >
          {status.value.msg}
        </div>
      )}
    </section>
  );
}
