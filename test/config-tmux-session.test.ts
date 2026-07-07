import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = process.env.AGMUX_TMUX_SESSION;

describe("AGMUX_SESSION inheritance", () => {
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.AGMUX_TMUX_SESSION;
    else process.env.AGMUX_TMUX_SESSION = ORIGINAL;
    vi.resetModules();
  });

  it("ignores inherited window targets containing ':'", async () => {
    // Launched from inside an agmux pane the env holds "session:@window",
    // which is not a valid tmux session name.
    process.env.AGMUX_TMUX_SESSION = "agmux-4821:@31";
    vi.resetModules();
    const config = await import("../src/server/config.js");
    expect(config.AGMUX_SESSION).toBe(`agmux-${config.PORT}`);
  });

  it("keeps a plain inherited session name", async () => {
    process.env.AGMUX_TMUX_SESSION = "my-session";
    vi.resetModules();
    const config = await import("../src/server/config.js");
    expect(config.AGMUX_SESSION).toBe("my-session");
  });
});
