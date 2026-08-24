import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { SqliteStore } from "../persist/sqlite.js";
import {
  DEFAULT_WORKTREE_TEMPLATE,
  getWorktreeCache,
  gitRepoRootFromCwd,
  isKnownWorktree,
  refreshWorktreeCacheSync,
  resolveWorktreePath,
} from "../worktree.js";
import { expandHomePath, pathExistsAndIsDirectory } from "./utils.js";

type WorktreeServiceDeps = {
  repoRoot: string;
  store: SqliteStore;
  defaultBaseBranch: string;
};

export type WorktreeStatus = {
  dirty: boolean;
  branch: string;
  changes: string[];
};

export type WorktreeSummary = {
  name: string;
  path: string;
  branch: string;
};

export type BranchSummary = {
  name: string;
};

export function createWorktreeService(deps: WorktreeServiceDeps) {
  const { repoRoot, store, defaultBaseBranch } = deps;

  function getWorktreeTemplate(): string {
    const settings = store.getPreference<{ worktreePathTemplate?: string }>("settings");
    return settings?.worktreePathTemplate || DEFAULT_WORKTREE_TEMPLATE;
  }

  async function resolveProjectRoot(raw: unknown): Promise<string | null> {
    if (typeof raw !== "string" || !raw.trim()) return null;
    const resolved = path.resolve(expandHomePath(raw.trim()));
    if (!(await pathExistsAndIsDirectory(resolved))) return null;
    try {
      await fs.stat(path.join(resolved, ".git"));
      return resolved;
    } catch {
      return null;
    }
  }

  async function gitBranchNameValid(branch: string, cwd: string = repoRoot): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      execFile("git", ["check-ref-format", "--branch", branch], { cwd }, (err) => {
        resolve(!err);
      });
    });
  }

  async function gitRefExists(ref: string, cwd: string = repoRoot): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      execFile("git", ["rev-parse", "--verify", "--quiet", ref], { cwd }, (err) => {
        resolve(!err);
      });
    });
  }

  function isBranchFormatLikelySafe(branch: string): boolean {
    if (!/^[A-Za-z0-9._/-]{1,120}$/.test(branch)) return false;
    if (branch.startsWith("/") || branch.startsWith("-")) return false;
    if (branch.endsWith("/") || branch.endsWith(".")) return false;
    if (branch.includes("..") || branch.includes("//") || branch.includes("@{")) return false;
    if (branch.endsWith(".lock")) return false;
    return true;
  }

  function listWorktrees(projectRoot?: string | null): { worktrees: WorktreeSummary[]; repoRoot: string } {
    const effectiveRepoRoot = path.resolve(projectRoot ?? repoRoot);
    refreshWorktreeCacheSync(effectiveRepoRoot);
    const cache = getWorktreeCache(effectiveRepoRoot);
    const worktrees: WorktreeSummary[] = [];
    for (const entry of cache) {
      worktrees.push({
        name: entry.branch || path.basename(entry.path),
        path: entry.path,
        branch: entry.branch,
      });
    }
    return { worktrees, repoRoot: effectiveRepoRoot };
  }

  // Resolve the repo a worktree path belongs to (any repo, not just the
  // server's own), refreshing that repo's cache so membership checks are fresh.
  function repoRootForWorktreePath(resolved: string): string | null {
    const root = gitRepoRootFromCwd(resolved);
    if (!root) return null;
    refreshWorktreeCacheSync(root);
    return root;
  }

  async function worktreeStatus(wtPath: string): Promise<WorktreeStatus> {
    const resolved = path.resolve(wtPath);
    const effectiveRoot = repoRootForWorktreePath(resolved);
    if (!effectiveRoot || !isKnownWorktree(resolved, effectiveRoot)) {
      throw new Error("path is not a known worktree");
    }
    const statusText = await new Promise<string>((resolve, reject) => {
      execFile("git", ["status", "--porcelain"], { cwd: resolved }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
    const changes = statusText.split("\n").map((l) => l.trim()).filter(Boolean);
    const dirty = changes.length > 0;
    let branch = "";
    try {
      branch = await new Promise<string>((resolve, reject) => {
        execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: resolved }, (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout.trim());
        });
      });
    } catch {
      // ignore
    }
    return { dirty, branch, changes: changes.slice(0, 20) };
  }

  async function defaultBranch(projectRoot: string | null): Promise<string> {
    const cwd = projectRoot ?? repoRoot;
    try {
      const ref = await new Promise<string>((resolve, reject) => {
        execFile("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd }, (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout.trim());
        });
      });
      const branch = ref.replace(/^refs\/remotes\/origin\//, "");
      // Only use the origin/HEAD branch if a local ref actually exists for it,
      // so callers can use it as a base branch without error.
      if (branch && (await gitRefExists(branch, cwd))) return branch;
    } catch {
      // fall through
    }
    for (const candidate of ["main", "master"]) {
      if (await gitRefExists(candidate, cwd)) return candidate;
    }
    // Neither "main" nor "master" exists. Return the current branch so we
    // don't hand back a non-existent branch name as the default base.
    try {
      const current = await new Promise<string>((resolve, reject) => {
        execFile("git", ["symbolic-ref", "--short", "HEAD"], { cwd }, (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout.trim());
        });
      });
      if (current) return current;
    } catch {
      // HEAD is detached — fall through to branch enumeration.
    }
    // Detached HEAD with no main/master: return the first local branch found
    // so we never hand back a branch name that doesn't exist in this repo.
    // Use for-each-ref to enumerate actual refs rather than git-branch output
    // which can be ambiguous in detached HEAD state.
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(
          "git",
          ["for-each-ref", "refs/heads/", "--sort=-committerdate", "--format=%(refname:short)"],
          { cwd },
          (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout.trim());
          },
        );
      });
      const first = output.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
      if (first) return first;
    } catch {
      // ignore
    }
    return "main";
  }

  async function listBranches(projectRoot: string | null): Promise<BranchSummary[]> {
    const cwd = projectRoot ?? repoRoot;
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        [
          "for-each-ref",
          "refs/heads/",
          "refs/remotes/",
          "--sort=-committerdate",
          "--format=%(refname)%09%(refname:short)",
        ],
        { cwd },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        },
      );
    });
    const seen = new Set<string>();
    const branches: BranchSummary[] = [];
    for (const line of output.split("\n")) {
      const [fullRef, shortRef] = line.split("\t");
      const name = shortRef?.trim() ?? "";
      if (!name || seen.has(name) || fullRef?.trim().endsWith("/HEAD")) continue;
      if (!isBranchFormatLikelySafe(name)) continue;
      seen.add(name);
      branches.push({ name });
    }
    return branches;
  }

  async function createWorktreeFromHead(branch: string, templateRoot?: string): Promise<string> {
    if (!isBranchFormatLikelySafe(branch) || !(await gitBranchNameValid(branch, repoRoot))) {
      throw new Error("invalid branch name");
    }
    const wtPath = resolveWorktreePath(repoRoot, branch, templateRoot ?? getWorktreeTemplate());
    await fs.mkdir(path.dirname(wtPath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      execFile("git", ["worktree", "add", wtPath, "-b", branch], { cwd: repoRoot }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    refreshWorktreeCacheSync(repoRoot);
    return wtPath;
  }

  async function createWorktreeFromBase(options: {
    projectRoot?: string | null;
    branch: string;
    baseBranch?: string;
    refreshRemoteBase?: boolean;
  }): Promise<string> {
    const effectiveRepoRoot = options.projectRoot ?? repoRoot;
    const branch = options.branch.trim();
    const baseBranch = (options.baseBranch ?? defaultBaseBranch).trim();
    if (!isBranchFormatLikelySafe(branch) || !(await gitBranchNameValid(branch, effectiveRepoRoot))) {
      throw new Error("invalid branch name");
    }
    if (!isBranchFormatLikelySafe(baseBranch)) {
      throw new Error("invalid base branch");
    }
    if (options.refreshRemoteBase) {
      const separator = baseBranch.indexOf("/");
      const remote = separator > 0 ? baseBranch.slice(0, separator) : "";
      const remoteBranch = separator > 0 ? baseBranch.slice(separator + 1) : "";
      if (!/^[A-Za-z0-9._-]{1,80}$/.test(remote) ||
          !isBranchFormatLikelySafe(remoteBranch) ||
          !(await gitBranchNameValid(remoteBranch, effectiveRepoRoot))) {
        throw new Error("remote base branch must use <remote>/<branch>");
      }
      await new Promise<void>((resolve, reject) => {
        const refspec = `+refs/heads/${remoteBranch}:refs/remotes/${remote}/${remoteBranch}`;
        execFile("git", ["fetch", "--no-tags", remote, refspec], { cwd: effectiveRepoRoot }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
    if (!(await gitRefExists(`${baseBranch}^{commit}`, effectiveRepoRoot))) {
      throw new Error(`base branch not found: ${baseBranch}`);
    }
    const wtPath = resolveWorktreePath(effectiveRepoRoot, branch, getWorktreeTemplate());
    await fs.mkdir(path.dirname(wtPath), { recursive: true });
    const branchExists = await gitRefExists(`refs/heads/${branch}`, effectiveRepoRoot);
    if (branchExists) {
      await new Promise<void>((resolve, reject) => {
        execFile("git", ["worktree", "add", wtPath, branch], { cwd: effectiveRepoRoot }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } else {
      await new Promise<void>((resolve, reject) => {
        execFile("git", ["worktree", "add", "-b", branch, wtPath, baseBranch], { cwd: effectiveRepoRoot }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
    refreshWorktreeCacheSync(effectiveRepoRoot);
    return wtPath;
  }

  async function removeWorktree(wtPath: string): Promise<void> {
    const resolved = path.resolve(wtPath);
    const effectiveRoot = repoRootForWorktreePath(resolved);
    if (!effectiveRoot || !isKnownWorktree(resolved, effectiveRoot)) {
      throw new Error("path is not a known worktree");
    }
    const statusText = await new Promise<string>((resolve, reject) => {
      execFile("git", ["status", "--porcelain"], { cwd: resolved }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
    if (statusText.trim().length > 0) {
      await new Promise<void>((resolve, reject) => {
        execFile("git", ["worktree", "remove", "--force", resolved], { cwd: effectiveRoot }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } else {
      await new Promise<void>((resolve, reject) => {
        execFile("git", ["worktree", "remove", resolved], { cwd: effectiveRoot }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
    try {
      await new Promise<void>((resolve, reject) => {
        execFile("git", ["worktree", "prune"], { cwd: effectiveRoot }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } catch {
      // ignore prune failures
    }
    refreshWorktreeCacheSync(effectiveRoot);
  }

  async function directoryExists(rawPath: string): Promise<boolean> {
    const resolved = path.resolve(expandHomePath(rawPath));
    return await pathExistsAndIsDirectory(resolved);
  }

  function isKnownWorktreePath(rawPath: string): boolean {
    const resolved = path.resolve(expandHomePath(rawPath));
    // Check against the path's own repo, not just the server's (multi-repo).
    const effectiveRoot = gitRepoRootFromCwd(resolved);
    return effectiveRoot ? isKnownWorktree(resolved, effectiveRoot) : false;
  }

  function refreshCache(): void {
    refreshWorktreeCacheSync(repoRoot);
  }

  return {
    listWorktrees,
    listBranches,
    worktreeStatus,
    defaultBranch,
    resolveProjectRoot,
    createWorktreeFromBase,
    createWorktreeFromHead,
    removeWorktree,
    directoryExists,
    isKnownWorktreePath,
    refreshCache,
    getWorktreeTemplate,
    isBranchFormatLikelySafe,
    gitBranchNameValid,
    gitRefExists,
  };
}
