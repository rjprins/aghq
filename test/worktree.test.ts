import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseWorktreeListPorcelain,
  resolveWorktreePath,
  worktreeFromCwd,
  projectRootFromCwd,
  branchAtCwd,
  branchForPathInRepo,
  _resetCacheForTesting,
  _setCacheForTesting,
  _setBranchCacheForTesting,
} from "../src/worktree.js";

describe("parseWorktreeListPorcelain", () => {
  test("parses main worktree + linked worktrees", () => {
    const output = [
      "worktree /home/user/repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /home/user/repo-feature",
      "HEAD def456",
      "branch refs/heads/feature/auth",
      "",
    ].join("\n");
    const entries = parseWorktreeListPorcelain(output);
    expect(entries).toEqual([
      { path: "/home/user/repo", branch: "main" },
      { path: "/home/user/repo-feature", branch: "feature/auth" },
    ]);
  });

  test("handles detached HEAD (no branch line)", () => {
    const output = [
      "worktree /home/user/repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /home/user/repo-detached",
      "HEAD def456",
      "detached",
      "",
    ].join("\n");
    const entries = parseWorktreeListPorcelain(output);
    expect(entries).toEqual([
      { path: "/home/user/repo", branch: "main" },
      { path: "/home/user/repo-detached", branch: "" },
    ]);
  });

  test("handles empty output", () => {
    expect(parseWorktreeListPorcelain("")).toEqual([]);
  });

  test("handles output without trailing newline", () => {
    const output = [
      "worktree /home/user/repo",
      "HEAD abc123",
      "branch refs/heads/main",
    ].join("\n");
    const entries = parseWorktreeListPorcelain(output);
    expect(entries).toEqual([
      { path: "/home/user/repo", branch: "main" },
    ]);
  });

  test("handles bare repository entry", () => {
    const output = [
      "worktree /home/user/repo.git",
      "HEAD abc123",
      "bare",
      "",
      "worktree /home/user/checkout",
      "HEAD def456",
      "branch refs/heads/main",
      "",
    ].join("\n");
    const entries = parseWorktreeListPorcelain(output);
    expect(entries).toEqual([
      { path: "/home/user/repo.git", branch: "" },
      { path: "/home/user/checkout", branch: "main" },
    ]);
  });
});

describe("resolveWorktreePath", () => {
  test("default sibling template", () => {
    const result = resolveWorktreePath("/home/user/repo", "feature/auth", "../{repo-name}-{branch}");
    expect(result).toBe("/home/user/repo-feature-auth");
  });

  test("sanitizes slashes, backslashes, and spaces in branch name", () => {
    const result = resolveWorktreePath("/home/user/repo", "feat/my branch\\fix", "../{repo-name}-{branch}");
    expect(result).toBe("/home/user/repo-feat-my-branch-fix");
  });

  test("absolute template path", () => {
    const result = resolveWorktreePath("/home/user/repo", "fix-bug", "/tmp/worktrees/{repo-name}/{branch}");
    expect(result).toBe("/tmp/worktrees/repo/fix-bug");
  });

  test("template with {repo-root}", () => {
    const result = resolveWorktreePath("/home/user/repo", "fix", "{repo-root}-wt/{branch}");
    expect(result).toBe("/home/user/repo-wt/fix");
  });

  test("relative template resolves against repo root", () => {
    const result = resolveWorktreePath("/home/user/repo", "fix", "worktrees/{branch}");
    expect(result).toBe("/home/user/repo/worktrees/fix");
  });
});

describe("worktreeFromCwd", () => {
  const repoRoot = "/home/user/repo";

  beforeEach(() => {
    _setCacheForTesting([
      { path: "/home/user/repo", branch: "main" },
      { path: "/home/user/repo-feature-auth", branch: "feature/auth" },
      { path: "/home/user/repo-fix-bug", branch: "fix-bug" },
    ]);
  });

  test("returns branch name when cwd matches worktree path exactly", () => {
    expect(worktreeFromCwd("/home/user/repo-feature-auth", repoRoot)).toBe("feature/auth");
  });

  test("returns branch name when cwd is subdirectory of worktree", () => {
    expect(worktreeFromCwd("/home/user/repo-feature-auth/src/lib", repoRoot)).toBe("feature/auth");
  });

  test("returns null for main worktree cwd", () => {
    expect(worktreeFromCwd("/home/user/repo", repoRoot)).toBeNull();
    expect(worktreeFromCwd("/home/user/repo/src", repoRoot)).toBeNull();
  });

  test("returns null for unrelated cwd", () => {
    expect(worktreeFromCwd("/tmp/other-project", repoRoot)).toBeNull();
  });

  test("returns null for null cwd", () => {
    expect(worktreeFromCwd(null, repoRoot)).toBeNull();
  });
});

describe("projectRootFromCwd", () => {
  const repoRoot = "/home/user/repo";

  beforeEach(() => {
    _setCacheForTesting([
      { path: "/home/user/repo", branch: "main" },
      { path: "/home/user/repo-feature-auth", branch: "feature/auth" },
    ]);
  });

  test("returns repo root when cwd is in a worktree", () => {
    expect(projectRootFromCwd("/home/user/repo-feature-auth", repoRoot)).toBe("/home/user/repo");
    expect(projectRootFromCwd("/home/user/repo-feature-auth/src", repoRoot)).toBe("/home/user/repo");
  });

  test("returns cwd itself when not in any worktree", () => {
    expect(projectRootFromCwd("/tmp/other-project", repoRoot)).toBe("/tmp/other-project");
  });

  test("returns null for null cwd", () => {
    expect(projectRootFromCwd(null, repoRoot)).toBeNull();
  });
});

describe("branchForPathInRepo", () => {
  const repoRoot = "/home/user/repo";

  beforeEach(() => {
    _setCacheForTesting([
      { path: "/home/user/repo", branch: "main" },
      { path: "/home/user/repo-feature-auth", branch: "feature/auth" },
      { path: "/home/user/repo-feature-auth/nested-wt", branch: "nested" },
    ]);
  });

  test("maps a file in a linked worktree to that branch", () => {
    expect(branchForPathInRepo("/home/user/repo-feature-auth/src/x.ts", repoRoot)).toBe("feature/auth");
  });

  test("maps a file in the main worktree to its branch (not excluded)", () => {
    expect(branchForPathInRepo("/home/user/repo/src/x.ts", repoRoot)).toBe("main");
  });

  test("longest-prefix wins for nested worktrees", () => {
    expect(branchForPathInRepo("/home/user/repo-feature-auth/nested-wt/y.ts", repoRoot)).toBe("nested");
  });

  test("returns null for a path outside every worktree of the repo", () => {
    expect(branchForPathInRepo("/home/user/other-repo/z.ts", repoRoot)).toBeNull();
  });

  test("returns null for null path", () => {
    expect(branchForPathInRepo(null, repoRoot)).toBeNull();
  });
});

describe("branchAtCwd", () => {
  beforeEach(() => _resetCacheForTesting());

  test("returns null for null cwd", () => {
    expect(branchAtCwd(null)).toBeNull();
  });

  test("returns the cached branch, normalizing the cwd key", () => {
    _setBranchCacheForTesting("/home/user/repo", "233362-ibt-maxtimelimit");
    expect(branchAtCwd("/home/user/repo")).toBe("233362-ibt-maxtimelimit");
    // path.resolve collapses the trailing segments to the same key
    expect(branchAtCwd("/home/user/repo/nested/..")).toBe("233362-ibt-maxtimelimit");
  });

  test("caches a null result (detached HEAD / non-git cwd)", () => {
    _setBranchCacheForTesting("/tmp/not-a-repo", null);
    expect(branchAtCwd("/tmp/not-a-repo")).toBeNull();
  });

  describe("against a real git repo", () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "agmux-branch-"));
      const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
      git("init", "-q");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "T");
      git("config", "commit.gpgsign", "false");
      fs.writeFileSync(path.join(dir, "f"), "x");
      git("add", ".");
      git("commit", "-qm", "init");
      _resetCacheForTesting();
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test("reads the checked-out branch of the primary worktree", () => {
      execFileSync("git", ["-C", dir, "checkout", "-q", "-b", "233362-ibt-maxtimelimit"], { stdio: "ignore" });
      _resetCacheForTesting();
      expect(branchAtCwd(dir)).toBe("233362-ibt-maxtimelimit");
    });

    test("returns null for a detached HEAD", () => {
      const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      execFileSync("git", ["-C", dir, "checkout", "-q", head], { stdio: "ignore" });
      _resetCacheForTesting();
      expect(branchAtCwd(dir)).toBeNull();
    });
  });
});

describe("worktree cache", () => {
  test("keeps separate entries per repo root", () => {
    _setCacheForTesting(
      [
        { path: "/home/user/repo-a", branch: "main" },
        { path: "/home/user/repo-a-feature", branch: "feature-a" },
      ],
      "/home/user/repo-a",
    );
    _setCacheForTesting(
      [
        { path: "/home/user/repo-b", branch: "main" },
        { path: "/home/user/repo-b-feature", branch: "feature-b" },
      ],
      "/home/user/repo-b",
    );

    expect(worktreeFromCwd("/home/user/repo-a-feature/src", "/home/user/repo-a")).toBe("feature-a");
    expect(worktreeFromCwd("/home/user/repo-b-feature/src", "/home/user/repo-b")).toBe("feature-b");
  });
});
