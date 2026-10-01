import { useEffect, useRef, useState } from "preact/hooks";
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

const PORT_RULE = "Port must be a whole number from 1024 to 65535.";

function parsePort(text) {
  if (!/^\d+$/.test(text.trim())) return null;
  const port = Number(text);
  return port >= 1024 && port <= 65535 ? port : null;
}

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
  if (s.error) return { msg: `Failed to start: ${s.error}`, kind: "error" };
  return "Off";
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
  const code = useRef(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onCopy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(command);
      setCopy("copied");
      timer.current = setTimeout(() => setCopy("idle"), 2000);
    } catch (_) {
      if (code.current) window.getSelection().selectAllChildren(code.current);
      setCopy("failed");
    }
  };
  return (
    <div class="settings-row settings-row--command" data-row="mcp-command">
      <code id="mcpCommand" class="settings-command" ref={code}>
        {command}
      </code>
      <Button id="mcpCopy" class="btn--inline" onClick={onCopy}>
        {copy === "copied"
          ? "Copied"
          : copy === "failed"
            ? "Copy failed"
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
    if (!e.target.checked) {
      save(0);
      return;
    }
    const port = parsePort(draft);
    if (port == null) {
      saveError.value = PORT_RULE;
      e.target.checked = false;
      return;
    }
    save(port);
  };

  const commitPort = () => {
    const port = parsePort(draft);
    if (port == null) {
      setPending(null);
      saveError.value = PORT_RULE;
      return;
    }
    if (saveError.value === PORT_RULE) saveError.value = null;
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
          secondary={s ? s.managed_note : null}
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
