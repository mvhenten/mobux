// Read mode: the conversation renderer (issue #234).
//
// Read mode renders a session's recorded turns as a dialogue — the typed
// command on the left, its output on the right, a muted pass/fail chip. It
// receives entries through setEntries / appendEntries and nothing else, so
// this spec drives the real module with synthetic entries: no tmux, no PTY,
// no terminal document. Same DOM-level approach as
// reader-command-grouping.spec.cjs.
//
// Visibility is asserted through getComputedStyle rather than the `hidden`
// attribute — a chip that exists but does not paint is not a chip.

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

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const NUL = String.fromCharCode(0x00);
const CR = String.fromCharCode(0x0d);

function manyLines(count) {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
}

// Mount read mode on a throwaway host, hand it the entries, and read back
// everything the acceptance criteria talk about in one round trip.
async function renderEntries(page, entries) {
  return page.evaluate(async (list) => {
    const { createReadMode } = await import("/static/read-mode.js");

    const host = document.createElement("div");
    host.id = "readModeRenderTest";
    host.style.width = "360px";
    host.style.height = "480px";
    document.body.appendChild(host);

    const readMode = createReadMode({ host, session: "spec" });
    readMode.mount();
    readMode.setEntries(list);

    const paints = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    };
    const textOf = (el, sel) => el.querySelector(sel)?.textContent ?? null;

    const turns = Array.from(host.querySelectorAll(".cv-turn")).map((el) => {
      const cmd = el.querySelector(".cv-cmd");
      const out = el.querySelector(".cv-out");
      const chip = el.querySelector(".cv-exit");
      const lines = Array.from(el.querySelectorAll(".cv-line"));
      return {
        seq: el.dataset.seq,
        flexDirection: getComputedStyle(el).flexDirection,
        promptText: textOf(el, ".cv-cmd-prompt"),
        commandText: textOf(el, ".cv-cmd-text"),
        cmdText: cmd ? cmd.textContent : null,
        cmdIsEmptyPlaceholder: !!el.querySelector(".cv-cmd--empty"),
        cmdVisible: paints(cmd),
        cmdAlignSelf: cmd ? getComputedStyle(cmd).alignSelf : null,
        cmdFontFamily: cmd ? getComputedStyle(cmd).fontFamily : null,
        hasOutput: !!out,
        outAlignSelf: out ? getComputedStyle(out).alignSelf : null,
        lineFontFamily: lines[0] ? getComputedStyle(lines[0]).fontFamily : null,
        lineCount: lines.length,
        firstLine: lines.length ? lines[0].textContent : null,
        lastLine: lines.length ? lines[lines.length - 1].textContent : null,
        clampMarker: textOf(el, ".cv-trunc--clamp"),
        serverMarker: textOf(el, ".cv-trunc--server"),
        exitText: chip ? chip.textContent : null,
        exitTitle: chip ? chip.title : null,
        exitOk: !!el.querySelector(".cv-exit--ok"),
        exitFail: !!el.querySelector(".cv-exit--fail"),
        exitVisible: paints(chip),
        exitAlignSelf: chip ? getComputedStyle(chip).alignSelf : null,
      };
    });

    const raws = Array.from(host.querySelectorAll(".cv-raw")).map((el) => ({
      seq: el.dataset.seq,
      text: el.textContent,
      fontFamily: getComputedStyle(el).fontFamily,
      visible: paints(el),
      hasExitChip: !!el.querySelector(".cv-exit"),
    }));

    const emptyEl = host.querySelector(".cv-empty");
    const result = {
      turns,
      raws,
      turnCount: turns.length,
      exitChipCount: host.querySelectorAll(".cv-exit").length,
      empty: emptyEl
        ? {
            visible: paints(emptyEl),
            text: textOf(emptyEl, ".cv-empty-text"),
            linkHref: emptyEl.querySelector("a")?.getAttribute("href") ?? null,
            linkVisible: paints(emptyEl.querySelector("a")),
          }
        : null,
    };

    readMode.dispose();
    host.remove();
    return result;
  }, entries);
}

async function stripSequences(page, inputs) {
  return page.evaluate(async (list) => {
    const { ansiToText } = await import("/static/read-mode.js");
    return list.map((input) => ansiToText(input));
  }, inputs);
}

test("read mode: a turn docks the command left and its output right", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });

  const result = await renderEntries(page, [
    {
      seq: 1,
      command: "user@host:~$ ls -la",
      output: "file1.txt\nfile2.txt\n",
      exitCode: 0,
    },
  ]);

  expect(result.turnCount).toBe(1);
  const [turn] = result.turns;

  expect(turn.seq).toBe("1");
  expect(turn.flexDirection).toBe("column");
  expect(turn.cmdAlignSelf).toBe("flex-start");
  expect(turn.outAlignSelf).toBe("flex-end");
  expect(turn.exitAlignSelf).toBe("flex-end");
  expect(turn.cmdVisible).toBe(true);

  // Monospace for what was typed, proportional for what came back.
  expect(turn.cmdFontFamily).toContain("JetBrains Mono");
  expect(turn.lineFontFamily).toContain("Inter");

  expect(turn.lineCount).toBe(2);
  expect(turn.firstLine).toBe("file1.txt");
  expect(turn.lastLine).toBe("file2.txt");
});

test("read mode: exit chips render pass, fail and nothing at all", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });

  const result = await renderEntries(page, [
    { seq: 1, command: "a$ true", output: "", exitCode: 0 },
    { seq: 2, command: "a$ false", output: "", exitCode: 1 },
    { seq: 3, command: "a$ sleep 100", output: "", exitCode: null },
  ]);

  const [ok, fail, running] = result.turns;

  expect(ok.exitOk).toBe(true);
  expect(ok.exitFail).toBe(false);
  expect(ok.exitVisible).toBe(true);
  expect(ok.exitText).toBe("✓");
  expect(ok.exitTitle).toBe("exit 0");

  expect(fail.exitFail).toBe(true);
  expect(fail.exitOk).toBe(false);
  expect(fail.exitVisible).toBe(true);
  expect(fail.exitText).toBe("✗ 1");
  expect(fail.exitTitle).toBe("exit 1");

  // Still running: no exit code yet, so no chip at all.
  expect(running.exitText).toBe(null);
  expect(result.exitChipCount).toBe(2);
});

test("read mode: ansiToText strips sequences instead of interpreting them", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });

  const table = [
    // SGR colour — dropped, not translated into styling.
    [`${ESC}[31mred${ESC}[0m text`, "red text"],
    // CSI cursor moves.
    [`a${ESC}[2Ab${ESC}[1;5Hc`, "abc"],
    [`${ESC}[2K${ESC}[1Gcleared`, "cleared"],
    // An OSC 133 marker that leaked into the output, both terminators.
    [`${ESC}]133;C${BEL}hello`, "hello"],
    [`${ESC}]0;window title${ESC}\\body`, "body"],
    // DCS passthrough.
    [`${ESC}Ptmux;passthrough${ESC}\\visible`, "visible"],
    // Two-byte / charset escapes.
    [`${ESC}(Bplain`, "plain"],
    // A progress bar rewritten in place resolves to its final state.
    [`10%${CR}50%${CR}100% done`, "100% done"],
    [`start${CR}\n10%${CR}99%\nend`, "start\n99%\nend"],
    // Remaining C0 controls go, tabs and newlines stay.
    [`a${NUL}b${BEL}c`, "abc"],
    ["plain text\twith tab\nsecond line", "plain text\twith tab\nsecond line"],
  ];

  const got = await stripSequences(
    page,
    table.map(([input]) => input),
  );
  expect(got).toEqual(table.map(([, expected]) => expected));
});

test("read mode: the prompt prefix is de-emphasised, never dropped", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });

  const result = await renderEntries(page, [
    { seq: 1, command: "user@host:~$ ls -la", output: "", exitCode: 0 },
    { seq: 2, command: "[me@box ~]% git status", output: "", exitCode: 0 },
    { seq: 3, command: "root@box:/# apt update", output: "", exitCode: 0 },
    { seq: 4, command: "❯ npm test", output: "", exitCode: 0 },
    { seq: 5, command: "➜  npm run build", output: "", exitCode: 0 },
    // `> ` is a redirection here, not a prompt: no sigil, no split.
    { seq: 6, command: "make > build.log", output: "", exitCode: 0 },
    { seq: 7, command: "echo hello", output: "", exitCode: 0 },
    // A redirection after a real prompt still splits at the prompt.
    {
      seq: 8,
      command: "user@host:~$ make > build.log",
      output: "",
      exitCode: 0,
    },
  ]);

  const splits = result.turns.map((t) => [t.promptText, t.commandText]);
  expect(splits).toEqual([
    ["user@host:~$ ", "ls -la"],
    ["[me@box ~]% ", "git status"],
    ["root@box:/# ", "apt update"],
    ["❯ ", "npm test"],
    ["➜ ", " npm run build"],
    [null, "make > build.log"],
    [null, "echo hello"],
    ["user@host:~$ ", "make > build.log"],
  ]);

  // Whichever way it splits, the whole prompt line survives on screen.
  for (const turn of result.turns) {
    expect(turn.cmdIsEmptyPlaceholder).toBe(false);
  }
  expect(result.turns.map((t) => t.cmdText)).toEqual([
    "user@host:~$ ls -la",
    "[me@box ~]% git status",
    "root@box:/# apt update",
    "❯ npm test",
    "➜  npm run build",
    "make > build.log",
    "echo hello",
    "user@host:~$ make > build.log",
  ]);
});

test("read mode: an unrecorded command keeps the dialogue structure", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });

  const result = await renderEntries(page, [
    { seq: 1, command: "", output: "orphan output\n", exitCode: 0 },
  ]);

  const [turn] = result.turns;
  expect(turn.cmdIsEmptyPlaceholder).toBe(true);
  expect(turn.cmdText).toBe("(command not recorded)");
  expect(turn.cmdVisible).toBe(true);
  // The output is still attributed to a turn, with its exit chip.
  expect(turn.firstLine).toBe("orphan output");
  expect(turn.exitText).toBe("✓");
});

test("read mode: a raw entry is one muted block with no exit chip", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });

  const result = await renderEntries(page, [
    { seq: 1, command: "a$ echo hi", output: "hi\n", exitCode: 0 },
    { seq: 2, raw: `${ESC}[33mstray bytes${ESC}[0m\n`, ts: 1 },
  ]);

  expect(result.turnCount).toBe(1);
  expect(result.raws.length).toBe(1);

  const [raw] = result.raws;
  expect(raw.seq).toBe("2");
  expect(raw.text).toBe("stray bytes\n");
  expect(raw.visible).toBe(true);
  expect(raw.hasExitChip).toBe(false);
  expect(raw.fontFamily).toContain("JetBrains Mono");
  expect(result.exitChipCount).toBe(1);
});

test("read mode: long and server-truncated output each declare what is missing", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });

  const result = await renderEntries(page, [
    {
      seq: 1,
      command: "a$ yes | head -500",
      output: manyLines(500),
      exitCode: 0,
    },
    {
      seq: 2,
      command: "a$ cat big.log",
      output: "tail of the log\n",
      exitCode: 0,
      outputTruncatedBytes: 40960,
    },
    {
      seq: 3,
      command: "a$ cat huge.log",
      output: manyLines(500),
      exitCode: 0,
      outputTruncatedBytes: 40960,
    },
  ]);

  const [clamped, serverTruncated, both] = result.turns;

  expect(clamped.lineCount).toBe(200);
  expect(clamped.firstLine).toBe("line 301");
  expect(clamped.lastLine).toBe("line 500");
  expect(clamped.clampMarker).toBe("… 300 earlier lines");
  expect(clamped.serverMarker).toBe(null);

  expect(serverTruncated.lineCount).toBe(1);
  expect(serverTruncated.clampMarker).toBe(null);
  expect(serverTruncated.serverMarker).toBe("… 40 KB dropped by the server");

  // Two different facts: both are reported, neither hides the other.
  expect(both.lineCount).toBe(200);
  expect(both.clampMarker).toBe("… 300 earlier lines");
  expect(both.serverMarker).toBe("… 40 KB dropped by the server");
});

test("read mode: an empty record explains itself and links to shell integration", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });

  const result = await renderEntries(page, []);

  expect(result.turnCount).toBe(0);
  expect(result.empty).not.toBe(null);
  expect(result.empty.visible).toBe(true);
  expect(result.empty.text).toBe(
    "Nothing recorded yet. Commands appear here as they finish.",
  );
  expect(result.empty.linkHref).toBe("/settings#shell-integration");
  expect(result.empty.linkVisible).toBe(true);
});

test("read mode: appendEntries adds turns without rebuilding the rendered ones", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });

  const result = await page.evaluate(async () => {
    const { createReadMode } = await import("/static/read-mode.js");

    const host = document.createElement("div");
    host.style.width = "360px";
    host.style.height = "480px";
    document.body.appendChild(host);

    const readMode = createReadMode({ host, session: "spec" });
    readMode.mount();
    readMode.setEntries([
      { seq: 1, command: "a$ one", output: "1\n", exitCode: 0 },
      { seq: 2, command: "a$ two", output: "2\n", exitCode: 0 },
    ]);

    const before = Array.from(host.querySelectorAll(".cv-turn"));
    before.forEach((el, i) => (el.dataset.marker = `keep-${i}`));

    readMode.appendEntries([
      { seq: 3, command: "a$ three", output: "3\n", exitCode: 1 },
    ]);

    const after = Array.from(host.querySelectorAll(".cv-turn"));
    const out = {
      seqs: after.map((el) => el.dataset.seq),
      markers: after.map((el) => el.dataset.marker ?? null),
      keptSameNodes: before.every((el, i) => el === after[i]),
      appendedExit: after[2]?.querySelector(".cv-exit")?.textContent ?? null,
    };

    readMode.dispose();
    host.remove();
    return out;
  });

  expect(result.seqs).toEqual(["1", "2", "3"]);
  expect(result.keptSameNodes).toBe(true);
  expect(result.markers).toEqual(["keep-0", "keep-1", null]);
  expect(result.appendedExit).toBe("✗ 1");
});

test("read mode: the first appended entry replaces the empty state", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });

  const result = await page.evaluate(async () => {
    const { createReadMode } = await import("/static/read-mode.js");

    const host = document.createElement("div");
    host.style.width = "360px";
    host.style.height = "480px";
    document.body.appendChild(host);

    const readMode = createReadMode({ host, session: "spec" });
    readMode.mount();

    const emptyBefore = !!host.querySelector(".cv-empty");
    readMode.appendEntries([
      { seq: 1, command: "a$ echo hi", output: "hi\n", exitCode: 0 },
    ]);

    const out = {
      emptyBefore,
      emptyAfter: !!host.querySelector(".cv-empty"),
      turnCount: host.querySelectorAll(".cv-turn").length,
    };

    readMode.dispose();
    host.remove();
    return out;
  });

  expect(result.emptyBefore).toBe(true);
  expect(result.emptyAfter).toBe(false);
  expect(result.turnCount).toBe(1);
});
