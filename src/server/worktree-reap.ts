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

export type ReapServiceDeps = {
  store: SqliteStore;
  logger: FastifyBaseLogger;
  /** Attic root for salvage tarballs; defaults to ~/.local/share/agmux/attic. */
  atticDir?: string;
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

/** Union of untracked, unstaged-modified, and staged non-ignored paths (relative to wt). */
async function salvageablePaths(wtPath: string): Promise<string[]> {
  const set = new Set<string>();
  const collectZ = (raw: string) => {
    for (const entry of raw.split("\0")) {
      if (entry.trim().length > 0) set.add(entry);
    }
  };
  collectZ(await git(["ls-files", "--others", "--modified", "--exclude-standard", "-z"], wtPath));
  try {
    collectZ(await git(["diff", "--name-only", "--cached", "-z"], wtPath));
  } catch {
    // no HEAD yet (empty repo) — nothing staged-vs-HEAD to add
  }
  // tar can only archive paths that still exist (deletions carry no content anyway).
  return [...set].filter((p) => fs.existsSync(path.join(wtPath, p)));
}

async function writeSalvageTarball(opts: {
  wtPath: string;
  files: string[];
  outFile: string;
}): Promise<void> {
  await fsp.mkdir(path.dirname(opts.outFile), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const tar = spawn("tar", ["--null", "-czf", opts.outFile, "-T", "-"], { cwd: opts.wtPath });
    let stderr = "";
    tar.stderr.on("data", (d) => (stderr += String(d)));
    tar.on("error", reject);
    tar.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${stderr.slice(0, 500)}`));
    });
    tar.stdin.write(opts.files.join("\0") + "\0");
    tar.stdin.end();
  });
}

export function createReapService(deps: ReapServiceDeps) {
  const { store, logger } = deps;
  const atticRoot = deps.atticDir ?? path.join(os.homedir(), ".local", "share", "agmux", "attic");

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
   * The one deletion funnel. Strict order: fresh verify -> salvage -> remove ->
   * attic tag -> branch policy -> tombstone. Aborts return ok:false with a reason;
   * the caller re-renders and the human re-confirms.
   */
  async function reap(req: ReapRequest): Promise<ReapResult> {
    const wtPath = path.resolve(req.path);
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
      return { ok: false, aborted: true, reason: `HEAD moved since preview (now ${head.slice(0, 7)})` };
    }

    // Guard 2: fresh status, never a memo.
    const rawStatus = await git(["status", "--porcelain=v2", "--ignored"], wtPath);
    const status = summarizeStatusV2(rawStatus);
    if (req.expectedStatusHash && req.expectedStatusHash !== status.statusHash) {
      return { ok: false, aborted: true, reason: "worktree contents changed since preview" };
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

    // Salvage: forced whenever non-ignored dirt exists (salvage:false is not honored then).
    let salvagePath: string | null = null;
    if (status.dirty) {
      const files = await salvageablePaths(wtPath);
      if (files.length > 0) {
        const { day, time } = stamp(new Date());
        const slug = sanitizeBranchName(detached ? path.basename(wtPath) : branch);
        const outFile = path.join(atticRoot, path.basename(repoRoot), `${slug}-${day}-${time}-${head.slice(0, 7)}.tar.gz`);
        try {
          await writeSalvageTarball({ wtPath, files, outFile });
          const manifest = {
            branch: detached ? null : branch,
            head,
            sourcePath: wtPath,
            createdAt: new Date().toISOString(),
            files,
          };
          await fsp.writeFile(outFile.replace(/\.tar\.gz$/, ".manifest.json"), JSON.stringify(manifest, null, 2));
          salvagePath = outFile;
        } catch (err) {
          return { ok: false, reason: `salvage failed, nothing was deleted: ${String(err)}` };
        }
      }
    }

    const freedBytes = (await duBytes(wtPath)) ?? 0;

    // Guard 3: last porcelain re-read immediately before removal; --force only
    // when the dirt is gitignored-only or everything non-ignored was just tarred.
    const finalRaw = await git(["status", "--porcelain=v2", "--ignored"], wtPath);
    const finalStatus = summarizeStatusV2(finalRaw);
    if (finalStatus.statusHash !== status.statusHash && finalStatus.dirty && !salvagePath) {
      return { ok: false, aborted: true, reason: "worktree changed during reap; nothing was deleted" };
    }
    const needForce = finalStatus.dirty || finalStatus.ignoredOnly;
    if (finalStatus.dirty && !salvagePath) {
      // dirty but salvage produced nothing archivable (e.g. only deletions): allow, git has nothing to save
      const files = await salvageablePaths(wtPath);
      if (files.length > 0) {
        return { ok: false, reason: "non-ignored changes present but not salvaged; refusing to remove" };
      }
    }
    try {
      const args = needForce ? ["worktree", "remove", "--force", wtPath] : ["worktree", "remove", wtPath];
      await git(args, repoRoot, 120_000);
    } catch (err) {
      return { ok: false, reason: `git worktree remove failed: ${String(err)}`, salvagePath };
    }

    // Branch policy (skipped for detached checkouts — nothing to tag or delete).
    let atticTag: string | null = null;
    let branchDeleted = false;
    let branchNote: string | undefined;
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
          if (await gitOk(["branch", "-d", branch], repoRoot)) {
            branchDeleted = true;
          } else if (await gitOk(["branch", "-D", branch], repoRoot)) {
            // -D justified: the attic tag pins the tip.
            branchDeleted = true;
          } else {
            branchNote = "branch kept: git refused deletion (checked out elsewhere?)";
          }
        }
      }
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
    return { ok: true, freedBytes, salvagePath, atticTag, branchDeleted, ...(branchNote ? { reason: branchNote } : {}) };
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
    for (const base of ["main", "master"]) {
      if (await gitOk(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`], repoRoot)) {
        return gitOk(["merge-base", "--is-ancestor", sha, `refs/remotes/origin/${base}`], repoRoot);
      }
    }
    return false;
  }

  /** Funnel steps 4-5 for branches with no worktree: tag -> delete -> record. */
  async function dropBranch(req: BranchDropRequest): Promise<BranchDropResult> {
    const repoRoot = path.resolve(req.repoRoot);
    const branch = req.branch.trim();
    if (!branch || branch.includes("..") || branch.startsWith("-")) {
      return { ok: false, reason: "invalid branch name" };
    }
    if (branch === "main" || branch === "master") {
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
    if (porcelain.includes(`branch refs/heads/${branch}\n`) || porcelain.endsWith(`branch refs/heads/${branch}`)) {
      return { ok: false, reason: "branch is checked out in a worktree — reap the worktree instead" };
    }

    const gone = await branchUpstreamGone(repoRoot, branch);
    const merged = await ancestryMerged(repoRoot, tip);
    const evidence = gone ? "upstream gone" : merged ? "merged by ancestry" : "no merge evidence — tag preserves the tip";

    const atticTag = await writeAtticTag({ repoRoot, branch, tipSha: tip, evidence, salvagePath: null });
    if (!atticTag) return { ok: false, reason: "attic tag could not be written; branch kept" };

    let deleted = false;
    if (await gitOk(["branch", "-d", branch], repoRoot)) {
      deleted = true;
    } else if (await gitOk(["branch", "-D", branch], repoRoot)) {
      deleted = true;
    }
    if (!deleted) return { ok: false, reason: "git refused to delete the branch", atticTag };

    store.insertWorktreeTombstoneIfMissing({
      repoRoot,
      path: `branch:${branch}`,
      branch,
      reapEvidence: evidence,
      origin: "backfill",
      reapedAt: Date.now(),
    });
    logger.info({ repoRoot, branch, atticTag }, "worktree-reap: dropped orphan branch");
    return { ok: true, atticTag, deleted };
  }

  return { reap, dropBranch, atticRoot };
}

export type ReapService = ReturnType<typeof createReapService>;
