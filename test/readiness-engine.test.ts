import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tmuxMocks = vi.hoisted(() => ({
  tmuxCapturePaneVisible: vi.fn(),
  tmuxPaneActiveProcessFromInspection: vi.fn(),
  tmuxPaneInspect: vi.fn(),
}));

vi.mock("../src/tmux.js", () => tmuxMocks);

import { ReadinessEngine } from "../src/readiness/engine.js";
import type { PtySummary } from "../src/types.js";

describe("ReadinessEngine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("enriches list responses from cache while starting background inspection", async () => {
    const summary: PtySummary = {
      id: "pty-1",
      name: "shell",
      backend: "tmux",
      tmuxSession: "agmux:@1",
      tmuxServer: "agmux",
      command: "tmux",
      args: [],
      cwd: "/tmp/project",
      createdAt: 1,
      status: "running",
    };
    const engine = new ReadinessEngine({
      ptys: {
        getSummary: () => summary,
        getPid: () => null,
        updateCwd: vi.fn(),
      },
      emitReadiness: vi.fn(),
    });

    const items = await engine.withActiveProcesses([summary]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "pty-1",
      cwd: "/tmp/project",
      ready: false,
      readyState: "unknown",
      readyIndicator: "unknown",
      readyReason: "startup",
    });
    expect(tmuxMocks.tmuxPaneInspect).toHaveBeenCalledTimes(1);
    expect(tmuxMocks.tmuxCapturePaneVisible).toHaveBeenCalledTimes(1);
  });
});
