import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tmuxMocks = vi.hoisted(() => ({
  tmuxCreateLinkedSession: vi.fn(),
  tmuxCreateWindow: vi.fn(),
  tmuxKillSession: vi.fn(),
  tmuxKillWindow: vi.fn(),
  tmuxListWindows: vi.fn(),
  tmuxPaneCurrentPath: vi.fn(),
  tmuxPruneDetachedLinkedSessions: vi.fn(),
  tmuxTargetSession: vi.fn((target: string) => target.split(":")[0] ?? target),
  tmuxEnsureSession: vi.fn(),
}));

vi.mock("../src/tmux.js", () => tmuxMocks);

import { createRuntime } from "../src/server/pty-runtime.js";

describe("runtime startup restore", () => {
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(0 as any);
    tmuxMocks.tmuxEnsureSession.mockResolvedValue(undefined);
    tmuxMocks.tmuxPruneDetachedLinkedSessions.mockResolvedValue([]);
    tmuxMocks.tmuxListWindows.mockResolvedValue([{ target: "agmux:1" }]);
    tmuxMocks.tmuxCreateLinkedSession.mockResolvedValue({
      linkedSession: "agmux_view_1",
      attachArgs: ["attach", "-t", "agmux:1"],
    });
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
  });

  it("reuses persisted session name and id when reattaching windows at startup", async () => {
    const persisted = {
      id: "pty_saved",
      name: "Pixel",
      backend: "tmux" as const,
      tmuxSession: "agmux:1",
      tmuxServer: "agmux" as const,
      command: "tmux",
      args: ["attach", "-t", "agmux:1"],
      cwd: "/tmp/project",
      createdAt: 123,
      lastSeenAt: 456,
      status: "running" as const,
      exitCode: null,
      exitSignal: null,
    };

    const store = {
      listSessions: vi.fn(() => [persisted]),
      upsertSession: vi.fn(),
      insertEvent: vi.fn(),
      clearTaskAssignment: vi.fn(),
      listActiveTaskAssignments: vi.fn(() => []),
    } as any;

    const runtime = createRuntime({
      store,
      logger: { info: vi.fn(), error: vi.fn() } as any,
      agentSessions: {
        persistRuntimeCwdForAgentPty: vi.fn(),
        attachedAgentSessionForPty: vi.fn(() => null),
        detachPty: vi.fn(),
      },
      readinessTraceMax: 100,
      readinessTraceLog: false,
      triggersPath: "/tmp/triggers.json",
      agmuxSession: "agmux",
      refreshWorktrees: vi.fn(),
    });

    const spawn = vi.fn((req: any) => ({
      id: req.id ?? "pty_new",
      name: req.name,
      backend: "tmux" as const,
      tmuxSession: req.tmuxSession ?? null,
      tmuxServer: req.tmuxServer ?? null,
      command: req.command,
      args: req.args ?? [],
      cwd: req.cwd ?? null,
      createdAt: req.createdAt ?? Date.now(),
      status: "running" as const,
    }));

    runtime.ptys.list = vi.fn(() => []) as any;
    runtime.ptys.spawn = spawn as any;
    runtime.ptys.kill = vi.fn(() => true) as any;

    await runtime.restoreAtStartup();

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      id: "pty_saved",
      name: "Pixel",
      tmuxSession: "agmux:1",
      cwd: "/tmp/project",
      createdAt: 123,
    }));
  });
});
