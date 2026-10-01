// The Cloudflare Access listener (issue #333, stage 3). The smoke instance
// listens on MOBUX_ACCESS_PORT (loopback only) and trusts the team at
// http://127.0.0.1:MOBUX_ACCESS_JWKS_PORT, whose keys this spec serves. Tokens
// are RS256 JWTs signed here with node:crypto, the way Cloudflare signs them.
//
// The verifier fetches the keys on the first Access request, so the key
// server is up before any test talks to the listener. The key is kept in the
// smoke data dir: the instance caches the first key it sees, and a second
// project or run against the same instance must sign with that same key.
//
// Run with: make test-access (also part of make test-critical-path)

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { test, expect } = require("./fixtures.cjs");

const BASE = process.env.MOBUX_URL || "http://127.0.0.1:8281";
const USER = process.env.MOBUX_USER || "";
const PASS = process.env.MOBUX_PASS || "";
const BASIC =
  USER && PASS
    ? "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64")
    : null;
const DATA_DIR = process.env.MOBUX_DATA_DIR || "/tmp/mobux-smoke";
const ACCESS_PORT = Number(process.env.MOBUX_ACCESS_PORT || 8293);
const JWKS_PORT = Number(process.env.MOBUX_ACCESS_JWKS_PORT || 8292);
const AUD = process.env.MOBUX_ACCESS_AUD || "mobux-smoke-aud";
const EMAIL = process.env.MOBUX_ACCESS_EMAIL || "smoke@example.com";
const ACCESS = `http://127.0.0.1:${ACCESS_PORT}`;
const TEAM = `http://127.0.0.1:${JWKS_PORT}`;
const KID = "smoke-access-key";
const ASSERTION = "Cf-Access-Jwt-Assertion";
const SESSION = `access-${process.pid}`;
const PROXY_FIXTURE_PORT = Number(process.env.MOBUX_PROXY_FIXTURE_PORT || 8291);
const EVIL = "http://evil.example";

test.use({
  ...(BASIC ? { extraHTTPHeaders: { Authorization: BASIC } } : {}),
});

function loadKey() {
  const file = path.join(DATA_DIR, "access-fixture-key.pem");
  if (fs.existsSync(file)) {
    return crypto.createPrivateKey(fs.readFileSync(file));
  }
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }));
  return privateKey;
}

const privateKey = loadKey();

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    aud: [AUD],
    iss: TEAM,
    email: EMAIL,
    iat: now,
    nbf: now,
    exp: now + 600,
    ...overrides,
  };
  const input = `${base64url({ alg: "RS256", kid: KID, typ: "JWT" })}.${base64url(claims)}`;
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(input), privateKey)
    .toString("base64url");
  return `${input}.${signature}`;
}

let keyServer;
let upstream;

test.beforeAll(async () => {
  const jwk = {
    ...crypto.createPublicKey(privateKey).export({ format: "jwk" }),
    kid: KID,
    alg: "RS256",
    use: "sig",
  };
  keyServer = http.createServer((req, res) => {
    if (req.url !== "/cdn-cgi/access/certs") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((resolve, reject) => {
    keyServer.once("error", reject);
    keyServer.listen(JWKS_PORT, "127.0.0.1", resolve);
  });
  const { startUpstream } = await import(
    path.join(__dirname, "assets", "proxy-upstream.mjs")
  );
  upstream = await startUpstream(PROXY_FIXTURE_PORT);
});

test.afterAll(async () => {
  await fetch(`${ACCESS}/api/sessions/${SESSION}/kill`, {
    method: "POST",
    headers: { [ASSERTION]: sign() },
  }).catch(() => {});
  if (keyServer) await new Promise((resolve) => keyServer.close(resolve));
  if (upstream) await upstream.close();
});

async function expectRefused(response, reason) {
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toBe(
    'Bearer realm="cloudflare-access"',
  );
  const body = await response.text();
  expect(body.trim().split("\n")).toHaveLength(1);
  expect(body).toContain(reason);
}

async function expectHomeRenders(context) {
  const page = await context.newPage();
  const response = await page.goto(`${ACCESS}/app#/`);
  expect(response.status()).toBe(200);
  await expect(page.locator(".app-wordmark")).toBeVisible();
  const sessions = await page.request.get(`${ACCESS}/api/sessions`);
  expect(sessions.status()).toBe(200);
  expect(Array.isArray(await sessions.json())).toBe(true);
}

test("access: a valid header token reaches the app", async ({ browser }) => {
  const context = await browser.newContext({
    extraHTTPHeaders: { [ASSERTION]: sign() },
  });
  await expectHomeRenders(context);
  await context.close();
});

test("access: a valid CF_Authorization cookie reaches the app", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await context.addCookies([
    { name: "CF_Authorization", value: sign(), url: ACCESS },
  ]);
  await expectHomeRenders(context);
  await context.close();
});

function openTerminal(headers) {
  return new Promise((resolve) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${ACCESS_PORT}/ws/${SESSION}`,
      {
        headers,
      },
    );
    const timer = setTimeout(() => {
      socket.close();
      resolve({ opened: false, output: false });
    }, 10000);
    let opened = false;
    socket.addEventListener("open", () => {
      opened = true;
    });
    socket.addEventListener("message", () => {
      clearTimeout(timer);
      socket.close();
      resolve({ opened, output: true });
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      resolve({ opened, output: false });
    });
  });
}

test("access: a terminal WebSocket opens with a token and is refused without", async () => {
  const created = await fetch(`${ACCESS}/api/sessions`, {
    method: "POST",
    headers: { [ASSERTION]: sign(), "content-type": "application/json" },
    body: JSON.stringify({ name: SESSION }),
  });
  expect(created.status).toBe(200);

  expect(await openTerminal({ [ASSERTION]: sign() })).toEqual({
    opened: true,
    output: true,
  });
  expect(await openTerminal({})).toEqual({ opened: false, output: false });
  expect(await openTerminal({ Authorization: BASIC || "Basic eDp4" })).toEqual({
    opened: false,
    output: false,
  });
});

test("access: a cross-site Origin is refused on the WebSocket and on /api/upload", async () => {
  expect(await openTerminal({ [ASSERTION]: sign(), Origin: EVIL })).toEqual({
    opened: false,
    output: false,
  });

  // An empty body puts the whole request on the wire before the guard
  // answers; a body still in flight would meet a closed connection.
  const upload = await fetch(`${ACCESS}/api/upload`, {
    method: "POST",
    headers: { cookie: `CF_Authorization=${sign()}`, Origin: EVIL },
  });
  expect(upload.status).toBe(403);
  expect(await upload.text()).toBe(
    "cross-site request refused: the Origin does not match this host\n",
  );
});

test("access: served directories and proxied ports need a token", async () => {
  for (const mount of ["/files/site/", "/proxy/up/"]) {
    const refused = await fetch(`${ACCESS}${mount}`);
    expect(refused.status, mount).toBe(401);
    const served = await fetch(`${ACCESS}${mount}`, {
      headers: { [ASSERTION]: sign() },
    });
    expect(served.status, mount).toBe(200);
  }
});

test("access: the MCP server is never reachable through the Access listener", async () => {
  const response = await fetch(`${ACCESS}/mcp`, {
    method: "POST",
    headers: { [ASSERTION]: sign() },
  });
  expect(response.status).toBe(404);
  expect(await response.text()).toBe("MCP is served on 127.0.0.1 only");
});

test("access: a proxied app never receives the Access token", async () => {
  const response = await fetch(`${ACCESS}/proxy/up/headers`, {
    headers: {
      [ASSERTION]: sign(),
      cookie: `theme=dark; CF_Authorization=${sign()}; lang=nl`,
    },
  });
  expect(response.status).toBe(200);
  const seen = await response.json();
  expect(seen).not.toHaveProperty("cf-access-jwt-assertion");
  expect(seen.cookie).toBe("theme=dark; lang=nl");
});

test("access: an expired token is refused naming the reason", async () => {
  const now = Math.floor(Date.now() / 1000);
  const response = await fetch(`${ACCESS}/api/sessions`, {
    headers: {
      [ASSERTION]: sign({ iat: now - 900, nbf: now - 900, exp: now - 300 }),
    },
  });
  await expectRefused(response, "session has expired");
});

test("access: a token for another audience is refused", async () => {
  const response = await fetch(`${ACCESS}/api/sessions`, {
    headers: { [ASSERTION]: sign({ aud: ["another-app"] }) },
  });
  await expectRefused(response, "AUD mismatch");
});

test("access: no token gets the Bearer challenge and never Basic", async () => {
  const response = await fetch(`${ACCESS}/api/sessions`, {
    headers: BASIC ? { Authorization: BASIC } : {},
  });
  await expectRefused(response, "no Cloudflare Access token");
  expect(response.headers.get("www-authenticate")).not.toContain("Basic");
});

test("access: the public paths answer without a token", async () => {
  for (const publicPath of [
    "/static/manifest.json",
    "/static/icon-192.png",
    "/api/identify",
  ]) {
    const response = await fetch(`${ACCESS}${publicPath}`);
    expect(response.status, publicPath).toBe(200);
  }
});

test("access: the main listener still requires the PIN and ignores Access tokens", async () => {
  const withToken = await fetch(`${BASE}/api/sessions`, {
    headers: { [ASSERTION]: sign(), cookie: `CF_Authorization=${sign()}` },
  });
  expect(withToken.status).toBe(401);
  expect(withToken.headers.get("www-authenticate")).toContain("Basic");

  test.skip(!BASIC, "no PIN configured for the main listener");
  const withPin = await fetch(`${BASE}/api/sessions`, {
    headers: { Authorization: BASIC },
  });
  expect(withPin.status).toBe(200);
});

function lanAddress() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal)
        return address.address;
    }
  }
  return null;
}

function connects(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(3000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

test("access: the Access listener is reachable on loopback only", async () => {
  const lan = lanAddress();
  test.skip(!lan, "this host has no non-loopback IPv4 address");
  const mainPort = Number(new URL(BASE).port);
  expect(await connects(lan, mainPort)).toBe(true);
  expect(await connects("127.0.0.1", ACCESS_PORT)).toBe(true);
  expect(await connects(lan, ACCESS_PORT)).toBe(false);
});
