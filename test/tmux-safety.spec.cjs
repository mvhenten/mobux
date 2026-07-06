// Regression test for issue #183: a tmux invocation must never fall
// through to the host's default socket, and the child env must never
// carry TMUX/TMUX_PANE inherited from the calling shell (a real tmux pane,
// a CI runner attached to one, etc). See test/lib/tmux.cjs, which every
// tmux-touching spec routes through.
//
// No browser involved, so run on the xterm project only — the sterk
// project would just re-run the same assertions against no DOM.

const { test, expect } = require("@playwright/test");
const {
  createTmuxRunner,
  sanitizedEnv,
  assertIsolated,
} = require("./lib/tmux.cjs");

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "xterm", "renderer-independent");
});

test("sanitizedEnv strips TMUX and TMUX_PANE even when the parent has them set", () => {
  const env = sanitizedEnv({
    ...process.env,
    TMUX: "/tmp/tmux-1000/default,123,0",
    TMUX_PANE: "%0",
    FOO: "bar",
  });
  expect(env.TMUX).toBeUndefined();
  expect(env.TMUX_PANE).toBeUndefined();
  expect(env.FOO).toBe("bar");
});

test("assertIsolated refuses a command with no explicit test socket", () => {
  expect(() => assertIsolated("tmux", "kill-server")).toThrow(/tmux-safety/);
  expect(() => assertIsolated("tmux -L default", "kill-server")).toThrow(
    /tmux-safety/,
  );
  expect(() => assertIsolated("tmux", "new-session -d")).toThrow(/tmux-safety/);
});

test("assertIsolated allows an explicit -L socket or a delegated podman runner", () => {
  expect(() =>
    assertIsolated("tmux -L mobux-test", "kill-session -t foo"),
  ).not.toThrow();
  expect(() =>
    assertIsolated("podman exec mobux-podman tmux", "kill-server"),
  ).not.toThrow();
});

test("createTmuxRunner spawns tmux with TMUX/TMUX_PANE stripped from the child env even when the parent has them set", () => {
  const prevTmux = process.env.TMUX;
  const prevPane = process.env.TMUX_PANE;
  process.env.TMUX = "/tmp/tmux-1000/default,999,0";
  process.env.TMUX_PANE = "%0";

  let captured = null;
  const run = createTmuxRunner("mobux-tmux-safety-test", {
    exec: (command, options) => {
      captured = { command, options };
      return Buffer.from("");
    },
  });

  try {
    run("list-sessions");
  } finally {
    if (prevTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = prevTmux;
    if (prevPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = prevPane;
  }

  expect(captured.command).toBe("tmux -L mobux-tmux-safety-test list-sessions");
  expect(captured.options.env.TMUX).toBeUndefined();
  expect(captured.options.env.TMUX_PANE).toBeUndefined();
});

test("createTmuxRunner throws before spawning when a destructive command targets an unisolated override", () => {
  const prevOverride = process.env.MOBUX_TEST_TMUX;
  process.env.MOBUX_TEST_TMUX = "tmux"; // simulates a misconfigured override — no -L/-S

  let ran = false;
  const run = createTmuxRunner("irrelevant", {
    exec: () => {
      ran = true;
      return Buffer.from("");
    },
  });

  try {
    expect(() => run("kill-server")).toThrow(/tmux-safety/);
  } finally {
    if (prevOverride === undefined) delete process.env.MOBUX_TEST_TMUX;
    else process.env.MOBUX_TEST_TMUX = prevOverride;
  }
  expect(ran).toBe(false);
});
