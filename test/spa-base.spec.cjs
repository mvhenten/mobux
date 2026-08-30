// Unit coverage for web/spa/src/lib/base.js — the helper every SPA URL goes
// through. Pure Node, no browser and no server: it drives the module against a
// stubbed document, so it also runs standalone (`make test-spa-base`).
//
// The stub implements just enough of querySelector to honour the real selector
// (`script[type="module"][src*="…"]`), so a wrong attribute in base.js fails
// here rather than only under a real mount.

const { test, expect } = require("@playwright/test");
const path = require("path");
const { pathToFileURL } = require("url");

const MODULE = pathToFileURL(
  path.join(__dirname, "..", "web", "spa", "src", "lib", "base.js"),
).href;

// A selector matches the *attribute*, while `script.src` reads back the
// browser-resolved absolute URL — a distinction that matters now that the built
// document writes `./static/spa/…`. An element may therefore carry `attributes`
// separately from its properties; without it the two are the same string.
function attr(el, name) {
  return el.attributes?.[name] ?? el[name];
}

function matches(el, selector) {
  const [, tag] = selector.match(/^([a-z]+)/) || [];
  if (tag && tag !== el.tag) return false;
  for (const [, name, value] of selector.matchAll(/\[(\w+)="([^"]*)"\]/g)) {
    if (attr(el, name) !== value) return false;
  }
  for (const [, name, value] of selector.matchAll(/\[(\w+)\*="([^"]*)"\]/g)) {
    if (!String(attr(el, name) || "").includes(value)) return false;
  }
  return true;
}

function withDocument(scripts, fn) {
  const previous = globalThis.document;
  globalThis.document = {
    querySelector: (selector) =>
      scripts.find((el) => matches(el, selector)) || null,
  };
  try {
    return fn();
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}

const entry = (src) => [{ tag: "script", type: "module", src }];

const PROD = "assets/index-DEA9tKw5.js";
const DEV = "src/main.jsx";

test("derivePrefix reads the mount out of the entry script URL", async () => {
  const { derivePrefix } = await import(MODULE);

  expect(derivePrefix(`https://host/static/spa/${PROD}`)).toBe("");
  expect(derivePrefix(`https://host:5173/static/spa/${DEV}`)).toBe("");
  expect(derivePrefix(`https://host/user/host/8080/static/spa/${PROD}`)).toBe(
    "/user/host/8080",
  );
  expect(derivePrefix(`https://host/user/host/8080/static/spa/${DEV}`)).toBe(
    "/user/host/8080",
  );
  expect(derivePrefix(`https://host/user/host/8080/static/spa/`)).toBe(
    "/user/host/8080",
  );
});

test("derivePrefix falls back to the bare root when it cannot tell", async () => {
  const { derivePrefix } = await import(MODULE);

  expect(derivePrefix(null)).toBe("");
  expect(derivePrefix("")).toBe("");
  expect(derivePrefix("https://host/app")).toBe("");
  expect(derivePrefix("not a url at all")).toBe("");
});

test("u() is the identity at the bare-root prefix", async () => {
  const { u } = await import(MODULE);
  const paths = [
    "/api/sessions",
    "/api/stt/models",
    "/static/terminal.js?v=spa",
    "/static/vendor/xterm.css?v=spa",
  ];

  withDocument(entry(`https://host/static/spa/${PROD}`), () => {
    for (const path of paths) expect(u(path)).toBe(path);
  });

  // No entry script (server-rendered page, or a test importing the module)
  // resolves the same way — nothing gets a prefix it cannot verify.
  withDocument([], () => {
    for (const path of paths) expect(u(path)).toBe(path);
  });
});

test("u() prefixes root-relative paths under a mounted prefix", async () => {
  const { u } = await import(MODULE);

  withDocument(entry(`https://host/user/host/8080/static/spa/${PROD}`), () => {
    expect(u("/api/sessions")).toBe("/user/host/8080/api/sessions");
    expect(u("/api/stt/models")).toBe("/user/host/8080/api/stt/models");
    expect(u("/static/terminal.js?v=spa")).toBe(
      "/user/host/8080/static/terminal.js?v=spa",
    );
    expect(u("/static/spa/assets/x.js")).toBe(
      "/user/host/8080/static/spa/assets/x.js",
    );
  });
});

test("u() leaves URLs that already name an origin alone", async () => {
  const { u } = await import(MODULE);

  withDocument(entry(`https://host/user/host/8080/static/spa/${PROD}`), () => {
    expect(u("https://api.openai.com/v1/models")).toBe(
      "https://api.openai.com/v1/models",
    );
    expect(u("//host/api/sessions")).toBe("//host/api/sessions");
    expect(u("assets/index.js")).toBe("assets/index.js");
  });
});

test("u() follows the document it is asked about, not the first one it saw", async () => {
  const { u } = await import(MODULE);

  withDocument(entry(`https://host/a/static/spa/${PROD}`), () => {
    expect(u("/api/sessions")).toBe("/a/api/sessions");
  });
  withDocument(entry(`https://host/b/c/static/spa/${PROD}`), () => {
    expect(u("/api/sessions")).toBe("/b/c/api/sessions");
  });
});

// Vite writes the entry script relative (`./static/spa/assets/index-<hash>.js`)
// so the document loads its assets from whatever mount it was served under. The
// helper's selector still has to match that attribute, and the prefix still has
// to come out of the absolute URL the browser resolves it to.
test("the entry script is found and read through its relative attribute", async () => {
  const { u } = await import(MODULE);

  const relativeEntry = (mount) => [
    {
      tag: "script",
      type: "module",
      attributes: { src: `./static/spa/${PROD}` },
      src: `https://host${mount}/static/spa/${PROD}`,
    },
  ];

  withDocument(relativeEntry("/user/host/8080"), () => {
    expect(u("/api/sessions")).toBe("/user/host/8080/api/sessions");
  });
  withDocument(relativeEntry(""), () => {
    expect(u("/api/sessions")).toBe("/api/sessions");
  });
});

test("the entry script lookup ignores scripts that are not the SPA entry", async () => {
  const { u } = await import(MODULE);

  const scripts = [
    {
      tag: "script",
      type: "text/javascript",
      src: "https://host/p/static/spa/legacy.js",
    },
    {
      tag: "script",
      type: "module",
      src: "https://host/p/static/telemetry.js",
    },
    { tag: "script", type: "module", src: `https://host/p/static/spa/${PROD}` },
  ];
  withDocument(scripts, () => {
    expect(u("/api/sessions")).toBe("/p/api/sessions");
  });
});
