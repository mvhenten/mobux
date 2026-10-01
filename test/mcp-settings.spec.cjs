// Settings → MCP server: the row and sub-page, the read-only switch while
// MOBUX_MCP_PORT sets the port (the smoke instance sets it for
// test/mcp.test.mjs), and the registration command. The switch-on, 409 and
// port-move paths run against stubbed GET/PUT responses, since the smoke
// instance's port belongs to the environment; src/mcp_settings.rs covers the
// real start, stop and rebind. Runs on the smoke instance with `make test-spa`.

const { test, expect } = require("./fixtures.cjs");

const BASE = process.env.MOBUX_URL || "https://localhost:5151";
const APP = `${BASE}/app`;
const USER = process.env.MOBUX_USER || "";
const PASS = process.env.MOBUX_PASS || "";
const AUTH =
  USER && PASS
    ? "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64")
    : null;

test.use({
  ...(AUTH ? { extraHTTPHeaders: { Authorization: AUTH } } : {}),
});

const MCP = /\/api\/settings\/mcp$/;
const command = (port) =>
  `claude mcp add --scope user --transport http mobux http://127.0.0.1:${port}/mcp`;

const status = (port, listening) => ({
  port: listening ? port : 0,
  listening,
  listening_port: listening ? port : null,
  managed_by: null,
  managed_note: null,
  error: null,
  default_port: 8415,
  command: command(port),
});

async function stub(page, onPut, initial = status(8415, false)) {
  let current = initial;
  const puts = [];
  await page.route(MCP, async (route) => {
    const req = route.request();
    if (req.method() === "PUT") {
      const body = JSON.parse(req.postData());
      puts.push(body);
      const answer = onPut(body);
      if (answer.status !== 200) return route.fulfill(answer);
      current = answer.json;
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(current),
    });
  });
  return puts;
}

const ok = (port) => ({
  status: 200,
  json: status(port, port !== 0),
});

test("the MCP row opens a read-only page while the environment sets the port", async ({
  page,
  request,
}) => {
  const live = await (await request.get(`${BASE}/api/settings/mcp`)).json();
  expect(live.managed_by).toBe("env");
  expect(live.listening).toBe(true);

  await page.goto(`${APP}#/settings`, { waitUntil: "networkidle" });
  const row = page.locator('[data-row="mcp"]');
  await expect(row.locator(".settings-value")).toHaveText("From env");
  await row.click();
  await expect
    .poll(() => page.evaluate(() => location.hash))
    .toBe("#/settings/mcp");
  await expect(page.locator(".settings-header h1")).toHaveText("MCP server");

  await expect(page.locator('input[name="mcpEnabled"]')).toBeDisabled();
  await expect(page.locator('[data-switch="mcpEnabled"] small')).toHaveText(
    "MOBUX_MCP_PORT sets the port; unset it to use this switch.",
  );
  await expect(page.locator("#mcpPort")).toBeDisabled();
  await expect(page.locator("#mcpStatus")).toHaveText(
    `Listening on 127.0.0.1:${live.listening_port}`,
  );
  await expect(page.locator("#mcpCommand")).toHaveText(
    command(live.listening_port),
  );
});

test("Copy puts the registration command on the clipboard", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(BASE).origin,
  });
  await page.goto(`${APP}#/settings/mcp`, { waitUntil: "networkidle" });
  const text = await page.locator("#mcpCommand").textContent();
  expect(text).toMatch(/^claude mcp add --scope user --transport http mobux /);
  await page.locator("#mcpCopy").click();
  await expect(page.locator("#mcpCopy")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
});

test("the switch turns the server on through PUT and shows it listening", async ({
  page,
}) => {
  const puts = await stub(page, (body) => ok(body.port));
  await page.goto(`${APP}#/settings/mcp`, { waitUntil: "networkidle" });
  await expect(page.locator("#mcpStatus")).toHaveText("Off");
  await expect(page.locator("#mcpStatus")).not.toHaveClass(
    /settings-status--ok/,
  );
  await expect(page.locator("#mcpPort")).toHaveValue("8415");

  await page.locator('[data-switch="mcpEnabled"]').click();
  await expect(page.locator("#mcpStatus")).toHaveText(
    "Listening on 127.0.0.1:8415",
  );
  await expect(page.locator('input[name="mcpEnabled"]')).toBeChecked();
  expect(puts).toEqual([{ port: 8415 }]);

  await page.locator(".settings-back").click();
  await expect(page.locator('[data-row="mcp"] .settings-value')).toHaveText(
    "On · port 8415",
  );
});

test("a port in use shows the server's reason and leaves the switch off", async ({
  page,
}) => {
  const reason = "cannot listen on 127.0.0.1:8415: Address already in use";
  await stub(page, () => ({ status: 409, body: reason }));
  await page.goto(`${APP}#/settings/mcp`, { waitUntil: "networkidle" });

  await page.locator('[data-switch="mcpEnabled"]').click();
  await expect(page.locator("#mcpStatus")).toHaveText(reason);
  await expect(page.locator('input[name="mcpEnabled"]')).not.toBeChecked();
});

test("moving the port of a running server takes a second tap", async ({
  page,
}) => {
  const puts = await stub(page, (body) => ok(body.port));
  await page.goto(`${APP}#/settings/mcp`, { waitUntil: "networkidle" });
  await page.locator('[data-switch="mcpEnabled"]').click();
  await expect(page.locator("#mcpStatus")).toHaveText(
    "Listening on 127.0.0.1:8415",
  );

  await page.locator("#mcpPort").fill("9100");
  await page.locator("#mcpPort").press("Enter");
  const apply = page.locator("#mcpPortApply");
  await expect(apply).toHaveText("Move to 9100");
  await apply.click();
  await expect(apply).toHaveText("Tap again to move");
  expect(puts).toEqual([{ port: 8415 }]);

  await apply.click();
  await expect(page.locator("#mcpStatus")).toHaveText(
    "Listening on 127.0.0.1:9100",
  );
  await expect(page.locator("#mcpCommand")).toHaveText(command(9100));
  expect(puts).toEqual([{ port: 8415 }, { port: 9100 }]);
  await expect(apply).toHaveCount(0);
});

test("an empty or out-of-range port is refused with the rule and sends nothing", async ({
  page,
}) => {
  const puts = await stub(page, (body) => ok(body.port));
  await page.goto(`${APP}#/settings/mcp`, { waitUntil: "networkidle" });
  await page.locator('[data-switch="mcpEnabled"]').click();
  await expect(page.locator("#mcpStatus")).toHaveText(
    "Listening on 127.0.0.1:8415",
  );

  for (const bad of ["", "80", "70000"]) {
    await page.locator("#mcpPort").fill(bad);
    await page.locator("#mcpPort").press("Enter");
    await expect(page.locator("#mcpStatus")).toHaveText(
      "Port must be a whole number from 1024 to 65535.",
    );
    await expect(page.locator("#mcpPortApply")).toHaveCount(0);
  }
  expect(puts).toEqual([{ port: 8415 }]);
});

test("a port that would not bind at startup shows why", async ({ page }) => {
  const reason = "cannot listen on 127.0.0.1:8415: Address already in use";
  await stub(page, (body) => ok(body.port), {
    ...status(8415, false),
    port: 8415,
    error: reason,
  });
  await page.goto(`${APP}#/settings/mcp`, { waitUntil: "networkidle" });
  await expect(page.locator("#mcpStatus .settings-status-line")).toHaveText(
    `Failed to start: ${reason}`,
  );
});

test("a refused clipboard says Copy failed and selects the command", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
  });
  await page.goto(`${APP}#/settings/mcp`, { waitUntil: "networkidle" });
  await page.locator("#mcpCopy").click();
  await expect(page.locator("#mcpCopy")).toHaveText("Copy failed");
  expect(await page.evaluate(() => String(window.getSelection()))).toBe(
    await page.locator("#mcpCommand").textContent(),
  );
});
