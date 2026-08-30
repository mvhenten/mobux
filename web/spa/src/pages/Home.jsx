import { useEffect, useRef } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { signal } from "@preact/signals";
import { apiGet, apiSend } from "../lib/api.js";
import { u } from "../lib/base.js";
import { getSelectedNode, setSelectedNode, withNode } from "../lib/nodes.js";

// Home / session list. Ports the behaviour of the Rust-rendered `/` page
// (render_index + index.js): list tmux sessions with window/attached counts,
// create a session (FAB → dialog), kill, and rename. Tapping a session opens
// the terminal island.
//
// Node picker (#176 phase 3): when nodes are configured the list grows a
// compact local/node switch, and every sessions call carries ?node=<name> so
// the hub proxies it over SSH. Zero nodes ⇒ no picker, UI identical to before.

const sessions = signal(null);
const error = signal(null);
const nodes = signal(null); // null until /api/nodes answers
const nodeError = signal(null);
// Seeded to local, not getSelectedNode() — this module evaluates as part of
// the static import chain, before main.jsx's boot() has awaited prefs
// hydration. The mount effect reads the server value once the app has rendered
// (which only happens after hydrate() resolved).
const selectedNode = signal("");

async function refresh() {
  try {
    const data = await apiGet(withNode("/api/sessions", selectedNode.value));
    sessions.value = Array.isArray(data) ? data : data.sessions || [];
    error.value = null;
  } catch (e) {
    error.value = String(e.message || e);
  }
}

// Never rejects — refresh() must run regardless of node support.
// redirect:"manual" because an absent API route lands on the server's
// catch-all 307; following it would leave an abandoned response body in
// flight, which stalls the page's network-idle state.
async function loadNodes() {
  let res;
  try {
    res = await fetch(u("/api/nodes"), {
      headers: { Accept: "application/json" },
      redirect: "manual",
    });
  } catch (e) {
    nodeError.value = String(e.message || e);
    return;
  }
  // A backend without node support means zero nodes configured — same UI as
  // today, not an error.
  if (res.status === 404 || res.type === "opaqueredirect") {
    nodes.value = [];
    return;
  }
  if (!res.ok) {
    res.text().catch(() => {});
    nodeError.value = `GET /api/nodes -> ${res.status}`;
    return;
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    nodeError.value = `GET /api/nodes: ${String(e.message || e)}`;
    return;
  }
  nodes.value = data.nodes || [];
  nodeError.value = null;
  // A persisted selection for a since-removed node falls back to local.
  if (
    selectedNode.value &&
    !nodes.value.some((n) => n.name === selectedNode.value)
  ) {
    selectedNode.value = "";
    setSelectedNode("");
  }
}

export function HomePage() {
  const dialogRef = useRef(null);
  const nameRef = useRef(null);
  const [, navigate] = useLocation();

  useEffect(() => {
    // Read the server-held selection now that prefs are hydrated. Nodes
    // first: a stale selection (a since-removed node) must be reset before the
    // session list is fetched with it.
    selectedNode.value = getSelectedNode();
    loadNodes().then(refresh);
  }, []);

  const pickNode = (name) => {
    if (name === selectedNode.value) return;
    selectedNode.value = name;
    setSelectedNode(name);
    sessions.value = null;
    error.value = null;
    refresh();
  };

  const open = (name) => {
    // The node segment pins the session to the node it was listed from —
    // the URL is the whole address, so a later picker change (or another
    // device) can never re-target it to the wrong tmux (#185). Plain SPA
    // navigation: the terminal engine is a component with a real
    // mount/dispose lifecycle (#188), so no document reload is needed.
    const node = selectedNode.value
      ? `${encodeURIComponent(selectedNode.value)}/`
      : "";
    navigate(`/s/${node}${encodeURIComponent(name)}`);
  };

  const create = async (e) => {
    e.preventDefault();
    const name = (nameRef.current?.value || "").trim();
    if (!name) return;
    try {
      await apiSend(withNode("/api/sessions", selectedNode.value), {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      nameRef.current.value = "";
      dialogRef.current?.close();
      await refresh();
    } catch (err) {
      alert(`Create failed: ${err.message}`);
    }
  };

  const kill = async (name) => {
    if (!confirm(`Kill session '${name}'?`)) return;
    try {
      await apiSend(
        withNode(
          `/api/sessions/${encodeURIComponent(name)}/kill`,
          selectedNode.value,
        ),
        { method: "POST" },
      );
      await refresh();
    } catch (err) {
      alert(`Kill failed: ${err.message}`);
    }
  };

  const rename = async (oldName) => {
    const newName = prompt(`Rename '${oldName}' to:`, oldName);
    if (!newName || newName === oldName) return;
    try {
      await apiSend(
        withNode(
          `/api/sessions/${encodeURIComponent(oldName)}/rename`,
          selectedNode.value,
        ),
        {
          method: "POST",
          body: JSON.stringify({ name: newName }),
        },
      );
      await refresh();
    } catch (err) {
      alert(`Rename failed: ${err.message}`);
    }
  };

  // Swipe-to-reveal on a session row, ported from the old index.js
  // initSwipeRows. The rename/kill buttons sit behind the .session-item
  // (z-index), so without this gesture they're unreachable — drag the row to
  // reveal them (right → rename, left → kill), tap elsewhere to snap back.
  const swipeRow = (row) => {
    if (!row) return;
    const item = row.querySelector(".session-item");
    if (!item || item.dataset.swipeWired) return;
    item.dataset.swipeWired = "1";

    let startX = 0;
    let currentX = 0;
    let swiping = false;

    item.addEventListener(
      "touchstart",
      (e) => {
        startX = e.touches[0].clientX;
        currentX = 0;
        swiping = true;
        item.style.transition = "none";
      },
      { passive: true },
    );
    item.addEventListener(
      "touchmove",
      (e) => {
        if (!swiping) return;
        currentX = Math.max(-100, Math.min(100, e.touches[0].clientX - startX));
        item.style.transform = `translateX(${currentX}px)`;
      },
      { passive: true },
    );
    item.addEventListener("touchend", () => {
      swiping = false;
      item.style.transition = "transform 0.2s ease";
      if (currentX < -60) item.style.transform = "translateX(-100px)";
      else if (currentX > 60) item.style.transform = "translateX(100px)";
      else item.style.transform = "translateX(0)";
    });
    row.addEventListener("click", (e) => {
      if (e.target.closest(".swipe-btn")) return;
      if (
        item.style.transform !== "translateX(0px)" &&
        item.style.transform !== ""
      ) {
        item.style.transition = "transform 0.2s ease";
        item.style.transform = "translateX(0)";
      }
    });
  };

  const list = sessions.value;
  const nodeList = nodes.value;

  return (
    <>
      {nodeError.value && (
        <p class="hint">Failed to load nodes: {nodeError.value}</p>
      )}
      {nodeList && nodeList.length > 0 && (
        <div id="nodePicker" class="node-picker" aria-label="Node">
          <button
            type="button"
            class={`node-chip${selectedNode.value === "" ? " active" : ""}`}
            data-node=""
            onClick={() => pickNode("")}
          >
            local
          </button>
          {nodeList.map((n) => (
            <button
              type="button"
              key={n.name}
              class={`node-chip${selectedNode.value === n.name ? " active" : ""}${n.reachable === false ? " unreachable" : ""}`}
              data-node={n.name}
              title={n.target}
              onClick={() => pickNode(n.name)}
            >
              {n.name}
              {n.reachable === false && (
                <span class="node-dead">unreachable</span>
              )}
            </button>
          ))}
        </div>
      )}
      <div id="sessionList" class="session-list">
        {error.value && (
          <p class="hint">Failed to load sessions: {error.value}</p>
        )}
        {list == null && !error.value && <p class="hint">Loading…</p>}
        {list && list.length === 0 && (
          <p class="hint">No tmux sessions. Tap + to create one.</p>
        )}
        {(list || []).map((s) => {
          const name = typeof s === "string" ? s : s.name;
          const meta =
            typeof s === "object"
              ? `${s.windows ?? "?"} win · ${s.attached ?? 0} attached`
              : "";
          return (
            <div class="swipe-row" data-name={name} key={name} ref={swipeRow}>
              <div class="swipe-action swipe-left">
                <button
                  class="swipe-btn rename-btn"
                  onClick={() => rename(name)}
                >
                  Rename
                </button>
              </div>
              <a
                class="session-item"
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  open(name);
                }}
              >
                <div class="session-info">
                  <span class="session-name">{name}</span>
                  {meta && <span class="session-meta">{meta}</span>}
                </div>
                <span class="session-arrow">›</span>
              </a>
              <div class="swipe-action swipe-right">
                <button class="swipe-btn kill-btn" onClick={() => kill(name)}>
                  Kill
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <button
        id="fabNew"
        class="fab"
        aria-label="New session"
        onClick={() => {
          dialogRef.current?.showModal();
          nameRef.current?.focus();
        }}
      >
        +
      </button>

      <dialog ref={dialogRef} id="newSessionDialog" class="session-dialog">
        <form id="newSessionForm" method="dialog" onSubmit={create}>
          <h3>New session</h3>
          <input
            ref={nameRef}
            id="sessionName"
            placeholder="session-name"
            autocomplete="off"
            required
          />
          <div class="dialog-actions">
            <button
              type="button"
              class="btn-cancel"
              onClick={() => dialogRef.current?.close()}
            >
              Cancel
            </button>
            <button type="submit" class="btn-create">
              Create
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
