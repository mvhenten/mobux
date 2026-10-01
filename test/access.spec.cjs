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
    "/.well-known/assetlinks.json",
    "/static/manifest.json",
    "/static/icon-192.png",
    "/sw.js",
  ]) {
    const response = await fetch(`${ACCESS}${publicPath}`, {
      redirect: "manual",
    });
    expect(response.status, publicPath).not.toBe(401);
    expect(response.headers.get("www-authenticate"), publicPath).toBeNull();
  }
});

test("access: identify and the install page need a token", async () => {
  for (const privatePath of [
    "/api/identify",
    "/install",
    "/install/mobux-ca.crt",
  ]) {
    const response = await fetch(`${ACCESS}${privatePath}`, {
      redirect: "manual",
    });
    await expectRefused(response, "no Cloudflare Access token");
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

const UI_SESSION = `access-ui-${process.pid}`;
const ACCESS_UPLOAD_LIMIT = 100 * 1024 * 1024;
const OVERSIZED_UPLOAD = path.join(DATA_DIR, "access-oversized-upload.bin");

function signInUrl(url) {
  const target = new URL(url);
  target.searchParams.set("mobux_route", target.hash);
  return target.href;
}

async function buildInfo(base, headers) {
  const response = await fetch(`${base}/api/build-info`, { headers });
  expect(response.status).toBe(200);
  return response.json();
}

test("access: build-info reports the Access listener and its upload limit", async () => {
  const viaAccess = await buildInfo(ACCESS, { [ASSERTION]: sign() });
  expect(viaAccess.via_access).toBe(true);
  expect(viaAccess.upload_limit_bytes).toBe(ACCESS_UPLOAD_LIMIT);

  const main = await buildInfo(BASE, BASIC ? { Authorization: BASIC } : {});
  expect(main.via_access).toBe(false);
  expect(main.upload_limit_bytes).toBeGreaterThan(ACCESS_UPLOAD_LIMIT);
});

test("access: a client header never claims the Access listener", async () => {
  const main = await buildInfo(BASE, {
    ...(BASIC ? { Authorization: BASIC } : {}),
    [ASSERTION]: sign(),
    "X-Via-Access": "true",
  });
  expect(main.via_access).toBe(false);
});

async function accessPage(browser, options = {}) {
  const context = await browser.newContext({
    ...options,
    extraHTTPHeaders: { [ASSERTION]: sign() },
  });
  return { context, page: await context.newPage() };
}

test("access: the install page skips the CA step on the tunnel", async ({
  browser,
  page,
}) => {
  const tunnel = await accessPage(browser);
  await tunnel.page.goto(`${ACCESS}/app#/install`);
  await expect(
    tunnel.page.getByRole("heading", { name: "1. Install the app" }),
  ).toBeVisible();
  await expect(tunnel.page.locator("#installCaStep")).toHaveCount(0);
  await tunnel.context.close();

  await page.goto(`${BASE}/app#/install`);
  await expect(page.locator("#installCaStep")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "2. Install the app" }),
  ).toBeVisible();
});

const CLOUDFLARE_LOGIN =
  "https://smoke.cloudflareaccess.com/cdn-cgi/access/login/mobux.example.com";

function answerLikeAnExpiredSession(route) {
  return route.fulfill({
    status: 302,
    headers: { location: CLOUDFLARE_LOGIN },
    body: "",
  });
}

test("access: a lapsed session shows the signed-out notice, never an empty list", async ({
  browser,
}) => {
  const { context, page } = await accessPage(browser);
  await page.route(/\/api\/sessions(\?.*)?$/, answerLikeAnExpiredSession, {
    times: 1,
  });
  await page.goto(`${ACCESS}/app#/`);

  const notice = page.locator("#signedOutNotice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Cloudflare Access session has ended");
  await expect(page.getByText("No tmux sessions")).toHaveCount(0);

  const signIn = page.locator("#signInAgain");
  await expect(signIn).toHaveAttribute("href", signInUrl(page.url()));
  await signIn.click();
  await expect(page).toHaveURL(`${ACCESS}/app#/`);
  await expect(page.locator(".app-wordmark")).toBeVisible();
  await expect(page.locator("#signedOutNotice")).toHaveCount(0);
  await context.close();
});

test("access: signing in again restores the route a login dropped", async ({
  browser,
}) => {
  const { context, page } = await accessPage(browser);
  await page.goto(
    `${ACCESS}/app?mobux_route=${encodeURIComponent("#/install")}`,
  );
  await expect(page).toHaveURL(`${ACCESS}/app#/install`);
  await expect(
    page.getByRole("heading", { name: "1. Install the app" }),
  ).toBeVisible();
  await context.close();
});

async function openAccessTerminal(page) {
  const listed = await fetch(`${ACCESS}/api/sessions`, {
    headers: { [ASSERTION]: sign() },
  });
  const sessions = (await listed.json()).map((s) => s.name ?? s);
  if (!sessions.includes(UI_SESSION)) {
    const created = await fetch(`${ACCESS}/api/sessions`, {
      method: "POST",
      headers: { [ASSERTION]: sign(), "content-type": "application/json" },
      body: JSON.stringify({ name: UI_SESSION }),
    });
    expect(created.status).toBe(200);
  }
  await page.goto(`${ACCESS}/app#/s/${UI_SESSION}`);
  await page.waitForFunction(() => !!window.__mobuxView);
}

test("access: a terminal that drops while signed out shows the notice", async ({
  browser,
}) => {
  const { context, page } = await accessPage(browser);
  let socket = null;
  await page.routeWebSocket(/\/ws\//, (ws) => {
    ws.connectToServer();
    socket = ws;
  });
  await openAccessTerminal(page);
  await expect.poll(() => socket !== null).toBe(true);
  await expect(page.locator("#signedOutNotice")).toHaveCount(0);

  await page.route(/\/api\/build-info$/, answerLikeAnExpiredSession);
  await socket.close();

  await expect(page.locator("#signedOutNotice")).toBeVisible();
  await expect(page.locator("#signInAgain")).toHaveAttribute(
    "href",
    signInUrl(page.url()),
  );
  await context.close();
});

// Sparse, so it costs no disk. Exactly the limit: the multipart envelope
// around it would take the body over Cloudflare's cap.
function oversizedFile() {
  fs.writeFileSync(OVERSIZED_UPLOAD, "");
  fs.truncateSync(OVERSIZED_UPLOAD, ACCESS_UPLOAD_LIMIT);
  return OVERSIZED_UPLOAD;
}

test("access: an upload over the tunnel's limit is refused before it is sent", async ({
  browser,
}) => {
  const { context, page } = await accessPage(browser, {
    viewport: { width: 1280, height: 800 },
    hasTouch: false,
    isMobile: false,
  });
  const uploads = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/upload")) uploads.push(request.url());
  });
  await openAccessTerminal(page);

  await expect(page.locator("#mobux-top-bar")).toHaveCount(1);
  const file = oversizedFile();
  for (const input of await page.locator('input[type="file"]').all()) {
    await input.setInputFiles(file);
  }

  const surface = page.locator("#mobux-top-bar .mobux-attach-error");
  await expect(surface).toBeVisible();
  await expect(surface).toContainText(
    "Attach failed: upload refused: over the 100 MB limit on this connection",
  );
  expect(uploads).toEqual([]);
  await context.close();
});

function postDeclaredUpload(length) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${ACCESS}/api/upload`, {
      method: "POST",
      headers: {
        [ASSERTION]: sign(),
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(length),
      },
    });
    request.once("response", (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        request.destroy();
        resolve({ status: response.statusCode, body });
      });
    });
    request.once("error", reject);
    request.flushHeaders();
  });
}

test("access: the server refuses an over-limit upload with a one-line 413", async () => {
  const { status, body } = await postDeclaredUpload(150_000_000);
  expect(status).toBe(413);
  expect(body).toBe(
    "upload refused: the file is larger than the 100 MB limit on this connection",
  );
});

function postChunkedUpload(bytes) {
  return new Promise((resolve, reject) => {
    let answered = false;
    const request = http.request(`${ACCESS}/api/upload`, {
      method: "POST",
      headers: {
        [ASSERTION]: sign(),
        "content-type": "multipart/form-data; boundary=x",
        "transfer-encoding": "chunked",
      },
    });
    request.once("response", (response) => {
      answered = true;
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        request.destroy();
        resolve({ status: response.statusCode, body });
      });
    });
    request.on("error", (error) => {
      if (!answered) reject(error);
    });
    const chunk = Buffer.alloc(1024 * 1024, "a");
    let sent = 0;
    const pump = () => {
      if (sent === 0) {
        request.write(
          '--x\r\ncontent-disposition: form-data; name="file"; filename="big.bin"\r\n\r\n',
        );
      }
      while (!answered && sent < bytes) {
        sent += chunk.length;
        if (!request.write(chunk)) {
          request.once("drain", pump);
          return;
        }
      }
      if (!answered) request.end("\r\n--x--\r\n");
    };
    pump();
  });
}

test("access: the server refuses a chunked upload over the limit with a 413", async () => {
  const { status, body } = await postChunkedUpload(
    ACCESS_UPLOAD_LIMIT + 2 * 1024 * 1024,
  );
  expect(status).toBe(413);
  expect(body).toBe(
    "upload refused: the file is larger than the 100 MB limit on this connection",
  );
});

test.afterAll(async () => {
  fs.rmSync(OVERSIZED_UPLOAD, { force: true });
  await fetch(`${ACCESS}/api/sessions/${UI_SESSION}/kill`, {
    method: "POST",
    headers: { [ASSERTION]: sign() },
  }).catch(() => {});
});
