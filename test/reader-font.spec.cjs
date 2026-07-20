// Reader plain-output font (issue #218): `.rb-text` (and its bubbled runs)
// render in the vendored proportional face, while `.rb-prompt` / `.rb-code`
// stay on the monospace stack — command/prompt alignment depends on
// fixed-width columns, plain output does not.
//
// Drives reader.js's real render pipeline (createReader + term-tokenizer's
// tokenize) with a synthetic document snapshot instead of a live tmux/PTY
// session, so this stays decoupled from the terminal engine and OSC 133
// heuristics — it only needs `/static/reader.js` + `/static/style.css`,
// which any SPA route already loads.

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

test("reader: plain text is proportional, prompt/code stay monospace", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });

  const result = await page.evaluate(async () => {
    const { createReader } = await import("/static/reader.js");

    const host = document.createElement("div");
    host.id = "readerFontTest";
    document.body.appendChild(host);

    const line = (text, bg) => ({
      runs: [{ text, attrs: bg ? { bg } : {} }],
      text,
      osc: null,
    });

    // prompt, then plain text (one bare line + one bubbled line sharing a
    // background, so they fuse into a .rb-bubble), then a fenced code line.
    const snapshotLines = [
      line("~/project$"),
      line("plain command output, wrapped across the width"),
      line("a bubbled reply line", "#204060"),
      line("```"),
      line("const x = 1; // inside a code fence"),
      line("```"),
    ];

    const doc = {
      snapshot: () => ({ lines: snapshotLines, status: null }),
      subscribe: () => ({ dispose: () => {} }),
      onOscDetected: () => ({ dispose: () => {} }),
      oscDetected: true,
    };

    const reader = createReader({ host, document: doc });
    reader.mount();
    reader.forceRender();

    const fontOf = (sel) => {
      const el = host.querySelector(sel);
      return el ? getComputedStyle(el).fontFamily : null;
    };

    const out = {
      hasRbText: !!host.querySelector(".rb-text"),
      hasRbPrompt: !!host.querySelector(".rb-prompt"),
      hasRbCode: !!host.querySelector(".rb-code"),
      hasRbBubble: !!host.querySelector(".rb-bubble"),
      promptFont: fontOf(".rb-prompt"),
      textLineFont: fontOf(".rb-text .rb-line"),
      bubbleLineFont: fontOf(".rb-text .rb-bubble-line"),
      codeLineFont: fontOf(".rb-code .rb-codeline"),
    };

    reader.dispose();
    host.remove();
    return out;
  });

  // Sanity: the synthetic snapshot actually classified into all four kinds
  // of block this test cares about.
  expect(result.hasRbText).toBe(true);
  expect(result.hasRbPrompt).toBe(true);
  expect(result.hasRbCode).toBe(true);
  expect(result.hasRbBubble).toBe(true);

  // Plain output — bare line and bubbled line alike — resolves to the
  // vendored proportional face.
  expect(result.textLineFont).toContain("Inter");
  expect(result.bubbleLineFont).toContain("Inter");

  // Prompt and code stay off the proportional face; alignment there depends
  // on fixed-width columns.
  expect(result.promptFont).not.toContain("Inter");
  expect(result.codeLineFont).not.toContain("Inter");
});
