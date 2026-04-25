async function fetchJSON(url, opts) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(txt || `${res.status}`);
  }
  return res.json();
}

function sessionCard(s) {
  return `
  <article class="session-card" data-name="${s.name}">
    <div class="session-head">
      <h3>${s.name}</h3>
      <div class="meta">${s.windows} windows · ${s.attached} attached</div>
    </div>
    <div class="actions">
      <a class="btn btn-primary" href="/s/${encodeURIComponent(s.name)}">open</a>
      <button class="btn danger" data-kill="${s.name}">kill</button>
    </div>
  </article>`;
}

async function refreshSessions() {
  const list = document.getElementById("sessionList");
  try {
    const sessions = await fetchJSON("/api/sessions");
    if (!sessions.length) {
      list.innerHTML = `<p class="hint">No tmux sessions found.</p>`;
      return;
    }
    list.innerHTML = sessions.map(sessionCard).join("");
  } catch (e) {
    alert(`Failed to load sessions: ${e.message}`);
  }
}

document.getElementById("newSessionForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("sessionName").value.trim();
  if (!name) return;
  try {
    await fetchJSON("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    document.getElementById("sessionName").value = "";
    await refreshSessions();
  } catch (err) {
    alert(`Create failed: ${err.message}`);
  }
});

document.addEventListener("click", async (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  const name = target.dataset.kill;
  if (!name) return;
  if (!confirm(`Kill session '${name}'?`)) return;
  try {
    await fetchJSON(`/api/sessions/${encodeURIComponent(name)}/kill`, { method: "POST" });
    await refreshSessions();
  } catch (err) {
    alert(`Kill failed: ${err.message}`);
  }
});
