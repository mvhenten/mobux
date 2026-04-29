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

// ── Session list rendering ──────────────────────────────────────────
function sessionRow(s) {
  return `<div class="swipe-row" data-name="${s.name}">
  <div class="swipe-action swipe-left"><button class="swipe-btn rename-btn">Rename</button></div>
  <a class="session-item" href="/s/${encodeURIComponent(s.name)}">
    <div class="session-info">
      <span class="session-name">${s.name}</span>
      <span class="session-meta">${s.windows} win · ${s.attached} attached</span>
    </div>
    <span class="session-arrow">›</span>
  </a>
  <div class="swipe-action swipe-right"><button class="swipe-btn kill-btn" data-kill="${s.name}">Kill</button></div>
</div>`;
}

async function refreshSessions() {
  const list = document.getElementById("sessionList");
  try {
    const sessions = await fetchJSON("/api/sessions");
    if (!sessions.length) {
      list.innerHTML = `<p class="hint">No tmux sessions. Tap + to create one.</p>`;
      return;
    }
    list.innerHTML = sessions.map(sessionRow).join("");
    initSwipeRows();
  } catch (e) {
    alert(`Failed to load sessions: ${e.message}`);
  }
}

// ── FAB + dialog ────────────────────────────────────────────────────
const fab = document.getElementById("fabNew");
const dialog = document.getElementById("newSessionDialog");
const cancelBtn = document.getElementById("cancelNew");

fab?.addEventListener("click", () => {
  dialog?.showModal();
  document.getElementById("sessionName")?.focus();
});

cancelBtn?.addEventListener("click", () => dialog?.close());

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
    dialog?.close();
    await refreshSessions();
  } catch (err) {
    alert(`Create failed: ${err.message}`);
  }
});

// ── Kill handler ────────────────────────────────────────────────────
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

// ── Rename handler ──────────────────────────────────────────────────
document.addEventListener("click", async (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement) || !target.classList.contains('rename-btn')) return;
  const row = target.closest('.swipe-row');
  if (!row) return;
  const oldName = row.dataset.name;
  const newName = prompt(`Rename '${oldName}' to:`, oldName);
  if (!newName || newName === oldName) {
    // Snap row back
    const item = row.querySelector('.session-item');
    if (item) { item.style.transition = 'transform 0.2s ease'; item.style.transform = 'translateX(0)'; }
    return;
  }
  try {
    await fetchJSON(`/api/sessions/${encodeURIComponent(oldName)}/rename`, {
      method: "POST",
      body: JSON.stringify({ name: newName }),
    });
    await refreshSessions();
  } catch (err) {
    alert(`Rename failed: ${err.message}`);
  }
});

// ── Swipe gestures on session rows ──────────────────────────────────
function initSwipeRows() {
  document.querySelectorAll('.swipe-row').forEach(row => {
    const item = row.querySelector('.session-item');
    if (!item) return;

    let startX = 0, currentX = 0, swiping = false;

    item.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      currentX = 0;
      swiping = true;
      item.style.transition = 'none';
    }, { passive: true });

    item.addEventListener('touchmove', (e) => {
      if (!swiping) return;
      currentX = e.touches[0].clientX - startX;
      // Clamp: left swipe reveals kill (max -100), right reveals rename (max 100)
      currentX = Math.max(-100, Math.min(100, currentX));
      item.style.transform = `translateX(${currentX}px)`;
    }, { passive: true });

    item.addEventListener('touchend', () => {
      swiping = false;
      item.style.transition = 'transform 0.2s ease';
      // Snap: if dragged more than 60px, hold open; otherwise snap back
      if (currentX < -60) {
        item.style.transform = 'translateX(-100px)';
      } else if (currentX > 60) {
        item.style.transform = 'translateX(100px)';
      } else {
        item.style.transform = 'translateX(0)';
      }
    });

    // Tap on revealed area snaps back
    row.addEventListener('click', (e) => {
      if (e.target.closest('.swipe-btn')) return;
      if (item.style.transform !== 'translateX(0px)' && item.style.transform !== '') {
        item.style.transition = 'transform 0.2s ease';
        item.style.transform = 'translateX(0)';
      }
    });
  });
}

// Init on load
initSwipeRows();
