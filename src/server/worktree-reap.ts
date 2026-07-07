import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { FastifyBaseLogger } from "fastify";

import type { SqliteStore } from "../persist/sqlite.js";
import { summarizeStatusV2 } from "../worktree-classify.js";
import { refreshWorktreeCacheSync } from "../worktree.js";
import {
  sanitizeBranchName,
  type BranchDropRequest,
  type BranchDropResult,
  type ReapRequest,
  type ReapResult,
} from "../shared/worktrees.js";

const execFileAsync = promisify(execFile);

/** Small gitignored files (e.g. .env) worth salvaging alongside tracked dirt. */
const IGNORED_SALVAGE_MAX_FILE_BYTES = 1024 * 1024;
const IGNORED_SALVAGE_MAX_FILES = 50;

/**
 * Paths currently inside the reap funnel. The scanner consults this so an
 * interleaved scan neither re-adopts a half-removed worktree nor writes an
 * "out-of-band" tombstone that would shadow the reap's own (which carries the
 * salvage/attic pointers).
 */
export const activeReapPaths = new Set<string>();

export type ReapServiceDeps = {
  store: SqliteStore;
  logger: FastifyBaseLogger;
  /** Attic root for salvage tarballs; defaults to ~/.local/share/agmux/attic. */
  atticDir?: string;
  /** Repo default branch resolver; falls back to origin/main|master when absent. */
  resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
};

async function git(args: string[], cwd: string, timeoutMs = 30_000): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function gitOk(args: string[], cwd: string, timeoutMs = 30_000): Promise<boolean> {
  try {
    await execFileAsync("git", args, { cwd, timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function repoRootOf(dir: string): Promise<string | null> {
  try {
    const out = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir);
    return path.dirname(out.trim());
  } catch {
    return null;
  }
}

async function duBytes(target: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("du", ["-sk", target], { timeout: 60_000 });
    const kb = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

function stamp(now: Date): { day: string; time: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    day: `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    time: `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
  };
}

function splitZ(raw: string): string[] {
  return raw.split("\0").filter((e) => e.trim().length > 0);
}

/**
 * Union of untracked, unstaged-modified, and staged non-ignored paths
 * (relative to wt) — including entries whose worktree file no longer exists
 * (staged-then-deleted: the staged blob still holds content worth saving).
 */
async function salvageablePaths(wtPath: string): Promise<string[]> {
  const set = new Set<string>();
  for (const entry of splitZ(await git(["ls-files", "--others", "--modified", "--exclude-standard", "-z"], wtPath))) {
    set.add(entry);
  }
  try {
    for (const entry of splitZ(await git(["diff", "--name-only", "--cached", "-z"], wtPath))) {
      set.add(entry);
    }
  } catch {
    // no HEAD yet (empty repo) — nothing staged-vs-HEAD to add
  }
  return [...set];
}

/** Small ignored files (not directories) worth including in the salvage. */
async function smallIgnoredFiles(wtPath: string, rawStatus: string): Promise<string[]> {
  const out: string[] = [];
  for (const line of rawStatus.split("\n")) {
    if (!line.startsWith("! ")) continue;
    const rel = line.slice(2);
    if (rel.endsWith("/")) continue; // directories (e.g. .venv/) are the bulk we exclude
    try {
      const st = await fsp.lstat(path.join(wtPath, rel));
      if (st.isFile() && st.size <= IGNORED_SALVAGE_MAX_FILE_BYTES) out.push(rel);
    } catch {
      // vanished — skip
    }
    if (out.length >= IGNORED_SALVAGE_MAX_FILES) break;
  }
  return out;
}

/**
 * Build the salvage in a staging directory: existing files are copied,
 * staged-but-deleted files are recovered from the index blob. Returns the
 * set of paths actually staged.
 */
async function stageSalvage(wtPath: string, files: string[], stageDir: string): Promise<Set<string>> {
  const staged = new Set<string>();
  for (const rel of files) {
    const src = path.join(wtPath, rel);
    const dst = path.join(stageDir, rel);
    try {
      const st = await fsp.lstat(src);
      if (st.isDirectory()) {
        // untracked directory entry — copy its whole tree
        await fsp.cp(src, dst, { recursive: true });
        staged.add(rel);
        continue;
      }
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.cp(src, dst, { verbatimSymlinks: true });
      staged.add(rel);
    } catch {
      // missing on disk — try the staged blob (staged-then-deleted case)
      try {
        const { stdout } = await execFileAsync("git", ["cat-file", "blob", `:${rel}`], {
          cwd: wtPath,
          timeout: 30_000,
          maxBuffer: 256 * 1024 * 1024,
          encoding: "buffer" as BufferEncoding,
        });
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.writeFile(dst, stdout);
        staged.add(rel);
      } catch {
        // no worktree file and no staged blob (e.g. unstaged deletion) — no content to save
      }
    }
  }
  return staged;
}

async function tarDirectory(stageDir: string, outFile: string): Promise<void> {
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const tar = spawn("tar", ["-czf", outFile, "-C", stageDir, "."]);
    let stderr = "";
    tar.stderr.on("data", (d) => (stderr += String(d)));
    tar.on("error", reject);
    tar.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

/** True when the worktree has any populated submodule (removal would nuke its object store). */
async function hasPopulatedSubmodule(wtPath: string): Promise<boolean> {
  try {
    const out = await git(["submodule", "status"], wtPath);
    // '-' prefix means uninitialized; anything else is populated.
    return out.split("\n").some((l) => l.trim().length > 0 && !l.startsWith("-"));
  } catch {
    return false;
  }
}

export function createReapService(deps: ReapServiceDeps) {
  const { store, logger } = deps;
  const atticRoot = deps.atticDir ?? path.join(os.homedir(), ".local", "share", "agmux", "attic");

  async function defaultBranchFor(repoRoot: string): Promise<string | null> {
    if (deps.resolveDefaultBranch) {
      try {
        return await deps.resolveDefaultBranch(repoRoot);
      } catch {
        // fall through to the static fallback
      }
    }
    for (const base of ["main", "master"]) {
      if (await gitOk(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`], repoRoot)) return base;
      if (await gitOk(["rev-parse", "--verify", "--quiet", `refs/heads/${base}`], repoRoot)) return base;
    }
    return null;
  }

  /** Create the attic tag; returns the tag name or null on unrecoverable failure. */
  async function writeAtticTag(opts: {
    repoRoot: string;
    branch: string;
    tipSha: string;
    evidence: string;
    salvagePath: string | null;
  }): Promise<string | null> {
    const { day, time } = stamp(new Date());
    const base = `attic/${sanitizeBranchName(opts.branch)}-${day}-${opts.tipSha.slice(0, 7)}`;
    const message = `reaped: ${opts.evidence}${opts.salvagePath ? `; salvage: ${opts.salvagePath}` : ""}`;
    for (const name of [base, `${base}-${time}`]) {
      // Same name pointing at the same commit is success (idempotent retry).
      try {
        const existing = (await git(["rev-parse", "--verify", "--quiet", `refs/tags/${name}^{commit}`], opts.repoRoot)).trim();
        if (existing === opts.tipSha) return name;
        continue; // name taken by a different commit — try suffixed name
      } catch {
        // tag absent — attempt creation
      }
      try {
        await git(["tag", "-a", name, opts.tipSha, "-m", message], opts.repoRoot);
        return name;
      } catch (err) {
        logger.warn({ err: String(err), tag: name }, "worktree-reap: attic tag creation failed");
      }
    }
    return null;
  }

  /**
   * The one deletion funnel. Strict order: fresh verify -> salvage (staging
   * dir) -> drift re-check -> remove -> attic tag -> branch CAS-delete ->
   * tombstone. Any drift aborts; aborts return ok:false and the caller
   * re-renders for the human to re-confirm.
   */
  async function reap(req: ReapRequest): Promise<ReapResult> {
    const wtPath = path.resolve(req.path);
    activeReapPaths.add(wtPath);
    try {
      return await reapInner(req, wtPath);
    } finally {
      activeReapPaths.delete(wtPath);
    }
  }

  async function reapInner(req: ReapRequest, wtPath: string): Promise<ReapResult> {
    const repoRoot = await repoRootOf(wtPath);
    if (!repoRoot) return { ok: false, reason: "not inside a git repository" };
    if (path.resolve(repoRoot) === wtPath) {
      return { ok: false, reason: "refusing to reap the primary worktree" };
    }

    // Membership check against a FRESH worktree list of the path's own repo.
    const porcelain = await git(["worktree", "list", "--porcelain"], repoRoot);
    if (!porcelain.split("\n").some((l) => l === `worktree ${wtPath}`)) {
      return { ok: false, reason: "path is not a linked worktree of its repository" };
    }

    // Guard 1: the human confirmed *this* state.
    let head: string;
    try {
      head = (await git(["rev-parse", "HEAD"], wtPath)).trim();
    } catch {
      return { ok: false, reason: "could not read HEAD in worktree" };
    }
    if (!req.expectedHead || head !== req.expectedHead) {
      return { ok: false, aborted: true, reason: `HEAD moved since preview (now ${head.slice(0, 7)})`, repoRoot };
    }

    // Guard 2: fresh status, never a memo.
    const rawStatus = await git(["status", "--porcelain=v2", "--ignored"], wtPath);
    const status = summarizeStatusV2(rawStatus);
    if (req.expectedStatusHash && req.expectedStatusHash !== status.statusHash) {
      return { ok: false, aborted: true, reason: "worktree contents changed since preview", repoRoot };
    }

    if (await hasPopulatedSubmodule(wtPath)) {
      return { ok: false, reason: "worktree contains populated submodules; remove manually", repoRoot };
    }

    const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], wtPath)).trim();
    const detached = branch === "HEAD";
    const row = store.getWorktreeRowByPath(repoRoot, wtPath);
    let detail: { evidence?: string; mergeSourceSha?: string | null; prStatus?: string | null } = {};
    if (row?.state_detail) {
      try {
        detail = JSON.parse(row.state_detail) ?? {};
      } catch {
        detail = {};
      }
    }
    const evidence = detail.evidence ?? "no classification recorded";

    // Price the tree BEFORE salvage so the salvage->remove window stays narrow.
    const freedBytes = (await duBytes(wtPath)) ?? 0;

    // Salvage: staged into a temp dir, so staged-but-deleted blobs are
    // recoverable and the final drift check can verify set inclusion. Runs for
    // ignored-only trees too — small ignored files (.env) deserve the net.
    let salvagePath: string | null = null;
    let stagedSet = new Set<string>();
    if (status.dirty || status.ignoredOnly) {
      const files = status.dirty ? await salvageablePaths(wtPath) : [];
      const ignoredRiders = await smallIgnoredFiles(wtPath, rawStatus);
      if (files.length > 0 || ignoredRiders.length > 0) {
        const { day, time } = stamp(new Date());
        const slug = sanitizeBranchName(detached ? path.basename(wtPath) : branch);
        const outFile = path.join(atticRoot, path.basename(repoRoot), `${slug}-${day}-${time}-${head.slice(0, 7)}.tar.gz`);
        const stageDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agmux-salvage-"));
        try {
          stagedSet = await stageSalvage(wtPath, files, stageDir);
          // Small ignored files (.env and friends) ride along; .venv-style dirs stay excluded.
          for (const rel of ignoredRiders) {
            const added = await stageSalvage(wtPath, [rel], stageDir);
            for (const a of added) stagedSet.add(a);
          }
          if (stagedSet.size > 0) {
            await tarDirectory(stageDir, outFile);
            const manifest = {
              branch: detached ? null : branch,
              head,
              sourcePath: wtPath,
              createdAt: new Date().toISOString(),
              files: [...stagedSet].sort(),
            };
            await fsp.writeFile(outFile.replace(/\.tar\.gz$/, ".manifest.json"), JSON.stringify(manifest, null, 2));
            salvagePath = outFile;
          }
        } catch (err) {
          return { ok: false, reason: `salvage failed, nothing was deleted: ${String(err)}`, repoRoot };
        } finally {
          await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    }

    // An abort after salvage means nothing was deleted — the tarball is
    // redundant and would pile up across retries.
    const dropSalvage = async (): Promise<void> => {
      if (!salvagePath) return;
      await fsp.rm(salvagePath, { force: true }).catch(() => {});
      await fsp.rm(salvagePath.replace(/\.tar\.gz$/, ".manifest.json"), { force: true }).catch(() => {});
      salvagePath = null;
    };

    // Guard 3: final drift check immediately before removal. ANY status drift
    // aborts — even after a successful salvage (new files would not be in it).
    const finalRaw = await git(["status", "--porcelain=v2", "--ignored"], wtPath);
    const finalStatus = summarizeStatusV2(finalRaw);
    if (finalStatus.statusHash !== status.statusHash) {
      await dropSalvage();
      return { ok: false, aborted: true, reason: "worktree changed during reap; nothing was deleted", repoRoot };
    }
    if (finalStatus.dirty) {
      // Belt and suspenders: everything salvageable now must be inside the salvage.
      const finalFiles = await salvageablePaths(wtPath);
      const unsaved = finalFiles.filter((f) => !stagedSet.has(f));
      if (unsaved.length > 0) {
        // Entries with no disk file and no staged blob have no content to lose.
        const losable: string[] = [];
        for (const rel of unsaved) {
          if (fs.existsSync(path.join(wtPath, rel))) losable.push(rel);
          else if (await gitOk(["cat-file", "-e", `:${rel}`], wtPath)) losable.push(rel);
        }
        if (losable.length > 0) {
          await dropSalvage();
          return {
            ok: false,
            aborted: true,
            reason: `unsalvaged changes present (${losable.slice(0, 3).join(", ")}${losable.length > 3 ? ", …" : ""}); nothing was deleted`,
            repoRoot,
          };
        }
      }
    }

    const needForce = finalStatus.dirty || finalStatus.ignoredOnly;
    try {
      const args = needForce ? ["worktree", "remove", "--force", wtPath] : ["worktree", "remove", wtPath];
      await git(args, repoRoot, 120_000);
    } catch (err) {
      return { ok: false, reason: `git worktree remove failed: ${String(err)}`, repoRoot, salvagePath };
    }

    // From here on the directory is gone: whatever happens, record the tombstone.
    let atticTag: string | null = null;
    let branchDeleted = false;
    let branchNote: string | undefined;
    try {
      if (!detached && req.deleteBranch !== "never") {
        const branchTip = (await git(["rev-parse", "--verify", `refs/heads/${branch}`], repoRoot)).trim();
        const upstreamGone = await branchUpstreamGone(repoRoot, branch);
        const neverPushed = !upstreamGone && !(await hasUpstreamOrOriginRef(repoRoot, branch));
        const mergeProven =
          upstreamGone ||
          detail.prStatus === "completed" ||
          (detail.mergeSourceSha != null && detail.mergeSourceSha === branchTip) ||
          (await ancestryMerged(repoRoot, branchTip));

        if (neverPushed && !mergeProven) {
          branchNote = "branch kept: never pushed";
        } else if (!mergeProven) {
          branchNote = "branch kept: merge not proven";
        } else {
          atticTag = await writeAtticTag({ repoRoot, branch, tipSha: branchTip, evidence, salvagePath });
          if (!atticTag) {
            branchNote = "branch kept: attic tag could not be written";
          } else {
            // CAS delete: fails if the ref moved after we tagged (concurrent commit).
            if (await gitOk(["update-ref", "-d", `refs/heads/${branch}`, branchTip], repoRoot)) {
              branchDeleted = true;
            } else {
              branchNote = "branch kept: ref moved during reap or git refused deletion";
            }
          }
        }
      }
    } catch (err) {
      branchNote = `branch step failed: ${String(err)}`;
      logger.warn({ err: String(err), branch }, "worktree-reap: branch step failed after removal");
    }

    store.tombstoneWorktree(repoRoot, wtPath, {
      state: row?.state ?? "unknown",
      reapEvidence: evidence,
      salvagePath,
      atticTag,
    });
    try {
      await git(["worktree", "prune"], repoRoot);
    } catch {
      // best-effort
    }
    refreshWorktreeCacheSync(repoRoot);

    logger.info({ path: wtPath, branch: detached ? null : branch, branchDeleted, salvagePath, atticTag }, "worktree-reap: reaped");
    return { ok: true, repoRoot, freedBytes, salvagePath, atticTag, branchDeleted, ...(branchNote ? { reason: branchNote } : {}) };
  }

  async function branchUpstreamGone(repoRoot: string, branch: string): Promise<boolean> {
    try {
      const out = await git(
        ["for-each-ref", `refs/heads/${branch}`, "--format=%(upstream:short)%09%(upstream:track)"],
        repoRoot,
      );
      const [upstream, track] = out.trim().split("\t");
      return !!upstream && (track ?? "").includes("[gone]");
    } catch {
      return false;
    }
  }

  async function hasUpstreamOrOriginRef(repoRoot: string, branch: string): Promise<boolean> {
    const hasUpstream = await gitOk(["config", "--get", `branch.${branch}.merge`], repoRoot);
    if (hasUpstream) return true;
    return gitOk(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], repoRoot);
  }

  async function ancestryMerged(repoRoot: string, sha: string): Promise<boolean> {
    const base = await defaultBranchFor(repoRoot);
    if (!base) return false;
    if (await gitOk(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`], repoRoot)) {
      return gitOk(["merge-base", "--is-ancestor", sha, `refs/remotes/origin/${base}`], repoRoot);
    }
    return false;
  }

  /** Funnel steps 4-5 for branches with no worktree: tag -> CAS delete -> record. */
  async function dropBranch(req: BranchDropRequest): Promise<BranchDropResult> {
    const repoRoot = path.resolve(req.repoRoot);
    const branch = req.branch.trim();
    if (!branch || branch.includes("..") || branch.startsWith("-")) {
      return { ok: false, reason: "invalid branch name" };
    }
    const defaultBranch = await defaultBranchFor(repoRoot);
    if (branch === "main" || branch === "master" || (defaultBranch != null && branch === defaultBranch)) {
      return { ok: false, reason: "refusing to drop the default branch" };
    }
    let tip: string;
    try {
      tip = (await git(["rev-parse", "--verify", `refs/heads/${branch}`], repoRoot)).trim();
    } catch {
      return { ok: false, reason: "branch does not exist" };
    }
    // git refuses to delete checked-out branches, but check explicitly for a clear message.
    const porcelain = await git(["worktree", "list", "--porcelain"], repoRoot);
    if (porcelain.split("\n").includes(`branch refs/heads/${branch}`)) {
      return { ok: false, reason: "branch is checked out in a worktree — reap the worktree instead" };
    }

    const gone = await branchUpstreamGone(repoRoot, branch);
    const merged = await ancestryMerged(repoRoot, tip);
    const evidence = gone ? "upstream gone" : merged ? "merged by ancestry" : "no merge evidence — tag preserves the tip";

    const atticTag = await writeAtticTag({ repoRoot, branch, tipSha: tip, evidence, salvagePath: null });
    if (!atticTag) return { ok: false, reason: "attic tag could not be written; branch kept" };

    // CAS delete so a commit landing between tag and delete keeps the branch.
    if (!(await gitOk(["update-ref", "-d", `refs/heads/${branch}`, tip], repoRoot))) {
      return { ok: false, reason: "git refused to delete the branch (ref moved?)", atticTag };
    }

    store.insertWorktreeTombstoneIfMissing({
      repoRoot,
      path: `branch:${branch}`,
      branch,
      reapEvidence: evidence,
      origin: "backfill",
      reapedAt: Date.now(),
    });
    logger.info({ repoRoot, branch, atticTag }, "worktree-reap: dropped orphan branch");
    return { ok: true, atticTag, deleted: true };
  }

  return { reap, dropBranch, atticRoot };
}

export type ReapService = ReturnType<typeof createReapService>;
