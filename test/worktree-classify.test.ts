import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import {
  classifyWorktree,
  hashStatusOutput,
  parseForEachRefLine,
  parseWorktreeListPorcelainV2,
  summarizeStatusV2,
  type ClassifyInput,
  type PorcelainWorktree,
  type StatusSummary,
} from "../src/worktree-classify.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 7); // 2026-07-07

describe("parseWorktreeListPorcelainV2", () => {
  test("parses main + linked worktrees with head and branch", () => {
    const output = [
      "worktree /home/user/repo",
      "HEAD aaa111",
      "branch refs/heads/main",
      "",
      "worktree /home/user/wt/feature-auth",
      "HEAD bbb222",
      "branch refs/heads/feature/auth",
      "",
    ].join("\n");
    expect(parseWorktreeListPorcelainV2(output)).toEqual([
      { path: "/home/user/repo", head: "aaa111", branch: "main", detached: false, locked: false, prunable: false },
      {
        path: "/home/user/wt/feature-auth",
        head: "bbb222",
        branch: "feature/auth",
        detached: false,
        locked: false,
        prunable: false,
      },
    ]);
  });

  test("parses detached entry with empty branch", () => {
    const output = ["worktree /home/user/wt/pr-42", "HEAD ccc333", "detached", ""].join("\n");
    expect(parseWorktreeListPorcelainV2(output)).toEqual([
      { path: "/home/user/wt/pr-42", head: "ccc333", branch: "", detached: true, locked: false, prunable: false },
    ]);
  });

  test("parses locked with and without reason", () => {
    const output = [
      "worktree /home/user/wt/a",
      "HEAD aaa",
      "branch refs/heads/a",
      "locked",
      "",
      "worktree /home/user/wt/b",
      "HEAD bbb",
      "branch refs/heads/b",
      "locked reason with spaces",
      "",
    ].join("\n");
    const entries = parseWorktreeListPorcelainV2(output);
    expect(entries.map((e) => e.locked)).toEqual([true, true]);
    expect(entries.map((e) => e.prunable)).toEqual([false, false]);
  });

  test("parses prunable with reason", () => {
    const output = [
      "worktree /home/user/wt/gone",
      "HEAD ddd444",
      "branch refs/heads/gone",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");
    expect(parseWorktreeListPorcelainV2(output)[0].prunable).toBe(true);
  });

  test("parses bare entry (no HEAD, no branch)", () => {
    const output = ["worktree /home/user/repo.git", "bare", "", "worktree /home/user/checkout", "HEAD eee555", "branch refs/heads/main", ""].join(
      "\n",
    );
    expect(parseWorktreeListPorcelainV2(output)).toEqual([
      { path: "/home/user/repo.git", head: null, branch: "", detached: false, locked: false, prunable: false },
      { path: "/home/user/checkout", head: "eee555", branch: "main", detached: false, locked: false, prunable: false },
    ]);
  });

  test("missing branch line yields empty branch", () => {
    const output = ["worktree /home/user/wt/x", "HEAD fff666"].join("\n");
    expect(parseWorktreeListPorcelainV2(output)[0].branch).toBe("");
  });

  test("handles empty output and no trailing newline", () => {
    expect(parseWorktreeListPorcelainV2("")).toEqual([]);
    const output = ["worktree /home/user/repo", "HEAD aaa", "branch refs/heads/main"].join("\n");
    expect(parseWorktreeListPorcelainV2(output)).toHaveLength(1);
  });
});

describe("summarizeStatusV2", () => {
  test("clean tree: not dirty and not ignoredOnly", () => {
    const s = summarizeStatusV2("");
    expect(s.dirty).toBe(false);
    expect(s.ignoredOnly).toBe(false);
    expect(s.changedCount).toBe(0);
    expect(s.sample).toEqual([]);
  });

  test("ignored-only tree: not dirty, ignoredOnly true", () => {
    const s = summarizeStatusV2(["! .venv/", "! node_modules/", ""].join("\n"));
    expect(s.dirty).toBe(false);
    expect(s.ignoredOnly).toBe(true);
    expect(s.changedCount).toBe(0);
  });

  test("untracked counts as non-ignored dirt", () => {
    const s = summarizeStatusV2(["? notes.txt", "! .venv/", ""].join("\n"));
    expect(s.dirty).toBe(true);
    expect(s.ignoredOnly).toBe(false);
    expect(s.changedCount).toBe(1);
    expect(s.sample).toEqual(["notes.txt"]);
  });

  test("mixed entries: 1/2/u/? all counted, paths extracted, headers skipped", () => {
    const raw = [
      "# branch.oid aaa111",
      "# branch.head feature-x",
      "1 .M N... 100644 100644 100644 abc def src/app.ts",
      "2 R. N... 100644 100644 100644 abc def R100 new name.ts\told name.ts",
      "u UU N... 100644 100644 100644 100644 a1 b2 c3 conflict.ts",
      "? untracked file.txt",
      "! ignored.log",
      "",
    ].join("\n");
    const s = summarizeStatusV2(raw);
    expect(s.dirty).toBe(true);
    expect(s.ignoredOnly).toBe(false);
    expect(s.changedCount).toBe(4);
    expect(s.sample).toEqual(["src/app.ts", "new name.ts", "conflict.ts", "untracked file.txt"]);
  });

  test("sample is capped at 5 entries", () => {
    const raw = Array.from({ length: 8 }, (_, i) => `? file-${i}.txt`).join("\n");
    const s = summarizeStatusV2(raw);
    expect(s.changedCount).toBe(8);
    expect(s.sample).toHaveLength(5);
  });

  test("statusHash is sha1 of the raw output", () => {
    const raw = "? a.txt\n";
    const expected = createHash("sha1").update(raw).digest("hex");
    expect(summarizeStatusV2(raw).statusHash).toBe(expected);
    expect(hashStatusOutput(raw)).toBe(expected);
  });
});

describe("parseForEachRefLine", () => {
  test("parses branch with live upstream", () => {
    expect(parseForEachRefLine("feature-x\torigin/feature-x\t[ahead 2]\t1750000000\taaa111")).toEqual({
      branch: "feature-x",
      upstream: "origin/feature-x",
      upstreamGone: false,
      lastCommitAt: 1750000000 * 1000,
      head: "aaa111",
    });
  });

  test("detects gone upstream", () => {
    const ref = parseForEachRefLine("done\torigin/done\t[gone]\t1750000000\tbbb222");
    expect(ref?.upstreamGone).toBe(true);
  });

  test("no upstream yields null upstream and gone false", () => {
    const ref = parseForEachRefLine("local-branch\t\t\t1750000000\tccc333");
    expect(ref?.upstream).toBeNull();
    expect(ref?.upstreamGone).toBe(false);
  });

  test("missing date yields null lastCommitAt", () => {
    const ref = parseForEachRefLine("b\torigin/b\t\t\tddd444");
    expect(ref?.lastCommitAt).toBeNull();
  });

  test("malformed lines return null", () => {
    expect(parseForEachRefLine("")).toBeNull();
    expect(parseForEachRefLine("just-a-branch")).toBeNull();
    expect(parseForEachRefLine("a\tb\tc\td")).toBeNull();
  });
});

// --- classify fixtures ---

const CLEAN: StatusSummary = { dirty: false, ignoredOnly: false, changedCount: 0, sample: [], statusHash: "h0" };
const DIRTY: StatusSummary = {
  dirty: true,
  ignoredOnly: false,
  changedCount: 3,
  sample: ["a.ts", "b.ts", "c.ts"],
  statusHash: "h3",
};

function makeWt(overrides: Partial<PorcelainWorktree> = {}): PorcelainWorktree {
  return {
    path: "/home/user/wt/feature-x",
    head: "aaa111",
    branch: "feature-x",
    detached: false,
    locked: false,
    prunable: false,
    ...overrides,
  };
}

function makeInput(overrides: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    wt: makeWt(),
    ref: {
      branch: "feature-x",
      upstream: "origin/feature-x",
      upstreamGone: false,
      lastCommitAt: NOW - 30 * DAY_MS,
      head: "aaa111",
    },
    status: CLEAN,
    isPrimary: false,
    liveSessionCount: 0,
    lastSessionActivityAt: null,
    neverPushed: false,
    hasUnmergedCommits: false,
    ancestryMerged: false,
    prStatus: null,
    prId: null,
    prCompletedAt: null,
    mergeSourceSha: null,
    unpushedCount: 0,
    ignoredBytes: null,
    templatePath: null,
    now: NOW,
    ...overrides,
  };
}

describe("classifyWorktree states", () => {
  test("ephemeral: .claude/worktrees path wins over everything", () => {
    const r = classifyWorktree(
      makeInput({
        wt: makeWt({ path: "/home/user/repo/.claude/worktrees/quick-fix" }),
        prStatus: "completed", // would otherwise classify merged
      }),
    );
    expect(r.state).toBe("ephemeral");
    expect(r.reapClass).toBeNull();
  });

  test("primary: active when recently active, never reapable", () => {
    const r = classifyWorktree(
      makeInput({
        wt: makeWt({ path: "/home/user/repo", branch: "main" }),
        ref: { branch: "main", upstream: "origin/main", upstreamGone: false, lastCommitAt: NOW - DAY_MS, head: "aaa111" },
        isPrimary: true,
      }),
    );
    expect(r.state).toBe("active");
    expect(r.reapClass).toBeNull();
    expect(r.evidence).toBe("primary worktree");
  });

  test("primary guard: reapClass stays null even with merged signals", () => {
    const r = classifyWorktree(
      makeInput({
        isPrimary: true,
        prStatus: "completed",
        ref: { branch: "main", upstream: "origin/main", upstreamGone: true, lastCommitAt: NOW - 30 * DAY_MS, head: "aaa111" },
      }),
    );
    expect(r.state).toBe("open"); // idle primary
    expect(r.reapClass).toBeNull();
    expect(r.evidence).toBe("primary worktree");
  });

  test("review: detached pr-N checkout with open PR is not reapable", () => {
    const r = classifyWorktree(
      makeInput({
        wt: makeWt({ path: "/home/user/wt/pr-4812", branch: "", detached: true }),
        ref: null,
        prStatus: "active",
      }),
    );
    expect(r.state).toBe("review");
    expect(r.reapClass).toBeNull();
    expect(r.evidence).toContain("pr-4812");
  });

  test("review: closed PR + clean is reap-safe", () => {
    const r = classifyWorktree(
      makeInput({
        wt: makeWt({ path: "/home/user/wt/pr-4812", branch: "", detached: true }),
        ref: null,
        prStatus: "completed",
      }),
    );
    expect(r.state).toBe("review");
    expect(r.reapClass).toBe("reap-safe");
    expect(r.evidence).toContain("review checkout, PR closed");
    expect(r.evidence).toContain("clean");
  });

  test("review: closed PR + dirty demotes to reap-check", () => {
    const r = classifyWorktree(
      makeInput({
        wt: makeWt({ path: "/home/user/wt/pr-99-fix", branch: "", detached: true }),
        ref: null,
        prStatus: "abandoned",
        status: DIRTY,
      }),
    );
    expect(r.state).toBe("review");
    expect(r.reapClass).toBe("reap-check");
    expect(r.evidence).toContain("3 changed files");
  });

  test("detached non-pr checkout is unknown", () => {
    const r = classifyWorktree(
      makeInput({ wt: makeWt({ path: "/home/user/wt/bisect-here", branch: "", detached: true }), ref: null }),
    );
    expect(r.state).toBe("unknown");
    expect(r.reapClass).toBeNull();
    expect(r.evidence).toBe("detached HEAD");
  });

  test("active: live session with old commits", () => {
    const r = classifyWorktree(makeInput({ liveSessionCount: 2 }));
    expect(r.state).toBe("active");
    expect(r.reapClass).toBeNull();
    expect(r.evidence).toContain("2 live sessions");
  });

  test("active: session activity within 7 days", () => {
    const r = classifyWorktree(makeInput({ lastSessionActivityAt: NOW - 2 * DAY_MS }));
    expect(r.state).toBe("active");
    expect(r.evidence).toContain("session activity 2026-07-05");
  });

  test("active threshold: just under 7 days is active, exactly 7 days is not", () => {
    const under = classifyWorktree(
      makeInput({ ref: { branch: "feature-x", upstream: null, upstreamGone: false, lastCommitAt: NOW - 7 * DAY_MS + 1, head: "aaa111" } }),
    );
    expect(under.state).toBe("active");
    const at = classifyWorktree(
      makeInput({ ref: { branch: "feature-x", upstream: null, upstreamGone: false, lastCommitAt: NOW - 7 * DAY_MS, head: "aaa111" } }),
    );
    expect(at.state).not.toBe("active");
  });

  test("merged wins over active when PR completed, live session demotes to reap-check", () => {
    const r = classifyWorktree(
      makeInput({
        liveSessionCount: 1,
        prStatus: "completed",
        prId: "4812",
        prCompletedAt: Date.UTC(2026, 5, 3),
        mergeSourceSha: "aaa111",
      }),
    );
    expect(r.state).toBe("merged");
    expect(r.reapClass).toBe("reap-check");
    expect(r.evidence).toContain("1 live session");
  });

  test("merged wins over active when upstream gone", () => {
    const r = classifyWorktree(
      makeInput({
        ref: { branch: "feature-x", upstream: "origin/feature-x", upstreamGone: true, lastCommitAt: NOW - DAY_MS, head: "aaa111" },
        mergeSourceSha: "aaa111",
        prStatus: "completed",
      }),
    );
    expect(r.state).toBe("merged");
  });

  test("ancestry-merge alone does NOT override recent activity", () => {
    const r = classifyWorktree(
      makeInput({
        ancestryMerged: true,
        ref: { branch: "feature-x", upstream: "origin/feature-x", upstreamGone: false, lastCommitAt: NOW - DAY_MS, head: "aaa111" },
      }),
    );
    expect(r.state).toBe("active");
  });

  test("merged reap-safe: completed PR, tip matches, clean — exact evidence", () => {
    const r = classifyWorktree(
      makeInput({
        prStatus: "completed",
        prId: "4812",
        prCompletedAt: Date.UTC(2026, 5, 3),
        mergeSourceSha: "aaa111",
        ref: { branch: "feature-x", upstream: "origin/feature-x", upstreamGone: true, lastCommitAt: NOW - 30 * DAY_MS, head: "aaa111" },
      }),
    );
    expect(r.state).toBe("merged");
    expect(r.reapClass).toBe("reap-safe");
    expect(r.evidence).toBe("PR !4812 completed 2026-06-03 · tip matches merge-source · clean");
  });

  test("merged via ancestry alone is reap-safe when clean", () => {
    const r = classifyWorktree(makeInput({ ancestryMerged: true }));
    expect(r.state).toBe("merged");
    expect(r.reapClass).toBe("reap-safe");
    expect(r.evidence).toContain("merged into default branch (ancestry)");
  });

  test("demotion: dirty", () => {
    const r = classifyWorktree(
      makeInput({ prStatus: "completed", mergeSourceSha: "aaa111", status: DIRTY }),
    );
    expect(r.state).toBe("merged");
    expect(r.reapClass).toBe("reap-check");
    expect(r.evidence).toContain("3 changed files");
  });

  test("demotion: tip ahead of merge source", () => {
    const r = classifyWorktree(makeInput({ prStatus: "completed", mergeSourceSha: "old000" }));
    expect(r.reapClass).toBe("reap-check");
    expect(r.evidence).toContain("tip differs from merged commit");
  });

  test("demotion: >= 500M gitignored data", () => {
    const r = classifyWorktree(
      makeInput({ prStatus: "completed", mergeSourceSha: "aaa111", ignoredBytes: 700 * 1024 * 1024 }),
    );
    expect(r.reapClass).toBe("reap-check");
    expect(r.evidence).toContain("0.7 GB gitignored data will be destroyed (not salvageable)");
  });

  test("just under 500M gitignored data stays reap-safe", () => {
    const r = classifyWorktree(
      makeInput({ prStatus: "completed", mergeSourceSha: "aaa111", ignoredBytes: 499 * 1024 * 1024 }),
    );
    expect(r.reapClass).toBe("reap-safe");
  });

  test("demotion: abandoned PR is merged-class but always reap-check", () => {
    const r = classifyWorktree(makeInput({ prStatus: "abandoned", prId: "77" }));
    expect(r.state).toBe("merged");
    expect(r.reapClass).toBe("reap-check");
    expect(r.evidence).toContain("PR !77 abandoned (never merged)");
  });

  test("demotion: upstream gone without PR record or ancestry — merge unproven", () => {
    const r = classifyWorktree(
      makeInput({
        ref: { branch: "feature-x", upstream: "origin/feature-x", upstreamGone: true, lastCommitAt: NOW - 30 * DAY_MS, head: "aaa111" },
      }),
    );
    expect(r.state).toBe("merged");
    expect(r.reapClass).toBe("reap-check");
    expect(r.evidence).toBe("upstream gone · merge unproven (no PR record) · clean");
  });

  test("upstream gone backed by ancestry is proven and reap-safe", () => {
    const r = classifyWorktree(
      makeInput({
        ancestryMerged: true,
        ref: { branch: "feature-x", upstream: "origin/feature-x", upstreamGone: true, lastCommitAt: NOW - 30 * DAY_MS, head: "aaa111" },
      }),
    );
    expect(r.reapClass).toBe("reap-safe");
  });

  test("demotion: live session on a merged branch", () => {
    const r = classifyWorktree(
      makeInput({ prStatus: "completed", mergeSourceSha: "aaa111", liveSessionCount: 1 }),
    );
    expect(r.reapClass).toBe("reap-check");
    expect(r.evidence).toContain("1 live session");
  });

  test("local-only: never pushed with unmerged commits, never reapable", () => {
    const r = classifyWorktree(
      makeInput({
        ref: { branch: "feature-x", upstream: null, upstreamGone: false, lastCommitAt: NOW - 30 * DAY_MS, head: "aaa111" },
        neverPushed: true,
        hasUnmergedCommits: true,
        unpushedCount: 3,
      }),
    );
    expect(r.state).toBe("local-only");
    expect(r.reapClass).toBeNull();
    expect(r.evidence).toBe("never pushed · 3 local commits");
  });

  test("open: active PR", () => {
    const r = classifyWorktree(makeInput({ prStatus: "active", prId: "4900" }));
    expect(r.state).toBe("open");
    expect(r.reapClass).toBeNull();
    expect(r.evidence).toBe("PR !4900 active");
  });

  test("open: upstream alive with unmerged commits", () => {
    const r = classifyWorktree(makeInput({ hasUnmergedCommits: true, unpushedCount: 2 }));
    expect(r.state).toBe("open");
    expect(r.evidence).toBe("upstream alive · 2 unpushed commits");
  });

  test("stale threshold: exactly 14 days idle is stale, 13 days is unknown", () => {
    const stale = classifyWorktree(
      makeInput({
        ref: { branch: "feature-x", upstream: null, upstreamGone: false, lastCommitAt: NOW - 14 * DAY_MS, head: "aaa111" },
        neverPushed: true,
      }),
    );
    expect(stale.state).toBe("stale");
    expect(stale.reapClass).toBeNull();
    expect(stale.evidence).toBe("idle 14 days · last activity 2026-06-23");

    const between = classifyWorktree(
      makeInput({
        ref: { branch: "feature-x", upstream: null, upstreamGone: false, lastCommitAt: NOW - 13 * DAY_MS, head: "aaa111" },
        neverPushed: true,
      }),
    );
    expect(between.state).toBe("unknown");
    expect(between.evidence).toBe("idle 13 days");
  });

  test("unknown: no activity data at all", () => {
    const r = classifyWorktree(makeInput({ ref: null, status: null, neverPushed: true }));
    expect(r.state).toBe("unknown");
    expect(r.evidence).toBe("no recorded activity");
  });
});

describe("classifyWorktree overlays", () => {
  test("drifted when basename does not match sanitized branch", () => {
    const drifted = classifyWorktree(
      makeInput({ wt: makeWt({ path: "/home/user/wt/other-name", branch: "feature/x" }) }),
    );
    expect(drifted.overlays.drifted).toBe(true);
    const matching = classifyWorktree(
      makeInput({ wt: makeWt({ path: "/home/user/wt/feature-x", branch: "feature/x" }) }),
    );
    expect(matching.overlays.drifted).toBe(false);
  });

  test("primary worktree is never drifted", () => {
    const r = classifyWorktree(
      makeInput({ wt: makeWt({ path: "/home/user/repo", branch: "main" }), isPrimary: true }),
    );
    expect(r.overlays.drifted).toBe(false);
  });

  test("offConvention when resolved path differs from template path", () => {
    const off = classifyWorktree(makeInput({ templatePath: "/home/user/repo-feature-x" }));
    expect(off.overlays.offConvention).toBe(true);
    const on = classifyWorktree(makeInput({ templatePath: "/home/user/wt/feature-x" }));
    expect(on.overlays.offConvention).toBe(false);
    const unknownTemplate = classifyWorktree(makeInput({ templatePath: null }));
    expect(unknownTemplate.overlays.offConvention).toBe(false);
  });

  test("passes through git and status flags", () => {
    const r = classifyWorktree(
      makeInput({
        wt: makeWt({ locked: true, prunable: true }),
        status: { ...CLEAN, ignoredOnly: true },
        ref: { branch: "feature-x", upstream: "origin/feature-x", upstreamGone: true, lastCommitAt: null, head: "aaa111" },
        neverPushed: false,
        unpushedCount: 4,
      }),
    );
    expect(r.overlays).toMatchObject({
      locked: true,
      prunable: true,
      ignoredOnly: true,
      dirty: false,
      upstreamGone: true,
      neverPushed: false,
      unpushedCount: 4,
    });
  });

  test("null status yields dirty=false, ignoredOnly=false", () => {
    const r = classifyWorktree(makeInput({ status: null }));
    expect(r.overlays.dirty).toBe(false);
    expect(r.overlays.ignoredOnly).toBe(false);
  });
});
