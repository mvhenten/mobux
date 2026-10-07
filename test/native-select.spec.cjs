// Select mode in the live terminal view, under both renderers: a long-press
// on the touch overlay shows the rows on screen as real text on the
// renderer's cell grid, with the word under the finger selected through the
// browser's own selection; and the URLs on screen as anchors a tap opens and a
// long-press leaves to the browser.
//
// Headless Chromium fires no contextmenu for an emulated touch long-press,
// so the specs dispatch the contextmenu Chrome Android fires for one.
//
// Run with: make test-native-select

const { test, expect } = require("./fixtures.cjs");
const path = require("path");
const { createTmuxRunner, SMOKE_TMUX_SOCKET } = require("./lib/tmux.cjs");
const terminalPage = require("./lib/terminal-page.cjs");

const BASE = process.env.MOBUX_URL || "https://localhost:5151";
const USER = process.env.MOBUX_USER || "";
const PASS = process.env.MOBUX_PASS || "";
const AUTH =
  USER && PASS
    ? "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64")
    : null;
const SESSION = process.env.MOBUX_TEST_SESSION || "mobux-native-select";
const SANDBOX_HOME = process.env.MOBUX_TEST_HOME || "/tmp/mobux-smoke/home";
const SHELL_ENV = `-e HISTFILE=/dev/null -e HOME=${SANDBOX_HOME}`;
const ALT_TEXT_SCRIPT = path.join(__dirname, "assets", "alt-screen-text.sh");
const tmux = createTmuxRunner(SMOKE_TMUX_SOCKET);

test.use({
  ...(AUTH ? { extraHTTPHeaders: { Authorization: AUTH } } : {}),
});

test.beforeAll(() => {
  try {
    tmux(`kill-session -t ${SESSION}`);
  } catch (_) {}
  tmux(`new-session -d -s ${SESSION} ${SHELL_ENV} "bash --norc --noprofile"`);
  // Select mode ends when the rows in view change, so no clock ticks in the
  // status line under a test.
  tmux(`set-option -t ${SESSION} status-right static`);
});

test.beforeEach(() => {
  terminalPage.resetSession(tmux, SESSION);
});

test.afterEach(() => {
  tmux(`respawn-pane -k ${SHELL_ENV} -t ${SESSION} "bash --norc --noprofile"`);
});

test.afterAll(() => {
  try {
    tmux(`kill-session -t ${SESSION}`);
  } catch (_) {}
});

const bootTerminal = (page) => terminalPage.bootTerminal(page, BASE, SESSION);

function echoLine(text) {
  tmux(`send-keys -t ${SESSION} "echo '${text}'" Enter`);
}

// The row (from the viewport's top) and column where `needle` is drawn on
// the row whose text is exactly `line`.
async function findOnScreen(page, line, needle) {
  let found = null;
  await expect
    .poll(
      async () => {
        found = await page.evaluate(
          ({ line, needle }) => {
            const t = window.__mobuxView.test;
            const top = t.viewportY();
            for (let r = 0; r < t.rows(); r++) {
              const text = (t.lineText(top + r) || "").trimEnd();
              if (text === line) return { row: r, col: text.indexOf(needle) };
            }
            return null;
          },
          { line, needle },
        );
        return found;
      },
      { timeout: 8000 },
    )
    .not.toBeNull();
  return found;
}

function cellPoint(page, col, row) {
  return page.evaluate(
    ({ col, row }) => {
      const t = window.__mobuxView.test;
      const origin = t.cellOrigin();
      const cell = t.cellMetrics();
      return {
        x: origin.x + (col + 0.5) * cell.width,
        y: origin.y + (row + 0.5) * cell.height,
      };
    },
    { col, row },
  );
}

// The rows in view stop changing: the prompt after the output has arrived.
async function quiet(page) {
  const rows = () =>
    page.evaluate(() => {
      const t = window.__mobuxView.test;
      const top = t.viewportY();
      return Array.from({ length: t.rows() }, (_, r) => t.lineText(top + r));
    });
  let before = await rows();
  await expect
    .poll(
      async () => {
        await page.waitForTimeout(250);
        const now = await rows();
        const same = JSON.stringify(now) === JSON.stringify(before);
        before = now;
        return same;
      },
      { timeout: 8000 },
    )
    .toBe(true);
}

// The contextmenu Chrome fires for a long-press; `pointerType` "mouse" is a
// right-click.
async function longPress(page, { x, y }, pointerType = "touch") {
  await quiet(page);
  await page.evaluate(
    ({ x, y, pointerType }) => {
      document.getElementById("touchOverlay").dispatchEvent(
        new PointerEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          pointerType,
        }),
      );
    },
    { x, y, pointerType },
  );
}

const selectState = (page) =>
  page.evaluate(() => window.__mobuxView.test.nativeSelection());

// Where `needle` is drawn inside `root`: the client box of its characters in
// the first text node that holds it.
function glyphBox(page, rootSelector, needle) {
  return page.evaluate(
    ({ rootSelector, needle }) => {
      const root = document.querySelector(rootSelector);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.data.indexOf(needle);
        if (at === -1) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        const r = range.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      }
      return null;
    },
    { rootSelector, needle },
  );
}

// Every external open goes through the TWA's intent:// path and is recorded
// instead of navigating.
async function recordExternalOpens(page) {
  await page.evaluate(() => {
    window.__opened = [];
    Object.defineProperty(document, "referrer", {
      configurable: true,
      get: () => "android-app://io.github.mvhenten.mobux",
    });
    window.__mobuxNavigateToUrl = (url) => window.__opened.push(url);
  });
}

test("long-press selects the word under the finger in the text layer", async ({
  page,
}) => {
  await bootTerminal(page);
  echoLine("alpha bravo charlie");
  const at = await findOnScreen(page, "alpha bravo charlie", "bravo");
  const point = await cellPoint(page, at.col + 2, at.row);

  await longPress(page, point);

  await expect(page.locator(".select-layer")).toBeVisible();
  const state = await selectState(page);
  expect(state).toMatchObject({ active: true, inLayer: true, text: "bravo" });
  expect(await page.evaluate(() => getSelection().toString())).toBe("bravo");
  const probe = await page.evaluate(({ x, y }) => {
    const overlay = document.getElementById("touchOverlay");
    return {
      overlay: getComputedStyle(overlay).pointerEvents,
      hit: !!document.elementFromPoint(x, y)?.closest(".select-layer"),
      rendererSelection: window.__mobuxView.test.hasSelection(),
    };
  }, point);
  expect(probe).toEqual({
    overlay: "none",
    hit: true,
    rendererSelection: false,
  });
});

test("the layer's rows sit on the renderer's glyphs on the alternate screen above the status line", async ({
  page,
}) => {
  await bootTerminal(page);
  const cols = await page.evaluate(() => window.__mobuxView.test.cols());
  const far = `grid-far${" ".repeat(cols - 1 - "grid-far".length - "edgeword".length)}edgeword`;
  tmux(
    `send-keys -t ${SESSION} "bash ${ALT_TEXT_SCRIPT} 'grid-top alpha' 'grid-mid      bravo' '${far}' 'grid-low charlie'" Enter`,
  );
  const edge = await findOnScreen(page, far, "edgeword");
  expect(edge.col + "edgeword".length).toBe(cols - 1);
  const low = await findOnScreen(page, "grid-low charlie", "charlie");
  const top = await findOnScreen(page, "grid-top alpha", "alpha");
  await expect
    .poll(() => page.evaluate(() => window.__mobuxView.test.paneAlternate()))
    .toBe(true);

  await longPress(page, await cellPoint(page, top.col, top.row));
  expect((await selectState(page)).text).toBe("alpha");

  const grid = await page.evaluate(() => {
    const t = window.__mobuxView.test;
    const rows = [...document.querySelectorAll(".select-layer .select-row")];
    return {
      origin: t.cellOrigin(),
      cell: t.cellMetrics(),
      screenRows: t.rows(),
      boxes: rows.map((r) => {
        const b = r.getBoundingClientRect();
        return { left: b.left, top: b.top, height: b.height };
      }),
    };
  });
  expect(grid.boxes).toHaveLength(grid.screenRows);
  grid.boxes.forEach((box, i) => {
    expect(
      Math.abs(box.top - (grid.origin.y + i * grid.cell.height)),
    ).toBeLessThanOrEqual(1);
    expect(Math.abs(box.height - grid.cell.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.left - grid.origin.x)).toBeLessThanOrEqual(1);
  });
  expect(low.row).toBe(grid.screenRows - 2);

  for (const needle of ["grid-top", "alpha", "bravo", "edgeword", "charlie"]) {
    const drawn = await glyphBox(page, "#terminal", needle);
    const layered = await glyphBox(page, ".select-layer", needle);
    expect(drawn, needle).not.toBeNull();
    expect(layered, needle).not.toBeNull();
    expect(Math.abs(layered.left - drawn.left), needle).toBeLessThanOrEqual(1);
    expect(Math.abs(layered.top - drawn.top), needle).toBeLessThanOrEqual(1);
    expect(Math.abs(layered.width - drawn.width), needle).toBeLessThanOrEqual(
      1,
    );
  }
});

// The regression: a single tap on a URL opened nothing.
test("a single tap on a URL opens it outside the shell", async ({ page }) => {
  await bootTerminal(page);
  await recordExternalOpens(page);
  echoLine("open https://example.com/tap-path now");
  const at = await findOnScreen(
    page,
    "open https://example.com/tap-path now",
    "example",
  );
  const point = await cellPoint(page, at.col, at.row);

  await quiet(page);
  await page.touchscreen.tap(point.x, point.y);

  await expect.poll(() => page.evaluate(() => window.__opened)).toHaveLength(1);
  const opened = await page.evaluate(() => window.__opened);
  expect(opened[0]).toContain("intent://example.com/tap-path#Intent");
  expect(opened[0]).toContain(
    `S.browser_fallback_url=${encodeURIComponent("https://example.com/tap-path")}`,
  );
  expect((await selectState(page)).active).toBe(false);
});

test("a long-press on a URL is left to the browser's link menu", async ({
  page,
}) => {
  await bootTerminal(page);
  echoLine("hold https://example.com/hold-path now");
  const at = await findOnScreen(
    page,
    "hold https://example.com/hold-path now",
    "example",
  );
  const point = await cellPoint(page, at.col, at.row);
  await quiet(page);

  const menu = await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    const notPrevented = target.dispatchEvent(
      new PointerEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        pointerType: "touch",
      }),
    );
    return {
      href: target.closest(".link-layer a")?.getAttribute("href") ?? null,
      notPrevented,
    };
  }, point);

  expect(menu).toEqual({
    href: "https://example.com/hold-path",
    notPrevented: true,
  });
  expect((await selectState(page)).active).toBe(false);
  await expect(page.locator(".select-layer")).toBeHidden();
});

test("a double-tap on a URL shows the input bar and opens nothing", async ({
  page,
}) => {
  await bootTerminal(page);
  await recordExternalOpens(page);
  echoLine("twice https://example.com/double-path now");
  const at = await findOnScreen(
    page,
    "twice https://example.com/double-path now",
    "example",
  );
  const point = await cellPoint(page, at.col, at.row);
  await quiet(page);

  const cdp = await page.context().newCDPSession(page);
  const touchAt = (type) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x: point.x, y: point.y }],
    });
  for (let i = 0; i < 2; i++) {
    await touchAt("touchStart");
    await page.waitForTimeout(40);
    await touchAt("touchEnd");
    await page.waitForTimeout(80);
  }

  await expect(page.locator("#inputBar")).toBeVisible();
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => window.__opened)).toEqual([]);
});

test("after a scroll each link anchor sits on the URL the renderer draws", async ({
  page,
}) => {
  await bootTerminal(page);
  tmux(
    `send-keys -t ${SESSION} "for i in \\$(seq 10 69); do echo https://example.com/row-\\$i; done" Enter`,
  );
  await findOnScreen(page, "https://example.com/row-69", "https");
  await quiet(page);
  const atBottom = () =>
    page.evaluate(() => {
      const t = window.__mobuxView.test;
      const top = t.viewportY();
      const shown = Array.from({ length: t.rows() }, (_, r) =>
        (t.lineText(top + r) || "").trim(),
      );
      return shown.includes("https://example.com/row-69") ? top : -1;
    });
  let bottom = -1;
  await expect
    .poll(
      async () => {
        const before = await atBottom();
        await page.waitForTimeout(250);
        bottom = await atBottom();
        return bottom > 0 && bottom === before;
      },
      { timeout: 8000 },
    )
    .toBe(true);
  await page.evaluate(
    (n) => window.__mobuxView.test.scrollLines(-n),
    Math.min(20, bottom),
  );
  await expect
    .poll(() => page.evaluate(() => window.__mobuxView.test.viewportY()))
    .toBeLessThan(bottom);

  await expect
    .poll(
      async () => {
        const anchors = await page.evaluate(() =>
          [...document.querySelectorAll(".link-layer a")].map((a) => {
            const b = a.getBoundingClientRect();
            return {
              href: a.getAttribute("href"),
              left: b.left,
              middle: b.top + b.height / 2,
              width: b.width,
            };
          }),
        );
        const off = [];
        const printed = anchors.filter((a) => /row-\d+$/.test(a.href));
        for (const anchor of printed) {
          const drawn = await glyphBox(page, "#terminal", anchor.href);
          if (
            !drawn ||
            Math.abs(drawn.left - anchor.left) > 1 ||
            Math.abs(drawn.top + drawn.height / 2 - anchor.middle) > 1 ||
            Math.abs(drawn.width - anchor.width) > 1
          )
            off.push(anchor.href);
        }
        return { count: printed.length >= 10, off };
      },
      { timeout: 8000 },
    )
    .toEqual({ count: true, off: [] });
});

test("a tap that collapses the selection hides the layer and gives the overlay back", async ({
  page,
}) => {
  await bootTerminal(page);
  echoLine("alpha bravo charlie");
  const at = await findOnScreen(page, "alpha bravo charlie", "bravo");
  await longPress(page, await cellPoint(page, at.col, at.row));
  expect((await selectState(page)).active).toBe(true);

  const blank = await cellPoint(page, 4, at.row + 4);
  await page.touchscreen.tap(blank.x, blank.y);

  await expect.poll(async () => (await selectState(page)).active).toBe(false);
  await expect(page.locator(".select-layer")).toBeHidden();
  expect(
    await page.evaluate(
      () =>
        getComputedStyle(document.getElementById("touchOverlay")).pointerEvents,
    ),
  ).toBe("auto");
});

test("the pane switching to its alternate screen leaves select mode", async ({
  page,
}) => {
  await bootTerminal(page);
  echoLine("alpha bravo charlie");
  const at = await findOnScreen(page, "alpha bravo charlie", "bravo");
  await longPress(page, await cellPoint(page, at.col, at.row));
  expect((await selectState(page)).active).toBe(true);

  tmux(
    `send-keys -t ${SESSION} "bash ${ALT_TEXT_SCRIPT} 'other screen' 'end'" Enter`,
  );

  await expect.poll(async () => (await selectState(page)).active).toBe(false);
  await expect(page.locator(".select-layer")).toBeHidden();
});

// The regression: the input bar appears under the finger on the second tap,
// and the compatibility click that followed landed on a ribbon button.
test("a double-tap where the input bar appears reaches the bar and no button in it", async ({
  page,
}) => {
  await bootTerminal(page);
  const ribbon = await page.evaluate(async () => {
    const bar = document.getElementById("inputBar");
    bar.classList.remove("hidden");
    const r = document.getElementById("inputRibbon").getBoundingClientRect();
    bar.classList.add("hidden");
    window.dispatchEvent(new Event("resize"));
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.evaluate(() => {
    window.__barEvents = [];
    for (const type of ["mousedown", "mouseup", "click"]) {
      document.addEventListener(
        type,
        (e) => {
          if (e.target.closest?.("#inputBar")) window.__barEvents.push(type);
        },
        true,
      );
    }
  });
  const cdp = await page.context().newCDPSession(page);
  const touchAt = (type) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x: ribbon.x, y: ribbon.y }],
    });

  for (let i = 0; i < 2; i++) {
    await touchAt("touchStart");
    await page.waitForTimeout(40);
    await touchAt("touchEnd");
    await page.waitForTimeout(80);
  }

  await expect(page.locator("#inputBar")).toBeVisible();
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__barEvents)).toEqual([]);
  await expect(page.locator("#terminal")).toBeVisible();
  expect((await selectState(page)).active).toBe(false);
});

test("long-press on an emoji-prefixed row selects the word under the finger", async ({
  page,
}) => {
  await bootTerminal(page);
  await page.evaluate(async () => {
    const t = window.__mobuxView.test;
    await t.injectLines(0);
    await t.writeData("\x1b[H\x1b[2J🚀 deploy staging now\r\n");
  });
  // Whether the rocket takes one cell or two, column 12 is in "staging"
  // and column 5 in "deploy".
  await longPress(page, await cellPoint(page, 12, 0));
  expect((await selectState(page)).text).toBe("staging");

  await page.evaluate(() => getSelection().removeAllRanges());
  await expect.poll(async () => (await selectState(page)).active).toBe(false);
  await longPress(page, await cellPoint(page, 5, 0));
  expect((await selectState(page)).text).toBe("deploy");
});

test("scrolled back, the layer shows the rows the renderer shows", async ({
  page,
}) => {
  await bootTerminal(page);
  tmux(
    `send-keys -t ${SESSION} "for i in \\$(seq 1 120); do echo scroll-row-\\$i; done" Enter`,
  );
  await findOnScreen(page, "scroll-row-120", "scroll");
  await page.evaluate(() => window.__mobuxView.test.scrollLines(-30));
  const expected = await page.evaluate(() => {
    const t = window.__mobuxView.test;
    return (t.lineText(t.viewportY() + 3) || "").trim();
  });
  expect(expected).toMatch(/^scroll-row-\d+$/);

  await longPress(page, await cellPoint(page, 2, 3));

  expect((await selectState(page)).text).toBe(expected);
});

test("a mouse right-click keeps the browser's menu and enters no select mode", async ({
  page,
}) => {
  await bootTerminal(page);
  echoLine("alpha bravo charlie");
  const at = await findOnScreen(page, "alpha bravo charlie", "bravo");

  await longPress(page, await cellPoint(page, at.col, at.row), "mouse");

  expect((await selectState(page)).active).toBe(false);
  await expect(page.locator(".select-layer")).toBeHidden();
});

test("a copy across two lines keeps them apart and a wrapped line whole", async ({
  page,
}) => {
  await bootTerminal(page);
  const cols = await page.evaluate(() => window.__mobuxView.test.cols());
  const long = "w".repeat(cols + 6);
  tmux(`send-keys -t ${SESSION} "printf 'copy-a\\ncopy-b\\n${long}\\n'" Enter`);
  const a = await findOnScreen(page, "copy-a", "copy");

  await longPress(page, await cellPoint(page, 2, a.row));
  expect((await selectState(page)).text).toBe("copy-a");

  const across = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".select-layer .select-row")];
    const first = rows.find((r) => r.textContent.startsWith("copy-a"));
    const second = rows.find((r) => r.textContent.startsWith("copy-b"));
    getSelection().setBaseAndExtent(
      first.firstChild,
      0,
      second.firstChild,
      "copy-b".length,
    );
    return getSelection().toString();
  });
  expect(across).toBe("copy-a\ncopy-b");

  await page.evaluate(() => getSelection().removeAllRanges());
  await expect.poll(async () => (await selectState(page)).active).toBe(false);
  await longPress(page, await cellPoint(page, 3, a.row + 2));
  expect((await selectState(page)).text).toBe(long);
});

test("output while select mode is on ends it", async ({ page }) => {
  await bootTerminal(page);
  echoLine("alpha bravo charlie");
  const at = await findOnScreen(page, "alpha bravo charlie", "bravo");
  await longPress(page, await cellPoint(page, at.col, at.row));
  expect((await selectState(page)).active).toBe(true);

  echoLine("more output");

  await expect.poll(async () => (await selectState(page)).active).toBe(false);
  await expect(page.locator(".select-layer")).toBeHidden();
});
