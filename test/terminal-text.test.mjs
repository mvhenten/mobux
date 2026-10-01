// terminal-text.js on its own: how display rows read back as words, URLs and
// copied text for emoji, CJK and wrapped lines. The web/static modules are
// browser ES modules in a CommonJS package, so the test bundles the module
// with esbuild and imports the bundle.
//
// Run with: make test-node

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(
  new URL("../web/static/terminal-text.js", import.meta.url),
);
const { outputFiles } = buildSync({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  write: false,
});
const {
  displayLength,
  linkCells,
  rowsFromBottom,
  textBetween,
  urlAt,
  wordAt,
} =
  await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
  );

const cell = (chars, width) => ({
  getChars: () => chars,
  getWidth: () => width,
  isBgDefault: () => true,
  isInverse: () => false,
  isUnderline: () => false,
  isStrikethrough: () => false,
});

const isWide = (ch) => ch.codePointAt(0) >= 0x1100;

// A buffer row the way xterm holds it: a wide character is a width-2 cell
// and a width-0 cell, an empty cell is "" of width 1.
function bufferRow(text, cols, wrapped = false) {
  const cells = [];
  for (const ch of text) {
    if (isWide(ch)) cells.push(cell(ch, 2), cell("", 0));
    else cells.push(cell(ch, 1));
  }
  while (cells.length < cols) cells.push(cell("", 1));
  return { length: cols, isWrapped: wrapped, getCell: (x) => cells[x] };
}

function fakeBuffer({ cols, screen, history = [] }) {
  const rows = screen.map(([text, wrapped]) => bufferRow(text, cols, wrapped));
  const historyRows = history.map((text) => bufferRow(text, text.length * 2));
  return {
    cols,
    rows: rows.length,
    viewportRows: () => rows,
    scrollbackRows: () => [],
    screenScrollbackCount: () => 0,
    historyRowCount: () => historyRows.length,
    historyRow: (i) => historyRows[i],
    historyStart: () => 0,
    historyEpoch: () => 0,
    lastLineRevision: () => 0,
    straddles: () => false,
  };
}

const screenRows = (cols, screen) =>
  rowsFromBottom(fakeBuffer({ cols, screen }), screen.length);

test("an emoji keeps the columns after it on their own characters", () => {
  const rows = screenRows(20, [["🚀 hello"], ["🚀 https://a.b/c x"]]);

  const word = wordAt(rows, 0, 3);
  assert.deepEqual(word, {
    start: { row: 0, col: 3 },
    end: { row: 0, col: 7 },
  });
  assert.equal(textBetween(rows, word.start, word.end), "hello");

  assert.equal(urlAt(rows, 1, 5), "https://a.b/c");
  assert.equal(urlAt(rows, 1, 16), null);
  assert.equal(wordAt(rows, 1, 17).start.col, 17);
});

test("a CJK word selects whole, from either column of a character", () => {
  const rows = screenRows(20, [["漢字 abc"]]);

  const word = wordAt(rows, 0, 1);
  assert.deepEqual(word, {
    start: { row: 0, col: 0 },
    end: { row: 0, col: 3 },
  });
  assert.equal(textBetween(rows, word.start, word.end), "漢字");
});

test("a word wrapped over two rows copies without a break", () => {
  const rows = screenRows(5, [["hello"], ["world", true], ["next "]]);

  const word = wordAt(rows, 1, 2);
  assert.deepEqual(word, {
    start: { row: 0, col: 0 },
    end: { row: 1, col: 4 },
  });
  assert.equal(textBetween(rows, word.start, word.end), "helloworld");
  assert.equal(
    textBetween(rows, { row: 0, col: 0 }, { row: 2, col: 4 }),
    "helloworld\nnext",
  );
});

test("a CJK word wrapped past a wide character's gap copies without a space", () => {
  const rows = screenRows(5, [["abcd"], ["漢字", true]]);

  assert.equal(rows[0].cells[4], "");
  const word = wordAt(rows, 1, 0);
  assert.deepEqual(word, {
    start: { row: 0, col: 0 },
    end: { row: 1, col: 3 },
  });
  assert.equal(textBetween(rows, word.start, word.end), "abcd漢字");
});

test("history lines count as the rows they are cut into", () => {
  const buffer = fakeBuffer({
    cols: 4,
    screen: [["$"], [""]],
    history: ["0123456789"],
  });

  assert.equal(displayLength(buffer), 5);
  const rows = rowsFromBottom(buffer, 5);
  assert.equal(
    textBetween(rows, { row: 0, col: 0 }, { row: 2, col: 3 }),
    "0123456789",
  );
});

test("a URL wrapped over two rows links its cells on both rows", () => {
  const rows = screenRows(10, [["go https:/"], ["/a.b/c. x", true]]);

  const links = linkCells(rows);
  assert.deepEqual(
    links[0].map((href) => !!href),
    [false, false, false, true, true, true, true, true, true, true],
  );
  assert.equal(links[0][3], "https://a.b/c");
  assert.equal(links[1][5], "https://a.b/c");
  assert.equal(links[1][6], null);
  assert.equal(links[1][8], null);
});

test("an emoji before a URL keeps the link on the columns the URL is drawn in", () => {
  const rows = screenRows(20, [["🚀 https://a.b/c x"]]);

  const links = linkCells(rows)[0];
  assert.equal(links[2], null);
  assert.equal(links[3], "https://a.b/c");
  assert.equal(links[15], "https://a.b/c");
  assert.equal(links[16], null);
});
