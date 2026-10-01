import { useEffect, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import { apiSend, localGet } from "../../lib/api.js";
import {
  Actions,
  Button,
  ConfirmButton,
  FieldRow,
  Group,
  Lede,
  NavRow,
  Status,
  SwitchRow,
} from "./ui.jsx";

// GET|PUT /api/settings/mcp. The server writes `mcp.port` in config.json
// (0 is off) and starts, stops or rebinds the loopback listener to match.

const mcp = signal(null);
const loadError = signal(null);
const saveError = signal(null);
const busy = signal(false);

const MANAGED_NOTE = {
  env: "MOBUX_MCP_PORT sets the port; unset it to use this switch.",
  flag: "--mcp-port sets the port; drop it to use this switch.",
};

const errorText = (e) => (e.body || e.message || String(e)).trim();

async function load() {
  try {
    mcp.value = await localGet("/api/settings/mcp");
    loadError.value = null;
  } catch (e) {
    loadError.value = errorText(e);
  }
}

async function save(port) {
  busy.value = true;
  try {
    mcp.value = await apiSend("/api/settings/mcp", {
      method: "PUT",
      body: JSON.stringify({ port }),
    });
    saveError.value = null;
    return true;
  } catch (e) {
    saveError.value = errorText(e);
    return false;
  } finally {
    busy.value = false;
  }
}

function rowValue() {
  if (loadError.value) return "Unavailable";
  const s = mcp.value;
  if (!s) return "…";
  if (s.managed_by) return `From ${s.managed_by}`;
  return s.listening ? `On · port ${s.listening_port}` : "Off";
}

function statusLine() {
  if (loadError.value) return { msg: loadError.value, kind: "error" };
  if (saveError.value) return { msg: saveError.value, kind: "error" };
  const s = mcp.value;
  if (!s) return null;
  if (s.listening)
    return { msg: `Listening on 127.0.0.1:${s.listening_port}`, kind: "ok" };
  return { msg: "Off" };
}

export function McpRow() {
  useEffect(() => {
    load();
  }, []);
  return (
    <NavRow
      row="mcp"
      to="/settings/mcp"
      label="MCP server"
      secondary="Agents on this host"
      value={rowValue()}
    />
  );
}

function CommandRow({ command }) {
  const [copy, setCopy] = useState("idle");
  const onCopy = async (e) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopy("copied");
      setTimeout(() => setCopy("idle"), 2000);
    } catch (_) {
      const code = e.currentTarget.parentElement.querySelector("code");
      window.getSelection().selectAllChildren(code);
      setCopy("selected");
    }
  };
  return (
    <div class="settings-row settings-row--command" data-row="mcp-command">
      <code id="mcpCommand" class="settings-command">
        {command}
      </code>
      <Button id="mcpCopy" class="btn--inline" onClick={onCopy}>
        {copy === "copied"
          ? "Copied"
          : copy === "selected"
            ? "Selected"
            : "Copy"}
      </Button>
    </div>
  );
}

export function McpCard() {
  const s = mcp.value;
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(null);

  useEffect(() => {
    saveError.value = null;
    load();
  }, []);

  const current = s ? s.listening_port || s.port || s.default_port : null;
  useEffect(() => {
    if (current != null) setDraft(String(current));
  }, [current]);

  const locked = !s || !!s.managed_by || busy.value;
  const on = !!(s && s.listening);

  const onToggle = (e) => {
    setPending(null);
    save(e.target.checked ? Number(draft) || s.default_port : 0);
  };

  const commitPort = () => {
    const port = Number(draft);
    if (!on || port === s.listening_port) {
      setPending(null);
      return;
    }
    setPending(port);
  };

  const cancel = () => {
    setPending(null);
    setDraft(String(current));
  };

  return (
    <div id="mcp-settings">
      <Lede>
        Lets agents on this host read and drive your tmux sessions. It listens
        on 127.0.0.1 only and takes no password, so only programs on this
        machine reach it.
      </Lede>
      <Group title="Server">
        <SwitchRow
          name="mcpEnabled"
          label="MCP server"
          secondary={s && s.managed_by ? MANAGED_NOTE[s.managed_by] : null}
          checked={on}
          disabled={locked}
          onChange={onToggle}
        />
        <FieldRow rowId="mcpPortRow" label="Port">
          <input
            id="mcpPort"
            class="settings-input"
            type="number"
            inputmode="numeric"
            min="1024"
            max="65535"
            disabled={locked}
            value={draft}
            onInput={(e) => setDraft(e.target.value)}
            onBlur={commitPort}
            onKeyDown={(e) => e.key === "Enter" && e.target.blur()}
          />
        </FieldRow>
        {pending != null && (
          <Actions>
            <Button id="mcpPortCancel" onClick={cancel}>
              Cancel
            </Button>
            <ConfirmButton
              id="mcpPortApply"
              label={`Move to ${pending}`}
              confirmLabel="Tap again to move"
              variant="secondary"
              armedVariant="danger"
              onConfirm={async () => {
                if (await save(pending)) setPending(null);
              }}
            />
          </Actions>
        )}
      </Group>
      <Status id="mcpStatus" status={statusLine()} />
      {s && (
        <Group title="Register with Claude Code">
          <CommandRow command={s.command} />
        </Group>
      )}
    </div>
  );
}
