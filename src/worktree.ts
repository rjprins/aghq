import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

export const DEFAULT_WORKTREE_TEMPLATE = "../{repo-name}-{branch}";

export type WorktreeEntry = { path: string; branch: string };

const worktreeCache = new Map<string, WorktreeEntry[]>();
const worktreeCacheTime = new Map<string, number>();
const WORKTREE_CACHE_TTL_MS = 30_000;
const repoRootCache = new Map<string, string | null>();
const repoRootCacheTime = new Map<string, number>();
const branchCache = new Map<string, string | null>();
const branchCacheTime = new Map<string, number>();
const BRANCH_CACHE_TTL_MS = 10_000;

function execGitQuietSync(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Parse `git worktree list --porcelain` output into WorktreeEntry[].
 * Each block starts with `worktree <path>`, may have `branch refs/heads/<name>`,
 * separated by blank lines.
 */
export function parseWorktreeListPorcelain(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  const blocks = output.split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.length > 0);
    let entryPath = "";
    let branch = "";
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        entryPath = line.slice("worktree ".length);
      } else if (line.startsWith("branch refs/heads/")) {
        branch = line.slice("branch refs/heads/".length);
      }
    }
    if (entryPath) {
      entries.push({ path: entryPath, branch });
    }
  }
  return entries;
}

/**
 * Resolve a worktree path template against the repo root and branch name.
 */
export function resolveWorktreePath(repoRoot: string, branch: string, template: string): string {
  const sanitized = branch.replace(/[/\\ ]+/g, "-");
  const resolved = template
    .replace(/\{repo-name\}/g, path.basename(repoRoot))
    .replace(/\{repo-root\}/g, repoRoot)
    .replace(/\{branch\}/g, sanitized);
  return path.resolve(repoRoot, resolved);
}

/**
 * Refresh the worktree cache synchronously by running `git worktree list --porcelain`.
 */
export function refreshWorktreeCacheSync(repoRoot: string): void {
  const cacheKey = path.resolve(repoRoot);
  try {
    const output = execGitQuietSync(["worktree", "list", "--porcelain"], cacheKey);
    worktreeCache.set(cacheKey, parseWorktreeListPorcelain(output));
  } catch {
    worktreeCache.set(cacheKey, []);
  }
  worktreeCacheTime.set(cacheKey, Date.now());
}

/**
 * Get cached worktree list, refreshing if stale (>30s).
 */
export function getWorktreeCache(repoRoot: string): WorktreeEntry[] {
  const cacheKey = path.resolve(repoRoot);
  const updatedAt = worktreeCacheTime.get(cacheKey) ?? 0;
  if (Date.now() - updatedAt > WORKTREE_CACHE_TTL_MS) {
    refreshWorktreeCacheSync(cacheKey);
  }
  return worktreeCache.get(cacheKey) ?? [];
}

/**
 * Resolve the shared git repo root for an arbitrary cwd, including linked worktrees.
 * Returns null when cwd is not inside a git repository.
 */
export function gitRepoRootFromCwd(cwd: string | null): string | null {
  if (!cwd) return null;
  const cacheKey = path.resolve(cwd);
  const updatedAt = repoRootCacheTime.get(cacheKey) ?? 0;
  if (Date.now() - updatedAt <= WORKTREE_CACHE_TTL_MS && repoRootCache.has(cacheKey)) {
    return repoRootCache.get(cacheKey) ?? null;
  }
  try {
    const gitCommon = execGitQuietSync(["rev-parse", "--path-format=absolute", "--git-common-dir"], cacheKey).trim();
    const repoRoot = path.dirname(gitCommon);
    repoRootCache.set(cacheKey, repoRoot);
    repoRootCacheTime.set(cacheKey, Date.now());
    return repoRoot;
  } catch {
    repoRootCache.set(cacheKey, null);
    repoRootCacheTime.set(cacheKey, Date.now());
    return null;
  }
}

/**
 * Extract worktree branch/name from a cwd path by matching against cache.
 * Returns null for the main worktree or unrelated paths.
 */
export function worktreeFromCwd(cwd: string | null, repoRoot: string): string | null {
  if (!cwd) return null;
  const cache = getWorktreeCache(repoRoot);
  for (const entry of cache) {
    // Skip main worktree
    if (entry.path === repoRoot) continue;
    if (cwd === entry.path || cwd.startsWith(entry.path + "/")) {
      return entry.branch || path.basename(entry.path);
    }
  }
  return null;
}

/**
 * Given a cwd, return the project root. If cwd is in a known worktree,
 * return repoRoot. Otherwise return cwd itself.
 */
export function projectRootFromCwd(cwd: string | null, repoRoot: string): string | null {
  if (!cwd) return null;
  const cache = getWorktreeCache(repoRoot);
  for (const entry of cache) {
    if (entry.path === repoRoot) continue;
    if (cwd === entry.path || cwd.startsWith(entry.path + "/")) {
      return repoRoot;
    }
  }
  return cwd;
}

/**
 * Given a cwd, return the shared git repo root when inside any git repo/worktree.
 * For non-git directories, return cwd itself.
 */
export function projectRootFromCwdAny(cwd: string | null): string | null {
  if (!cwd) return null;
  return gitRepoRootFromCwd(cwd) ?? cwd;
}

/**
 * Extract worktree branch/name from a cwd by resolving its repo root automatically.
 * Returns null for main worktrees, unrelated paths, or non-git directories.
 */
export function worktreeFromCwdAny(cwd: string | null): string | null {
  if (!cwd) return null;
  const repoRoot = gitRepoRootFromCwd(cwd);
  if (!repoRoot) return null;
  return worktreeFromCwd(cwd, repoRoot);
}

/**
 * Resolve the branch actually checked out at `cwd` by reading git HEAD there.
 * Unlike worktreeFromCwd, this covers the main worktree too, so a session in
 * the primary checkout that was switched to a feature branch resolves to that
 * branch. Returns null for a detached HEAD or a non-git cwd. Cached per cwd
 * with a short TTL since it shells out to git.
 */
export function branchAtCwd(cwd: string | null): string | null {
  if (!cwd) return null;
  const cacheKey = path.resolve(cwd);
  const updatedAt = branchCacheTime.get(cacheKey) ?? 0;
  if (Date.now() - updatedAt <= BRANCH_CACHE_TTL_MS && branchCache.has(cacheKey)) {
    return branchCache.get(cacheKey) ?? null;
  }
  let branch: string | null = null;
  try {
    const out = execGitQuietSync(["symbolic-ref", "--short", "-q", "HEAD"], cacheKey).trim();
    branch = out.length > 0 ? out : null;
  } catch {
    branch = null; // detached HEAD or not a git repo
  }
  branchCache.set(cacheKey, branch);
  branchCacheTime.set(cacheKey, Date.now());
  return branch;
}

/**
 * Map an absolute file path to the branch of the worktree that contains it,
 * among `repoRoot`'s worktrees (longest-prefix match, main worktree included).
 * Returns null when the path is outside every worktree of that repo. Used to
 * tell which worktree an agent is *editing* when it differs from its cwd.
 */
export function branchForPathInRepo(filePath: string | null, repoRoot: string): string | null {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  const cache = getWorktreeCache(repoRoot);
  let best: WorktreeEntry | null = null;
  for (const entry of cache) {
    if (resolved === entry.path || resolved.startsWith(entry.path + "/")) {
      if (!best || entry.path.length > best.path.length) best = entry;
    }
  }
  return best?.branch ? best.branch : null;
}

/**
 * Check if a path matches any known worktree (excluding the main one).
 */
export function isKnownWorktree(checkPath: string, repoRoot: string): boolean {
  const resolved = path.resolve(checkPath);
  const cache = getWorktreeCache(repoRoot);
  for (const entry of cache) {
    if (entry.path === repoRoot) continue;
    if (resolved === entry.path) return true;
  }
  return false;
}

/**
 * Reset the cache (for testing).
 */
export function _resetCacheForTesting(): void {
  worktreeCache.clear();
  worktreeCacheTime.clear();
  repoRootCache.clear();
  repoRootCacheTime.clear();
  branchCache.clear();
  branchCacheTime.clear();
}

/**
 * Seed the branch-at-cwd cache directly (for testing).
 */
export function _setBranchCacheForTesting(cwd: string, branch: string | null): void {
  const cacheKey = path.resolve(cwd);
  branchCache.set(cacheKey, branch);
  branchCacheTime.set(cacheKey, Date.now());
}

/**
 * Set the cache directly (for testing).
 */
export function _setCacheForTesting(entries: WorktreeEntry[], repoRoot?: string): void {
  const cacheKey = path.resolve(repoRoot ?? entries[0]?.path ?? process.cwd());
  worktreeCache.set(cacheKey, entries);
  worktreeCacheTime.set(cacheKey, Date.now());
}
