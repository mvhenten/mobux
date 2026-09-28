import { useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { localFetch } from "../../lib/api.js";
import {
  Actions,
  ActionRow,
  Button,
  ConfirmButton,
  Group,
  Lede,
  NavRow,
  Status,
  ValueRow,
} from "./ui.jsx";

// Software update (issue #130). Reads /api/update/status, drives Check
// (POST /api/update/check) and Update now (POST /api/update/run), then polls
// /api/identify until the version changes (or times out). Always acts on the
// host that served the page, so it uses the host-pinned helper.

const info = signal(null);
const status = signal(null);
const busy = signal(false);

function fmtCheckedAt(iso) {
  if (!iso) return "Not checked yet";
  try {
    return "Last checked " + new Date(iso).toLocaleString();
  } catch (_) {
    return "Last checked " + iso;
  }
}

const show = (msg, kind) => (status.value = { msg, kind });

async function load(force) {
  const path = force ? "/api/update/check" : "/api/update/status";
  try {
    const res = await localFetch(path, force ? { method: "POST" } : {});
    if (!res.ok) throw new Error("HTTP " + res.status);
    info.value = await res.json();
    // A successful check clears the recorded reason server-side, so it
    // reports its own outcome; only a passive load surfaces an old failure.
    if (force) show("Checked crates.io.", "ok");
    else if (info.value.lastRunError)
      show("Last update rolled back. " + info.value.lastRunError, "error");
  } catch (err) {
    show("Update check failed: " + err.message, "error");
  }
}

async function watchForNewVersion(fromVersion, logPath) {
  const deadline = Date.now() + 600000; // cargo install builds take minutes
  show(
    "Updating… the service will restart. Watching for the new version.",
    "ok",
  );
  busy.value = true;
  // The identify poll is cheap; the status poll reads a file on the host, so
  // it runs at most every 15s rather than on every 3s tick.
  let nextStatusPoll = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const res = await localFetch("/api/identify", {});
      if (res.ok) {
        const id = await res.json();
        if (id.version && id.version !== fromVersion) {
          show(
            `Updated to ${id.version}. Reload the app to pick up the new UI.`,
            "ok",
          );
          busy.value = false;
          return;
        }
      }
      if (Date.now() < nextStatusPoll) continue;
      nextStatusPoll = Date.now() + 15000;
      const st = await localFetch("/api/update/status", {});
      if (st.ok) {
        const next = await st.json();
        info.value = next;
        if (next.lastRunError) {
          show("Update rolled back. " + next.lastRunError, "error");
          busy.value = false;
          return;
        }
      }
    } catch (_) {
      // expected during the restart window — keep polling
    }
  }
  show(
    "Timed out after 10 minutes waiting for the new version. It may still be building, or it " +
      "rolled back — check the update log on the host: " +
      (logPath || "mobux-update.log"),
    "error",
  );
  busy.value = false;
}

async function run() {
  const fromVersion = info.value?.current || "";
  busy.value = true;
  show("Starting update…", "ok");
  try {
    const res = await localFetch("/api/update/run", { method: "POST" });
    if (res.status === 202) {
      const body = await res.json().catch(() => ({}));
      watchForNewVersion(fromVersion, body.log);
      return;
    }
    let msg = "HTTP " + res.status;
    try {
      const body = await res.json();
      if (body && body.error && body.error.message) msg = body.error.message;
    } catch (_) {}
    show("Update could not start: " + msg, "error");
    busy.value = false;
  } catch (err) {
    show("Update could not start: " + err.message, "error");
    busy.value = false;
  }
}

function summary(s) {
  if (!s) return "Checking…";
  if (s.error) return "Check failed";
  if (s.available) return `v${s.latest} available`;
  if (s.latest) return "Up to date";
  return "Not checked yet";
}

export function UpdateRow() {
  useEffect(() => {
    load(false);
  }, []);
  const s = info.value;
  return (
    <NavRow
      row="update"
      to="/settings/update"
      label="Software update"
      secondary={summary(s)}
      value={s?.current || "…"}
    />
  );
}

export function UpdateCard() {
  useEffect(() => {
    load(false);
  }, []);

  const s = info.value || {};
  const available = !!s.available;

  return (
    <div id="update">
      <Lede>
        Checks crates.io for a newer release. Updating installs it, restarts the
        service and rolls back if it doesn't come up. Acts on{" "}
        {typeof location !== "undefined" ? location.hostname : "this host"}{" "}
        only.
      </Lede>
      <Group title="Version">
        <ValueRow
          label="Current version"
          value={s.current || "…"}
          valueId="updateCurrent"
        />
        <ValueRow
          label="Latest version"
          secondary={s.error ? "Check failed" : fmtCheckedAt(s.checkedAt)}
          value={s.latest || "…"}
          valueId="updateLatest"
          valueClass={available ? "settings-value--new" : ""}
        />
        <Actions>
          <Button
            id="updateCheckBtn"
            variant={available ? "secondary" : "primary"}
            disabled={busy.value}
            onClick={() => load(true)}
          >
            Check for updates
          </Button>
          {available && (
            <ConfirmButton
              id="updateRunBtn"
              variant="primary"
              disabled={busy.value}
              label={`Update to ${s.latest}`}
              confirmLabel="Tap again to update"
              onConfirm={run}
            />
          )}
        </Actions>
      </Group>
      <Status id="updateStatus" status={status.value} />
      {s.error && (
        <Status
          id="updateCheckError"
          status={{ msg: "Check failed: " + s.error, kind: "error" }}
        />
      )}
      <Group title="App">
        <ActionRow
          id="reloadAppRow"
          label="Reload app"
          onClick={() => location.reload()}
        />
      </Group>
    </div>
  );
}
