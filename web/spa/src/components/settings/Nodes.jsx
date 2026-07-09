import { useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { apiPutJSON } from "../../lib/api.js";

// Nodes card — the inventory behind the Home node picker (#176 phase 3).
// A node is {name, target}; the whole list is replaced on every change
// (PUT /api/settings/nodes), mirroring the fixed API contract. SSH keys are
// deliberately out of scope: the hub's key must already be authorized on the
// node, and the card says so instead of growing key-management UI.

const nodes = signal(null); // null = loading
const status = signal(null); // { msg, ok }
const name = signal("");
const target = signal("");

function flash(msg, ok) {
  status.value = { msg, ok };
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
  useEffect(() => {
    (async () => {
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
        nodes.value = [];
        flash(`Failed to load nodes: ${e.message}`, false);
        return;
      }
      if (res.status === 404 || res.type === "opaqueredirect") {
        nodes.value = [];
        flash("This server has no node support — update mobux.", false);
        return;
      }
      if (!res.ok) {
        res.text().catch(() => {});
        nodes.value = [];
        flash(
          `Failed to load nodes: GET /api/settings/nodes -> ${res.status}`,
          false,
        );
        return;
      }
      const d = await res.json();
      nodes.value = d.nodes || [];
      status.value = null;
    })();
  }, []);

  const add = async (e) => {
    e.preventDefault();
    const n = name.value.trim();
    const t = target.value.trim();
    if (!n || !t) {
      flash("Both name and SSH target are required.", false);
      return;
    }
    if ((nodes.value || []).some((x) => x.name === n)) {
      flash(`A node named '${n}' already exists.`, false);
      return;
    }
    const ok = await saveList([...(nodes.value || []), { name: n, target: t }]);
    if (ok) {
      name.value = "";
      target.value = "";
    }
  };

  const remove = (n) => {
    saveList((nodes.value || []).filter((x) => x.name !== n));
  };

  const list = nodes.value;

  return (
    <section class="settings-group" id="nodes-settings">
      <h2>Nodes</h2>
      <p class="settings-lede">
        Remote hosts this hub can open tmux sessions on over SSH. SSH keys are
        your job: the hub's key must already be authorized on the node — there
        is no key management here.
      </p>

      {list == null && <p class="hint">Loading…</p>}
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
          value={name.value}
          onInput={(e) => (name.value = e.target.value)}
        />
        <input
          id="nodeTarget"
          class="settings-input"
          placeholder="user@host"
          autocomplete="off"
          value={target.value}
          onInput={(e) => (target.value = e.target.value)}
        />
        <button type="submit" id="nodeAddBtn">
          Add
        </button>
      </form>

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
