import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture every tmux invocation made through execFile.
const execState = vi.hoisted(() => ({
  calls: [] as string[],
  stdoutFor: (_args: string[]) => "",
}));

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = Object.assign(
    () => {
      throw new Error("callback-style execFile not expected in tests");
    },
    {
      [promisify.custom]: (cmd: string, args: string[]) => {
        execState.calls.push([cmd, ...args].join(" "));
        return Promise.resolve({ stdout: execState.stdoutFor(args), stderr: "" });
      },
    },
  );
  return { execFile };
});

import { tmuxCreateLinkedSession } from "../src/tmux.js";

describe("tmuxCreateLinkedSession", () => {
  beforeEach(() => {
    execState.calls.length = 0;
    execState.stdoutFor = () => "";
  });

  it("window target: builds a standalone session holding only the linked window", async () => {
    execState.stdoutFor = (args) => (args.includes("new-session") ? "@0\n" : "");

    const { linkedSession, attachArgs } = await tmuxCreateLinkedSession("agmux:@7");

    expect(linkedSession).toMatch(/^agmux_view_\d+$/);
    expect(attachArgs.join(" ")).toContain(`attach-session -t ${linkedSession}`);

    const newSession = execState.calls.find((c) => c.includes("new-session"));
    // Not a grouped session: grouped views shared all windows, so a window
    // dying from the inside made the view drift to a neighboring window.
    expect(newSession).toBeDefined();
    expect(newSession).not.toContain(`-t agmux`);

    const idx = (needle: string) => execState.calls.findIndex((c) => c.includes(needle));
    const linkIdx = idx(`link-window -a -s agmux:@7 -t ${linkedSession}`);
    const killIdx = idx(`kill-window -t ${linkedSession}:@0`);
    expect(linkIdx).toBeGreaterThan(-1);
    expect(killIdx).toBeGreaterThan(linkIdx);

    // No pin hook needed: the session has exactly one window.
    expect(execState.calls.some((c) => c.includes("set-hook"))).toBe(false);
  });

  it("session target: keeps the grouped session sharing all windows", async () => {
    const { linkedSession } = await tmuxCreateLinkedSession("agmux");

    const newSession = execState.calls.find((c) => c.includes("new-session"));
    expect(newSession).toContain(`-s ${linkedSession} -t agmux`);
    expect(execState.calls.some((c) => c.includes("link-window"))).toBe(false);
    expect(execState.calls.some((c) => c.includes("kill-window"))).toBe(false);
  });
});
