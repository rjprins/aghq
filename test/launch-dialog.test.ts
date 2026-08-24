/**
 * Tests for launch dialog correctness:
 *
 * 1. Codex conflicting options — `--full-auto` and
 *    `--dangerously-bypass-approvals-and-sandbox` both make `--ask-for-approval`
 *    and `--sandbox` meaningless; they should not appear together in the command.
 *
 * 2. Main branch selection when creating a new worktree — the main worktree
 *    (repoRoot) should appear as a selectable option even when the user is
 *    currently in a feature worktree.
 *
 * 3. Main branch detection — `defaultBranch()` must return a branch that
 *    actually exists in the repo, not a hard-coded "main" fallback.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync, execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createWorktreeService } from "../src/server/worktrees.js";
import { agentCommand, FLAG_DEFAULTS } from "../src/server/routes/ptys.js";
import { expandHomePath } from "../src/server/utils.js";
import { _resetCacheForTesting, projectRootFromCwdAny, worktreeFromCwdAny } from "../src/worktree.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary git repository with an initial commit.
 * Worktrees created from this repo via the default template (`../{repo-name}-{branch}`)
 * land inside `parentDir`, so a single `cleanup()` removes everything.
 */
async function createTempRepo(initialBranch = "main"): Promise<{
  parentDir: string;
  repoRoot: string;
  cleanup: () => Promise<void>;
}> {
  const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-test-"));
  const repoRoot = path.join(parentDir, "repo");
  await fs.mkdir(repoRoot);

  try {
    execFileSync("git", ["init", "-b", initialBranch], { cwd: repoRoot, stdio: "pipe" });
  } catch {
    // git < 2.28 does not support -b; use symbolic-ref instead
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "pipe" });
    execFileSync("git", ["symbolic-ref", "HEAD", `refs/heads/${initialBranch}`], {
      cwd: repoRoot,
      stdio: "pipe",
    });
  }

  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoRoot, stdio: "pipe" });
  await fs.writeFile(path.join(repoRoot, "README.md"), "# Test\n");
  execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: repoRoot, stdio: "pipe" });

  return {
    parentDir,
    repoRoot,
    cleanup: async () => fs.rm(parentDir, { recursive: true, force: true }),
  };
}

function makeService(repoRoot: string) {
  const store = { getPreference: () => undefined } as any;
  return createWorktreeService({ repoRoot, store, defaultBaseBranch: "main" });
}

// ---------------------------------------------------------------------------
// 1. agentCommand — codex flag defaults
// ---------------------------------------------------------------------------

describe("agentCommand: codex FLAG_DEFAULTS", () => {
  test("codex server-side defaults are untrusted approval and read-only sandbox", () => {
    expect(FLAG_DEFAULTS["codex"]).toEqual({
      "--ask-for-approval": "untrusted",
      "--sandbox": "read-only",
    });
  });

  test("flags matching FLAG_DEFAULTS are omitted from the command", () => {
    const cmd = agentCommand("codex", {
      "--ask-for-approval": "untrusted",
      "--sandbox": "read-only",
    });
    expect(cmd).toBe("codex");
  });

  test("non-default approval value is included", () => {
    const cmd = agentCommand("codex", { "--ask-for-approval": "on-request" });
    expect(cmd).toBe("codex --ask-for-approval on-request");
  });

  test("non-default sandbox value is included", () => {
    const cmd = agentCommand("codex", { "--sandbox": "workspace-write" });
    expect(cmd).toBe("codex --sandbox workspace-write");
  });

  test("false checkbox flags are omitted", () => {
    const cmd = agentCommand("codex", {
      "--full-auto": false,
      "--dangerously-bypass-approvals-and-sandbox": false,
    });
    expect(cmd).toBe("codex");
  });
});

// ---------------------------------------------------------------------------
// 2. agentCommand — codex --full-auto conflict resolution
// ---------------------------------------------------------------------------

describe("agentCommand: codex --full-auto conflicts", () => {
  test("--full-auto alone produces a clean command", () => {
    const cmd = agentCommand("codex", { "--full-auto": true });
    expect(cmd).toBe("codex --full-auto");
  });

  test("--full-auto suppresses --ask-for-approval (conflict)", () => {
    // --full-auto implies fully automatic execution; specifying an approval
    // policy alongside it is contradictory and confusing.
    const cmd = agentCommand("codex", {
      "--full-auto": true,
      "--ask-for-approval": "on-request",
    });
    expect(cmd).toContain("--full-auto");
    expect(cmd).not.toContain("--ask-for-approval");
  });

  test("--full-auto suppresses --sandbox (conflict)", () => {
    const cmd = agentCommand("codex", {
      "--full-auto": true,
      "--sandbox": "workspace-write",
    });
    expect(cmd).toContain("--full-auto");
    expect(cmd).not.toContain("--sandbox");
  });

  test("--full-auto suppresses both approval and sandbox together", () => {
    const cmd = agentCommand("codex", {
      "--full-auto": true,
      "--ask-for-approval": "on-request",
      "--sandbox": "workspace-write",
    });
    expect(cmd).toBe("codex --full-auto");
  });

  test("without --full-auto, approval and sandbox are included normally", () => {
    const cmd = agentCommand("codex", {
      "--full-auto": false,
      "--ask-for-approval": "on-request",
      "--sandbox": "workspace-write",
    });
    expect(cmd).toContain("--ask-for-approval on-request");
    expect(cmd).toContain("--sandbox workspace-write");
    expect(cmd).not.toContain("--full-auto");
  });
});

// ---------------------------------------------------------------------------
// 3. agentCommand — codex --dangerously-bypass conflict resolution
// ---------------------------------------------------------------------------

describe("agentCommand: codex --dangerously-bypass conflicts", () => {
  test("--dangerously-bypass alone produces a clean command", () => {
    const cmd = agentCommand("codex", {
      "--dangerously-bypass-approvals-and-sandbox": true,
    });
    expect(cmd).toBe("codex --dangerously-bypass-approvals-and-sandbox");
  });

  test("--dangerously-bypass suppresses --ask-for-approval (conflict)", () => {
    const cmd = agentCommand("codex", {
      "--dangerously-bypass-approvals-and-sandbox": true,
      "--ask-for-approval": "on-request",
    });
    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd).not.toContain("--ask-for-approval");
  });

  test("--dangerously-bypass suppresses --sandbox (conflict)", () => {
    const cmd = agentCommand("codex", {
      "--dangerously-bypass-approvals-and-sandbox": true,
      "--sandbox": "workspace-write",
    });
    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd).not.toContain("--sandbox");
  });

  test("--dangerously-bypass suppresses both approval and sandbox together", () => {
    const cmd = agentCommand("codex", {
      "--dangerously-bypass-approvals-and-sandbox": true,
      "--ask-for-approval": "on-request",
      "--sandbox": "workspace-write",
    });
    expect(cmd).toBe("codex --dangerously-bypass-approvals-and-sandbox");
  });
});

// ---------------------------------------------------------------------------
// 4. agentCommand — non-codex agents are unaffected
// ---------------------------------------------------------------------------

describe("agentCommand: claude and other agents are unaffected by codex rules", () => {
  test("claude permission-mode default is omitted", () => {
    const cmd = agentCommand("claude", { "--permission-mode": "default" });
    expect(cmd).toBe("claude");
  });

  test("claude non-default permission-mode is included", () => {
    const cmd = agentCommand("claude", { "--permission-mode": "bypassPermissions" });
    expect(cmd).toBe("claude --permission-mode bypassPermissions");
  });

  test("aider has no special flag rules", () => {
    const cmd = agentCommand("aider", { "--model": "gpt-4o" });
    expect(cmd).toBe("aider --model gpt-4o");
  });
});

// ---------------------------------------------------------------------------
// 5. defaultBranch — actual git repos
// ---------------------------------------------------------------------------

describe("defaultBranch: actual git repos", () => {
  let cleanup: (() => Promise<void>) | undefined;

  beforeEach(() => {
    _resetCacheForTesting();
  });

  afterEach(async () => {
    _resetCacheForTesting();
    await cleanup?.();
    cleanup = undefined;
  });

  test("returns 'main' when repo is initialised on main", async () => {
    const repo = await createTempRepo("main");
    cleanup = repo.cleanup;
    const svc = makeService(repo.repoRoot);
    expect(await svc.defaultBranch(repo.repoRoot)).toBe("main");
  });

  test("returns 'master' when repo is initialised on master", async () => {
    const repo = await createTempRepo("master");
    cleanup = repo.cleanup;
    const svc = makeService(repo.repoRoot);
    expect(await svc.defaultBranch(repo.repoRoot)).toBe("master");
  });

  test("returns the actual default branch when it is neither 'main' nor 'master'", async () => {
    // Repos initialised on e.g. 'trunk' or 'develop' are common.
    // The function must not return the non-existent 'main' in this case.
    const repo = await createTempRepo("trunk");
    cleanup = repo.cleanup;
    const svc = makeService(repo.repoRoot);
    const branch = await svc.defaultBranch(repo.repoRoot);
    expect(branch).toBe("trunk");
    // Verify 'main' really does not exist in this repo
    expect(await svc.gitRefExists("main", repo.repoRoot)).toBe(false);
  });

  test("returns 'main' when main exists even though current branch is something else", async () => {
    const repo = await createTempRepo("main");
    cleanup = repo.cleanup;
    execFileSync("git", ["checkout", "-b", "feature-x"], { cwd: repo.repoRoot, stdio: "pipe" });
    const svc = makeService(repo.repoRoot);
    // 'main' still exists → should be detected
    expect(await svc.defaultBranch(repo.repoRoot)).toBe("main");
  });

  test("prefers origin/HEAD over local branch detection", async () => {
    const repo = await createTempRepo("main");
    cleanup = repo.cleanup;
    execFileSync("git", ["checkout", "-b", "develop"], { cwd: repo.repoRoot, stdio: "pipe" });
    // Simulate a remote pointer without an actual remote
    execFileSync(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"],
      { cwd: repo.repoRoot, stdio: "pipe" },
    );
    const svc = makeService(repo.repoRoot);
    expect(await svc.defaultBranch(repo.repoRoot)).toBe("develop");
  });

  test("accepts null projectRoot and falls back to repoRoot", async () => {
    const repo = await createTempRepo("main");
    cleanup = repo.cleanup;
    const svc = makeService(repo.repoRoot);
    expect(await svc.defaultBranch(null)).toBe("main");
  });

  test("expandHomePath expands a leading tilde", () => {
    expect(expandHomePath("~/project")).toBe(path.join(os.homedir(), "project"));
    expect(expandHomePath("~")).toBe(os.homedir());
  });

  test("directoryExists and resolveProjectRoot both accept tilde-prefixed paths", async () => {
    const repo = await createTempRepo("main");
    cleanup = repo.cleanup;
    const svc = makeService(repo.repoRoot);
    const homeTempDir = await fs.mkdtemp(path.join(os.homedir(), ".agmux-home-test-"));
    try {
      const homeRepoRoot = path.join(homeTempDir, "repo");
      await fs.mkdir(homeRepoRoot);

      try {
        execFileSync("git", ["init", "-b", "main"], { cwd: homeRepoRoot, stdio: "pipe" });
      } catch {
        execFileSync("git", ["init"], { cwd: homeRepoRoot, stdio: "pipe" });
        execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: homeRepoRoot, stdio: "pipe" });
      }

      const tildeRepoPath = `~/${path.relative(os.homedir(), homeRepoRoot)}`;
      expect(await svc.directoryExists(tildeRepoPath)).toBe(true);
      expect(await svc.resolveProjectRoot(tildeRepoPath)).toBe(homeRepoRoot);
    } finally {
      await fs.rm(homeTempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 6. createWorktreeFromBase — main branch as base
// ---------------------------------------------------------------------------

describe("createWorktreeFromBase: main branch as base", () => {
  let cleanup: (() => Promise<void>) | undefined;

  beforeEach(() => {
    _resetCacheForTesting();
  });

  afterEach(async () => {
    _resetCacheForTesting();
    await cleanup?.();
    cleanup = undefined;
  });

  test("creates a feature worktree based on main", async () => {
    const repo = await createTempRepo("main");
    cleanup = repo.cleanup;
    const svc = makeService(repo.repoRoot);
    const wtPath = await svc.createWorktreeFromBase({
      projectRoot: repo.repoRoot,
      branch: "feature-alpha",
      baseBranch: "main",
    });
    expect(await fs.stat(wtPath).then(() => true).catch(() => false)).toBe(true);
  });

  test("fails with a clear error when the base branch does not exist", async () => {
    // Repo uses 'trunk' — 'main' does not exist.
    const repo = await createTempRepo("trunk");
    cleanup = repo.cleanup;
    const svc = makeService(repo.repoRoot);
    await expect(
      svc.createWorktreeFromBase({
        projectRoot: repo.repoRoot,
        branch: "feature-alpha",
        baseBranch: "main", // does not exist!
      }),
    ).rejects.toThrow("base branch not found: main");
  });

  test("succeeds when base branch is the actual default (non-main)", async () => {
    const repo = await createTempRepo("trunk");
    cleanup = repo.cleanup;
    const svc = makeService(repo.repoRoot);
    const detectedBase = await svc.defaultBranch(repo.repoRoot);
    // defaultBranch must return an existing branch so createWorktreeFromBase succeeds
    const wtPath = await svc.createWorktreeFromBase({
      projectRoot: repo.repoRoot,
      branch: "feature-trunk-based",
      baseBranch: detectedBase,
    });
    expect(await fs.stat(wtPath).then(() => true).catch(() => false)).toBe(true);
  });

  test("creating multiple worktrees from main does not prevent further creation", async () => {
    const repo = await createTempRepo("main");
    cleanup = repo.cleanup;
    const svc = makeService(repo.repoRoot);
    await svc.createWorktreeFromBase({ projectRoot: repo.repoRoot, branch: "feature-a", baseBranch: "main" });
    const wtPath = await svc.createWorktreeFromBase({
      projectRoot: repo.repoRoot,
      branch: "feature-b",
      baseBranch: "main",
    });
    expect(await fs.stat(wtPath).then(() => true).catch(() => false)).toBe(true);
  });

  test("branch name validation rejects unsafe names", async () => {
    const repo = await createTempRepo("main");
    cleanup = repo.cleanup;
    const svc = makeService(repo.repoRoot);
    await expect(
      svc.createWorktreeFromBase({ projectRoot: repo.repoRoot, branch: "../escape", baseBranch: "main" }),
    ).rejects.toThrow("invalid branch name");
  });
});

describe("createWorktreeFromBase: refreshed remote PR branch", () => {
  let cleanup: (() => Promise<void>) | undefined;

  beforeEach(() => {
    _resetCacheForTesting();
  });

  afterEach(async () => {
    _resetCacheForTesting();
    await cleanup?.();
    cleanup = undefined;
  });

  test("fetches a remote-only source branch before creating its local worktree", async () => {
    const repo = await createTempRepo("main");
    cleanup = repo.cleanup;
    const remoteRoot = path.join(repo.parentDir, "remote.git");
    execFileSync("git", ["init", "--bare", remoteRoot], { stdio: "pipe" });
    execFileSync("git", ["remote", "add", "origin", remoteRoot], { cwd: repo.repoRoot, stdio: "pipe" });
    execFileSync("git", ["push", "origin", "main"], { cwd: repo.repoRoot, stdio: "pipe" });
    execFileSync("git", ["switch", "-c", "feature/scanner"], { cwd: repo.repoRoot, stdio: "pipe" });
    await fs.writeFile(path.join(repo.repoRoot, "scanner.txt"), "remote PR branch\n");
    execFileSync("git", ["add", "scanner.txt"], { cwd: repo.repoRoot, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "add scanner"], { cwd: repo.repoRoot, stdio: "pipe" });
    const expectedHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo.repoRoot,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["push", "origin", "feature/scanner"], { cwd: repo.repoRoot, stdio: "pipe" });
    execFileSync("git", ["switch", "main"], { cwd: repo.repoRoot, stdio: "pipe" });
    execFileSync("git", ["branch", "-D", "feature/scanner"], { cwd: repo.repoRoot, stdio: "pipe" });
    execFileSync("git", ["update-ref", "-d", "refs/remotes/origin/feature/scanner"], {
      cwd: repo.repoRoot,
      stdio: "pipe",
    });

    const svc = makeService(repo.repoRoot);
    const wtPath = await svc.createWorktreeFromBase({
      projectRoot: repo.repoRoot,
      branch: "feature/scanner",
      baseBranch: "origin/feature/scanner",
      refreshRemoteBase: true,
    });

    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: wtPath, encoding: "utf8" }).trim()).toBe(expectedHead);
    await expect(fs.readFile(path.join(wtPath, "scanner.txt"), "utf8")).resolves.toBe("remote PR branch\n");
  });
});

// ---------------------------------------------------------------------------
// 7. listWorktrees — main worktree visibility
// ---------------------------------------------------------------------------

describe("listWorktrees: main worktree should be selectable", () => {
  let cleanup: (() => Promise<void>) | undefined;

  beforeEach(() => {
    _resetCacheForTesting();
  });

  afterEach(async () => {
    _resetCacheForTesting();
    await cleanup?.();
    cleanup = undefined;
  });

  test("repoRoot is always returned so the UI can offer it as an option", async () => {
    const repo = await createTempRepo("main");
    cleanup = repo.cleanup;
    const svc = makeService(repo.repoRoot);
    const { repoRoot } = svc.listWorktrees();
    expect(repoRoot).toBe(repo.repoRoot);
  });

  test("main worktree appears in the worktrees list so it is selectable from feature branches", async () => {
    // When a user is working in a feature worktree, the launch dialog must
    // still allow them to launch an agent in the main worktree.
    // listWorktrees() should include the main worktree entry.
    const repo = await createTempRepo("main");
    cleanup = repo.cleanup;
    const svc = makeService(repo.repoRoot);
    await svc.createWorktreeFromBase({ projectRoot: repo.repoRoot, branch: "feature-x", baseBranch: "main" });

    const { worktrees } = svc.listWorktrees();
    const mainEntry = worktrees.find((w) => w.path === repo.repoRoot);
    expect(mainEntry).toBeDefined();
    expect(mainEntry?.branch).toBe("main");
  });

  test("feature worktrees appear in the list alongside the main worktree", async () => {
    const repo = await createTempRepo("main");
    cleanup = repo.cleanup;
    const svc = makeService(repo.repoRoot);
    await svc.createWorktreeFromBase({ projectRoot: repo.repoRoot, branch: "feature-y", baseBranch: "main" });

    const { worktrees } = svc.listWorktrees();
    expect(worktrees.some((w) => w.branch === "feature-y")).toBe(true);
    expect(worktrees.some((w) => w.path === repo.repoRoot)).toBe(true);
  });

  test("main worktree directory is a valid launch target", async () => {
    const repo = await createTempRepo("main");
    cleanup = repo.cleanup;
    const svc = makeService(repo.repoRoot);
    expect(await svc.directoryExists(repo.repoRoot)).toBe(true);
  });

  test("listWorktrees can target a different resolved project root", async () => {
    const repoA = await createTempRepo("main");
    const repoB = await createTempRepo("main");
    cleanup = async () => {
      await repoA.cleanup();
      await repoB.cleanup();
    };
    const svc = makeService(repoA.repoRoot);
    await svc.createWorktreeFromBase({ projectRoot: repoB.repoRoot, branch: "feature-b", baseBranch: "main" });

    const { worktrees, repoRoot } = svc.listWorktrees(repoB.repoRoot);
    expect(repoRoot).toBe(repoB.repoRoot);
    expect(worktrees.some((w) => w.path === repoB.repoRoot)).toBe(true);
    expect(worktrees.some((w) => w.branch === "feature-b")).toBe(true);
    expect(worktrees.some((w) => w.path === repoA.repoRoot)).toBe(false);
  });
});

describe("listBranches: base branch choices", () => {
  let cleanup: (() => Promise<void>) | undefined;

  beforeEach(() => {
    _resetCacheForTesting();
  });

  afterEach(async () => {
    _resetCacheForTesting();
    await cleanup?.();
    cleanup = undefined;
  });

  test("returns available local branches for the launch dialog base branch dropdown", async () => {
    const repo = await createTempRepo("main");
    cleanup = repo.cleanup;
    execFileSync("git", ["checkout", "-b", "develop"], { cwd: repo.repoRoot, stdio: "pipe" });
    execFileSync("git", ["checkout", "main"], { cwd: repo.repoRoot, stdio: "pipe" });

    const svc = makeService(repo.repoRoot);
    const branches = await svc.listBranches(repo.repoRoot);
    const names = branches.map((branch) => branch.name);

    expect(names).toContain("main");
    expect(names).toContain("develop");
  });

  test("omits symbolic remote HEAD aliases from branch choices", async () => {
    const repo = await createTempRepo("main");
    cleanup = repo.cleanup;
    execFileSync(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
      { cwd: repo.repoRoot, stdio: "pipe" },
    );

    const svc = makeService(repo.repoRoot);
    const branches = await svc.listBranches(repo.repoRoot);

    expect(branches.some((branch) => branch.name.endsWith("/HEAD"))).toBe(false);
    expect(branches.some((branch) => branch.name === "origin")).toBe(false);
  });
});

describe("generic worktree resolution", () => {
  let cleanup: (() => Promise<void>) | undefined;

  beforeEach(() => {
    _resetCacheForTesting();
  });

  afterEach(async () => {
    _resetCacheForTesting();
    await cleanup?.();
    cleanup = undefined;
  });

  test("resolves shared repo root and branch from a linked worktree cwd", async () => {
    const repo = await createTempRepo("main");
    cleanup = repo.cleanup;
    const svc = makeService(repo.repoRoot);
    const worktreePath = await svc.createWorktreeFromBase({
      projectRoot: repo.repoRoot,
      branch: "feature-linked",
      baseBranch: "main",
    });
    const nestedDir = path.join(worktreePath, "src");
    await fs.mkdir(nestedDir);

    expect(projectRootFromCwdAny(worktreePath)).toBe(repo.repoRoot);
    expect(projectRootFromCwdAny(nestedDir)).toBe(repo.repoRoot);
    expect(worktreeFromCwdAny(worktreePath)).toBe("feature-linked");
    expect(worktreeFromCwdAny(nestedDir)).toBe("feature-linked");
  });
});

// ---------------------------------------------------------------------------
// 8. agentCommand — codex: both bypass flags simultaneously, and UI defaults
// ---------------------------------------------------------------------------

describe("agentCommand: codex — combined flags and UI default values", () => {
  test("both --full-auto and --dangerously-bypass true: both appear, approval and sandbox suppressed", () => {
    // Either flag alone already suppresses --ask-for-approval and --sandbox.
    // When both are present they should both appear in the command and still
    // suppress the conflicting flags.
    const cmd = agentCommand("codex", {
      "--full-auto": true,
      "--dangerously-bypass-approvals-and-sandbox": true,
      "--ask-for-approval": "on-request",
      "--sandbox": "workspace-write",
    });
    expect(cmd).toContain("--full-auto");
    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd).not.toContain("--ask-for-approval");
    expect(cmd).not.toContain("--sandbox");
  });

  test("UI default values with --full-auto checked: produces clean 'codex --full-auto'", () => {
    // The UI's AGENT_OPTIONS has defaultValue "on-request" for --ask-for-approval
    // and "workspace-write" for --sandbox. These differ from FLAG_DEFAULTS
    // (server-side defaults of "untrusted" and "read-only").
    // When --full-auto is checked (its defaultChecked is true in the UI),
    // both conflicting flags must be suppressed regardless of their values.
    const cmd = agentCommand("codex", {
      "--full-auto": true,
      "--ask-for-approval": "on-request",   // UI defaultValue (≠ server default "untrusted")
      "--sandbox": "workspace-write",        // UI defaultValue (≠ server default "read-only")
    });
    expect(cmd).toBe("codex --full-auto");
  });

  test("UI default values without --full-auto: non-server-default values appear in command", () => {
    // When --full-auto is unchecked the UI sends its own defaultValues.
    // Since they differ from FLAG_DEFAULTS, both flags appear in the command.
    const cmd = agentCommand("codex", {
      "--full-auto": false,
      "--ask-for-approval": "on-request",   // UI defaultValue
      "--sandbox": "workspace-write",        // UI defaultValue
    });
    expect(cmd).toContain("--ask-for-approval on-request");
    expect(cmd).toContain("--sandbox workspace-write");
    expect(cmd).not.toContain("--full-auto");
  });

  test("--dangerously-bypass with UI defaults: only the bypass flag appears", () => {
    const cmd = agentCommand("codex", {
      "--dangerously-bypass-approvals-and-sandbox": true,
      "--ask-for-approval": "on-request",
      "--sandbox": "workspace-write",
    });
    expect(cmd).toBe("codex --dangerously-bypass-approvals-and-sandbox");
  });
});

// ---------------------------------------------------------------------------
// 9. defaultBranch — detached HEAD edge cases
// ---------------------------------------------------------------------------

describe("defaultBranch: detached HEAD state", () => {
  let cleanup: (() => Promise<void>) | undefined;

  beforeEach(() => {
    _resetCacheForTesting();
  });

  afterEach(async () => {
    _resetCacheForTesting();
    await cleanup?.();
    cleanup = undefined;
  });

  test("detached HEAD on main repo: returns 'main' (which exists)", async () => {
    // git symbolic-ref --short HEAD fails in detached HEAD state.
    // The fallback for-loop should still find 'main' because it exists.
    const repo = await createTempRepo("main");
    cleanup = repo.cleanup;
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo.repoRoot,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["checkout", "--detach", sha], { cwd: repo.repoRoot, stdio: "pipe" });

    const svc = makeService(repo.repoRoot);
    const branch = await svc.defaultBranch(repo.repoRoot);
    expect(branch).toBe("main");
    expect(await svc.gitRefExists(branch, repo.repoRoot)).toBe(true);
  });

  test("detached HEAD on non-main/non-master repo: returned branch must exist", async () => {
    // Critical: if the repo only has 'trunk' and HEAD is detached,
    // the 'main' / 'master' checks both fail. The symbolic-ref fallback
    // also fails. The hardcoded 'main' fallback would return a non-existent
    // branch name, breaking createWorktreeFromBase.
    const repo = await createTempRepo("trunk");
    cleanup = repo.cleanup;
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo.repoRoot,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["checkout", "--detach", sha], { cwd: repo.repoRoot, stdio: "pipe" });

    const svc = makeService(repo.repoRoot);
    const branch = await svc.defaultBranch(repo.repoRoot);
    // Whatever is returned, it MUST exist in the repo so it is usable.
    expect(await svc.gitRefExists(branch, repo.repoRoot)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. defaultBranch — origin/HEAD without a local branch
// ---------------------------------------------------------------------------

describe("defaultBranch: origin/HEAD pointing to a non-existent local branch", () => {
  let cleanup: (() => Promise<void>) | undefined;

  beforeEach(() => {
    _resetCacheForTesting();
  });

  afterEach(async () => {
    _resetCacheForTesting();
    await cleanup?.();
    cleanup = undefined;
  });

  test("origin/HEAD → non-existent local branch: returned branch must be usable", async () => {
    // Scenario: git symbolic-ref refs/remotes/origin/HEAD succeeds and returns
    // "refs/remotes/origin/main", so defaultBranch() returns "main" — but no
    // local 'main' branch exists (only 'trunk').
    // The returned branch must still be usable as a baseBranch for
    // createWorktreeFromBase; otherwise the launch dialog silently breaks.
    const repo = await createTempRepo("trunk");
    cleanup = repo.cleanup;
    // Plant an origin/HEAD pointer to a branch that has no local ref.
    execFileSync(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
      { cwd: repo.repoRoot, stdio: "pipe" },
    );

    const svc = makeService(repo.repoRoot);
    const branch = await svc.defaultBranch(repo.repoRoot);
    // The returned branch must exist locally so it can serve as a baseBranch.
    expect(await svc.gitRefExists(branch, repo.repoRoot)).toBe(true);
  });

  test("origin/HEAD → existing local branch: works correctly", async () => {
    // Positive case: origin/HEAD points to 'main' and local 'main' exists.
    const repo = await createTempRepo("main");
    cleanup = repo.cleanup;
    execFileSync("git", ["checkout", "-b", "develop"], { cwd: repo.repoRoot, stdio: "pipe" });
    execFileSync(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
      { cwd: repo.repoRoot, stdio: "pipe" },
    );

    const svc = makeService(repo.repoRoot);
    const branch = await svc.defaultBranch(repo.repoRoot);
    expect(branch).toBe("main");
    expect(await svc.gitRefExists(branch, repo.repoRoot)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. defaultBranch + createWorktreeFromBase — round-trip guarantee
// ---------------------------------------------------------------------------

describe("defaultBranch + createWorktreeFromBase: round-trip", () => {
  let cleanup: (() => Promise<void>) | undefined;

  beforeEach(() => {
    _resetCacheForTesting();
  });

  afterEach(async () => {
    _resetCacheForTesting();
    await cleanup?.();
    cleanup = undefined;
  });

  for (const initialBranch of ["main", "master", "trunk", "develop"]) {
    test(`detected default branch is always usable as baseBranch (repo initialised on '${initialBranch}')`, async () => {
      // The contract between defaultBranch() and createWorktreeFromBase():
      // whatever defaultBranch() returns must be accepted as baseBranch
      // without error, so the launch dialog never presents a broken default.
      const repo = await createTempRepo(initialBranch);
      cleanup = repo.cleanup;
      const svc = makeService(repo.repoRoot);

      const baseBranch = await svc.defaultBranch(repo.repoRoot);
      await expect(
        svc.createWorktreeFromBase({
          projectRoot: repo.repoRoot,
          branch: `feature-from-${initialBranch}`,
          baseBranch,
        }),
      ).resolves.toBeTruthy();
    });
  }
});

// ---------------------------------------------------------------------------
// 12. isKnownWorktreePath — main worktree exclusion and launch compatibility
// ---------------------------------------------------------------------------

describe("isKnownWorktreePath: main worktree exclusion", () => {
  let cleanup: (() => Promise<void>) | undefined;

  beforeEach(() => {
    _resetCacheForTesting();
  });

  afterEach(async () => {
    _resetCacheForTesting();
    await cleanup?.();
    cleanup = undefined;
  });

  test("repoRoot is NOT considered a known worktree by isKnownWorktreePath", async () => {
    // isKnownWorktree() explicitly skips the main worktree entry.
    // This is intentional: the main worktree cannot be 'removed' via the API.
    // However it also means /api/worktrees/status rejects the main worktree.
    const repo = await createTempRepo("main");
    cleanup = repo.cleanup;
    const svc = makeService(repo.repoRoot);
    svc.refreshCache();
    expect(svc.isKnownWorktreePath(repo.repoRoot)).toBe(false);
  });

  test("feature worktrees ARE considered known", async () => {
    const repo = await createTempRepo("main");
    cleanup = repo.cleanup;
    const svc = makeService(repo.repoRoot);
    const wtPath = await svc.createWorktreeFromBase({
      projectRoot: repo.repoRoot,
      branch: "feature-known",
      baseBranch: "main",
    });
    expect(svc.isKnownWorktreePath(wtPath)).toBe(true);
  });

  test("main worktree is selectable for launch via directoryExists (the check the launch route uses)", async () => {
    // The /api/ptys/launch route validates the worktree path with
    // directoryExists(), NOT isKnownWorktreePath(). So the main worktree
    // remains launchable even though isKnownWorktreePath returns false.
    const repo = await createTempRepo("main");
    cleanup = repo.cleanup;
    const svc = makeService(repo.repoRoot);
    expect(await svc.directoryExists(repo.repoRoot)).toBe(true);
    // Confirmed: directoryExists passes; isKnownWorktreePath is not the gatekeeper.
    expect(svc.isKnownWorktreePath(repo.repoRoot)).toBe(false);
  });

  test("main worktree stays in listWorktrees after creating many feature branches", async () => {
    const repo = await createTempRepo("main");
    cleanup = repo.cleanup;
    const svc = makeService(repo.repoRoot);
    for (const branch of ["feat-a", "feat-b", "feat-c"]) {
      await svc.createWorktreeFromBase({ projectRoot: repo.repoRoot, branch, baseBranch: "main" });
    }
    const { worktrees } = svc.listWorktrees();
    const mainEntry = worktrees.find((w) => w.path === repo.repoRoot);
    expect(mainEntry).toBeDefined();
    expect(mainEntry?.branch).toBe("main");
    // And all feature branches are also present
    expect(worktrees.length).toBe(4); // main + 3 features
  });
});
