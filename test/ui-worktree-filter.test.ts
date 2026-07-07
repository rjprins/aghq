import { describe, expect, test } from "vitest";
import { rowMatchesFilter } from "../src/ui/worktree-filter.js";
import type { WorktreeAnnotated } from "../src/shared/worktrees.js";

function row(partial: Partial<WorktreeAnnotated>): WorktreeAnnotated {
  return {
    name: "feature-a",
    path: "/tmp/repo/.worktrees/feature-a",
    branch: "feature-a",
    head: "abc123",
    detached: false,
    isPrimary: false,
    state: "open",
    reapClass: null,
    evidence: "",
    statusHash: null,
    overlays: {
      dirty: false,
      ignoredOnly: false,
      unpushedCount: null,
      drifted: false,
      offConvention: false,
      locked: false,
      prunable: false,
      upstreamGone: false,
      neverPushed: false,
    },
    lastActivityAt: null,
    lastCommitAt: null,
    label: null,
    ticketId: null,
    prId: null,
    prTitle: null,
    prStatus: null,
    firstPrompt: null,
    origin: null,
    stack: null,
    diskBytes: null,
    ignoredBytes: null,
    sessionCount: 0,
    liveSessionCount: 0,
    ...partial,
  };
}

describe("rowMatchesFilter", () => {
  test("empty query matches everything", () => {
    expect(rowMatchesFilter(row({}), "")).toBe(true);
  });

  test("matches branch, label, PR title, and path case-insensitively", () => {
    expect(rowMatchesFilter(row({ branch: "Feature-Login" }), "login")).toBe(true);
    expect(rowMatchesFilter(row({ label: "Auth rework" }), "auth")).toBe(true);
    expect(rowMatchesFilter(row({ prTitle: "Fix OAuth flow" }), "oauth")).toBe(true);
    expect(rowMatchesFilter(row({ path: "/tmp/repo/.worktrees/spike-x" }), "spike-x")).toBe(true);
  });

  test("rejects rows without a match", () => {
    expect(rowMatchesFilter(row({}), "nomatch")).toBe(false);
  });

  test("ignores null fields", () => {
    expect(rowMatchesFilter(row({ label: null, prTitle: null }), "feature-a")).toBe(true);
  });
});
