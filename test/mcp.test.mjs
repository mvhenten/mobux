// The loopback MCP server (issue #334, stage 4), driven with the official MCP
// client over Streamable HTTP against the smoke instance, which serves MCP on
// MOBUX_MCP_URL. The tmux checks read the smoke instance's own tmux server.
//
// Run with: make test-mcp (and as part of make test-critical-path)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const require = createRequire(import.meta.url);
const { createTmuxRunner, SMOKE_TMUX_SOCKET } = require("./lib/tmux.cjs");

const MCP_URL = process.env.MOBUX_MCP_URL || "http://127.0.0.1:8294/mcp";
const BASE = process.env.MOBUX_URL || "http://127.0.0.1:8281";
const USER = process.env.MOBUX_USER || "";
const PASS = process.env.MOBUX_PASS || "";
const tmux = createTmuxRunner(SMOKE_TMUX_SOCKET);
const SESSION = `mcp-e2e-${process.pid}`;

const TOOLS = [
  "list_sessions",
  "notify",
  "read_screen",
  "run_tmux_command",
  "send_keys",
  "show_on_phone",
];

let client;

function text(result) {
  return result.content.map((block) => block.text).join("\n");
}

async function call(name, args = {}) {
  return client.callTool({ name, arguments: args });
}

async function eventually(probe, what, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await probe();
    if (last.ok) return last.value;
    if (Date.now() > deadline) {
      assert.fail(`${what}; last saw:\n${last.value}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function capturePane() {
  return tmux(`capture-pane -p -t ${SESSION}:`).toString();
}

function windowCount() {
  return tmux(`list-windows -t ${SESSION}`).toString().trim().split("\n")
    .length;
}

function rawRequest(url, { method = "POST", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers }, (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (data += chunk));
      response.on("end", () => resolve({ status: response.statusCode, data }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

before(async () => {
  tmux(`new-session -d -s ${SESSION} -x 120 -y 30 "bash --norc --noprofile"`);
  client = new Client({ name: "mobux-e2e", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
});

after(async () => {
  if (client) await client.close();
  try {
    tmux(`kill-session -t ${SESSION}`);
  } catch (_) {
    // already gone
  }
});

test("the handshake names the server and lists exactly the six tools", async () => {
  assert.equal(client.getServerVersion().name, "mobux");
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), TOOLS);
});

test("list_sessions sees a session made with tmux", async () => {
  const result = await call("list_sessions");
  assert.ok(!result.isError, text(result));
  const line = text(result)
    .split("\n")
    .find((row) => row.startsWith(`${SESSION}\t`));
  assert.ok(line, text(result));
  assert.match(line, /windows=1\tactive=0:\S*\talternate_screen=no/);
});

test("read_screen returns text echoed in the pane", async () => {
  tmux(`send-keys -t ${SESSION}: 'echo screen-marker-$((40+2))' Enter`);
  await eventually(async () => {
    const result = await call("read_screen", { session: SESSION, lines: 50 });
    assert.ok(!result.isError, text(result));
    const screen = text(result);
    return { ok: screen.includes("screen-marker-42"), value: screen };
  }, "read_screen never showed the echoed text");
});

test("read_screen on a missing session is a tool error", async () => {
  const result = await call("read_screen", { session: "no-such-session-mcp" });
  assert.equal(result.isError, true);
  assert.match(text(result), /can't find|no such|not found/i);
});

test("send_keys types into the pane", async () => {
  const result = await call("send_keys", {
    session: SESSION,
    text: "echo typed-$((1+1))-by-mcp",
    enter: true,
  });
  assert.ok(!result.isError, text(result));
  await eventually(async () => {
    const pane = capturePane();
    return { ok: pane.includes("typed-2-by-mcp"), value: pane };
  }, "the typed command never ran in the pane");
});

test("send_keys keeps a trailing semicolon", async () => {
  for (const typed of ["echo semi-end;", "find . -exec true {} \\;"]) {
    const result = await call("send_keys", { session: SESSION, text: typed });
    assert.ok(!result.isError, text(result));
    await eventually(async () => {
      const pane = capturePane();
      return { ok: pane.includes(typed), value: pane };
    }, `the pane never showed ${typed}`);
    tmux(`send-keys -t ${SESSION}: C-u`);
  }
});

test("send_keys to a name that only prefixes a session is a tool error", async () => {
  const short = `mcpx${process.pid}`;
  tmux(`new-session -d -s ${short}-long "bash --norc --noprofile"`);
  try {
    const result = await call("send_keys", { session: short, text: "echo x" });
    assert.equal(result.isError, true, text(result));
    assert.match(text(result), /can't find/);
  } finally {
    tmux(`kill-session -t =${short}-long`);
  }
});

test("run_tmux_command new-window adds a window", async () => {
  const before = windowCount();
  const result = await call("run_tmux_command", {
    session: SESSION,
    command: "new-window",
  });
  assert.ok(!result.isError, text(result));
  assert.equal(windowCount(), before + 1);
});

test("run_tmux_command refuses a command outside the vocabulary", async () => {
  const result = await call("run_tmux_command", {
    session: SESSION,
    command: "kill-server",
  });
  assert.equal(result.isError, true);
  assert.match(text(result), /unknown command/);
});

test("notify and show_on_phone say so when no device is subscribed", async () => {
  for (const [name, args] of [
    ["notify", { title: "mobux e2e", body: "hello" }],
    ["show_on_phone", { title: "mobux e2e", url: "/files/site/" }],
  ]) {
    const result = await call(name, args);
    assert.equal(result.isError, true, `${name}: ${text(result)}`);
    assert.match(text(result), /^no subscribed device/);
  }
});

test("a non-loopback Host is refused with 403", async () => {
  const { status, data } = await rawRequest(MCP_URL, {
    headers: {
      Host: "evil.example",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: "{}",
  });
  assert.equal(status, 403);
  assert.equal(data, "Forbidden: Host header is not allowed");
});

test("a non-loopback Origin is refused with 403", async () => {
  const { status } = await rawRequest(MCP_URL, {
    headers: {
      Origin: "http://evil.example",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: "{}",
  });
  assert.equal(status, 403);
});

test("the public listener answers 404 at /mcp", async () => {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (USER && PASS) {
    headers.Authorization =
      "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
  }
  for (const method of ["GET", "POST"]) {
    const response = await fetch(`${BASE}/mcp`, {
      method,
      headers,
      body: method === "POST" ? "{}" : undefined,
    });
    assert.equal(response.status, 404, method);
  }
});
