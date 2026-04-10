import { describe, expect, test } from "vitest";
import type { PtySummary } from "../src/shared/protocol.js";
import {
  compareSidebarGroupKeys,
  findNextReadyRunningPty,
  findRunningPtyByOffset,
  orderRunningPtysForSidebar,
} from "../src/ui/pty-order.js";

function pty(id: string, cwd: string | null, createdAt: number, status: "running" | "exited" = "running"): PtySummary {
  return {
    id,
    name: `pty-${id}`,
    backend: "tmux",
    command: "bash",
    args: [],
    cwd,
    createdAt,
    status,
  };
}

describe("compareSidebarGroupKeys", () => {
  test("sorts by basename and keeps empty keys last", () => {
    expect([...["", "/tmp/zeta", "/tmp/alpha"]].sort(compareSidebarGroupKeys)).toEqual([
      "/tmp/alpha",
      "/tmp/zeta",
      "",
    ]);
  });
});

describe("orderRunningPtysForSidebar", () => {
  test("orders running PTYs by pinned groups first, then sidebar group order", () => {
    const ptys = [
      pty("z-2", "/repos/zeta", 40),
      pty("a-2", "/repos/alpha", 30),
      pty("z-1", "/repos/zeta", 20),
      pty("b-1", "/repos/beta", 10),
    ];

    const ordered = orderRunningPtysForSidebar(ptys, {
      pinnedDirectories: new Set(["/repos/zeta"]),
      getGroupKey: (item) => item.cwd ?? "",
    });

    expect(ordered.map((item) => item.id)).toEqual(["z-2", "z-1", "a-2", "b-1"]);
  });

  test("ignores exited PTYs", () => {
    const ptys = [
      pty("beta", "/repos/beta", 20),
      pty("alpha-exited", "/repos/alpha", 15, "exited"),
      pty("alpha", "/repos/alpha", 10),
    ];

    const ordered = orderRunningPtysForSidebar(ptys, {
      pinnedDirectories: new Set<string>(),
      getGroupKey: (item) => item.cwd ?? "",
    });

    expect(ordered.map((item) => item.id)).toEqual(["alpha", "beta"]);
  });
});

describe("findRunningPtyByOffset", () => {
  test("skips hidden sessions while preserving the current sidebar order", () => {
    const ordered = [
      pty("alpha-1", "/repos/alpha", 30),
      pty("alpha-2", "/repos/alpha", 20),
      pty("beta-1", "/repos/beta", 10),
    ];

    const next = findRunningPtyByOffset(ordered, "beta-1", 1, {
      isVisible: (item) => item.cwd !== "/repos/alpha",
    });

    expect(next?.id).toBe("beta-1");
  });

  test("advances from a hidden active session to the next visible session", () => {
    const ordered = [
      pty("alpha-1", "/repos/alpha", 40),
      pty("beta-1", "/repos/beta", 30),
      pty("gamma-1", "/repos/gamma", 20),
    ];

    const next = findRunningPtyByOffset(ordered, "alpha-1", 1, {
      isVisible: (item) => item.cwd !== "/repos/alpha",
    });

    expect(next?.id).toBe("beta-1");
  });
});

describe("findNextReadyRunningPty", () => {
  test("ignores hidden ready sessions when cycling to the next ready PTY", () => {
    const ordered = [
      pty("alpha-ready", "/repos/alpha", 30),
      pty("beta-ready", "/repos/beta", 20),
      pty("gamma-busy", "/repos/gamma", 10),
    ];

    const next = findNextReadyRunningPty(ordered, "gamma-busy", {
      isReady: (item) => item.id.endsWith("ready"),
      isVisible: (item) => item.cwd !== "/repos/alpha",
    });

    expect(next?.id).toBe("beta-ready");
  });
});
