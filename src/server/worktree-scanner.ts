import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { FastifyBaseLogger } from "fastify";

import type { SqliteStore, WorktreeRow } from "../persist/sqlite.js";
import {
  classifyWorktree,
  parseForEachRefLine,
  parseWorktreeListPorcelainV2,
  summarizeStatusV2,
  type PorcelainWorktree,
  type RefInfo,
  type StatusSummary,
} from "../worktree-classify.js";
import { DEFAULT_WORKTREE_TEMPLATE, resolveWorktreePath } from "../worktree.js";
import {
  sanitizeBranchName,
  type OrphanBranch,
  type WorktreeAnnotated,
  type WorktreesFullResponse,
  type WorktreeTombstone,
} from "../shared/worktrees.js";

const execFileAsync = promisify(execFile);

const FETCH_PRUNE_MIN_INTERVAL_MS = 15 * 60 * 1000;
const TEMPLATE_CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_FRESH_MS = 5 * 60 * 1000;
const IGNORED_BYTES_DEMOTION_THRESHOLD = 500 * 1024 * 1024;

export type MergeProofLookup = (
  repoRoot: string,
  branch: string,
) => Promise<{
  prId: number;
  title: string;
  status: "completed" | "abandoned";
  mergeSourceSha: string | null;
  completedAt: number | null;
} | null>;

export type WorktreeScannerDeps = {
  store: SqliteStore;
  logger: FastifyBaseLogger;
  getLivePtyCwds: () => Promise<string[]>;
  getPrStateForBranch?: (repoRoot: string, branch: string) => { id: number; title: string; status: string } | null;
  lookupMergeProof?: MergeProofLookup;
  getWorktreeTemplate: () => string;
  resolveDefaultBranch: (projectRoot: string | null) => Promise<string>;
};

export type ScanOptions = {
  fetchPrune?: boolean;
  expensive?: boolean;
  /** Query the PR provider for merge proof on [gone] branches lacking a record. */
  verifyProofs?: boolean;
};

type StateDetail = {
  evidence?: string;
  overlays?: unknown;
  head?: string | null;
  statusHash?: string | null;
  lastActivityAt?: number | null;
  lastCommitAt?: number | null;
  prStatus?: string | null;
  mergeSourceSha?: string | null;
  prCompletedAt?: number | null;
  diskBytes?: number | null;
  ignoredBytes?: number | null;
  stack?: string | null;
};

function parseStateDetail(row: WorktreeRow | undefined): StateDetail {
  if (!row?.state_detail) return {};
  try {
    const parsed = JSON.parse(row.state_detail);
    return parsed && typeof parsed === "object" ? (parsed as StateDetail) : {};
  } catch {
    return {};
  }
}

function parsePriorPaths(row: WorktreeRow | undefined): string[] {
  if (!row?.prior_paths) return [];
  try {
    const parsed = JSON.parse(row.prior_paths);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

async function git(args: string[], cwd: string, timeoutMs = 15_000): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

async function gitOk(args: string[], cwd: string, timeoutMs = 15_000): Promise<boolean> {
  try {
    await execFileAsync("git", args, { cwd, timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function duBytes(target: string, timeoutMs = 60_000): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("du", ["-sk", target], { timeout: timeoutMs });
    const kb = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

/** Extract `! <path>` entries (ignored) from raw porcelain-v2 status output. */
function ignoredEntriesFromStatus(raw: string): string[] {
  const entries: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("! ")) entries.push(line.slice(2));
  }
  return entries;
}

/** Ticket id from a `<ticket>-<slug>` branch prefix (5-6 digit Azure ids). */
function ticketFromBranch(branch: string): string | null {
  const m = /^(\d{5,6})-/.exec(branch);
  return m ? m[1] : null;
}

/** Stack base: strip a `NN` segment and what follows, e.g. feat/flex-app-00-backend -> feat/flex-app. */
function stackBase(branch: string): string | null {
  const m = /^(.*?)[-_/](\d{2,})(?:[-_/].*)?$/.exec(branch);
  if (!m || !m[1]) return null;
  return m[1];
}

export function createWorktreeScanner(deps: WorktreeScannerDeps) {
  const { store, logger } = deps;

  const inFlight = new Map<string, Promise<WorktreesFullResponse>>();
  const lastFetchPruneAt = new Map<string, number>();
  const lastScan = new Map<string, WorktreesFullResponse>();
  const templateCache = new Map<string, { value: string; at: number }>();
  let sweepTimer: NodeJS.Timeout | null = null;

  async function repoTemplate(repoRoot: string): Promise<string> {
    const cached = templateCache.get(repoRoot);
    if (cached && Date.now() - cached.at < TEMPLATE_CACHE_TTL_MS) return cached.value;
    let value = "";
    try {
      value = (await git(["config", "--get", "agmux.worktreeTemplate"], repoRoot)).trim();
    } catch {
      value = "";
    }
    if (!value) value = deps.getWorktreeTemplate() || DEFAULT_WORKTREE_TEMPLATE;
    templateCache.set(repoRoot, { value, at: Date.now() });
    return value;
  }

  async function maybeFetchPrune(repoRoot: string): Promise<void> {
    const last = lastFetchPruneAt.get(repoRoot) ?? 0;
    if (Date.now() - last < FETCH_PRUNE_MIN_INTERVAL_MS) return;
    lastFetchPruneAt.set(repoRoot, Date.now());
    try {
      await git(["fetch", "--prune", "origin"], repoRoot, 120_000);
    } catch (err) {
      logger.debug({ err: String(err), repoRoot }, "worktree-scanner: fetch --prune failed");
    }
  }

  async function scan(repoRoot: string, opts: ScanOptions = {}): Promise<WorktreesFullResponse> {
    const key = path.resolve(repoRoot);
    const existing = inFlight.get(key);
    if (existing) return existing;
    const run = doScan(key, opts).finally(() => inFlight.delete(key));
    inFlight.set(key, run);
    return run;
  }

  async function doScan(repoRoot: string, opts: ScanOptions): Promise<WorktreesFullResponse> {
    const now = Date.now();
    if (opts.fetchPrune) await maybeFetchPrune(repoRoot);

    const porcelain = await git(["worktree", "list", "--porcelain"], repoRoot);
    const entries = parseWorktreeListPorcelainV2(porcelain);

    // One for-each-ref pass over local heads; one over origin remotes (never-pushed check).
    const refInfo = new Map<string, RefInfo>();
    try {
      const refOut = await git(
        [
          "for-each-ref",
          "refs/heads/",
          "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(committerdate:unix)%09%(objectname)",
        ],
        repoRoot,
      );
      for (const line of refOut.split("\n")) {
        const info = parseForEachRefLine(line);
        if (info) refInfo.set(info.branch, info);
      }
    } catch (err) {
      logger.debug({ err: String(err), repoRoot }, "worktree-scanner: for-each-ref failed");
    }
    const originBranches = new Set<string>();
    try {
      const remoteOut = await git(["for-each-ref", "refs/remotes/origin/", "--format=%(refname:short)"], repoRoot);
      for (const line of remoteOut.split("\n")) {
        const name = line.trim().replace(/^origin\//, "");
        if (name && name !== "HEAD") originBranches.add(name);
      }
    } catch {
      // remoteless repo — fine, never-pushed detection degrades below
    }

    const defaultBranch = await deps.resolveDefaultBranch(repoRoot);
    const originDefaultExists = await gitOk(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${defaultBranch}`], repoRoot);
    const template = await repoTemplate(repoRoot);
    const liveCwds = await deps.getLivePtyCwds();

    const rows = store.listWorktreeRows(repoRoot, { includeTombstones: true });
    const liveRows = rows.filter((r) => r.reaped_at == null);
    const rowsByPath = new Map(liveRows.map((r) => [r.path, r]));

    // Stack detection over branch names present as worktrees.
    const baseCounts = new Map<string, number>();
    for (const e of entries) {
      const base = e.branch ? stackBase(e.branch) : null;
      if (base) baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
    }

    const annotated: WorktreeAnnotated[] = [];
    for (const wt of entries) {
      try {
        annotated.push(await annotateOne(wt, repoRoot, { refInfo, originBranches, defaultBranch, originDefaultExists, template, liveCwds, rowsByPath, baseCounts, now, opts }));
      } catch (err) {
        logger.warn({ err: String(err), path: wt.path }, "worktree-scanner: annotate failed");
      }
    }

    // Healing/adoption bookkeeping: rows whose dir vanished from git's list.
    const gitPaths = new Set(entries.map((e) => e.path));
    for (const row of liveRows) {
      if (gitPaths.has(row.path)) continue;
      const healed = entries.find((e) => {
        if (!e.branch || e.branch !== row.branch) return false;
        const detail = parseStateDetail(row);
        return !!detail.head && !!e.head && detail.head === e.head && !rowsByPath.has(e.path);
      });
      if (healed) {
        store.moveWorktreePath(repoRoot, row.path, healed.path);
        logger.info({ from: row.path, to: healed.path }, "worktree-scanner: healed out-of-band move");
      } else {
        store.tombstoneWorktree(repoRoot, row.path, {
          state: row.state,
          reapEvidence: "removed out-of-band",
          salvagePath: null,
          atticTag: null,
        });
      }
    }

    // Orphan branches: local heads with no worktree.
    const wtBranches = new Set(entries.map((e) => e.branch).filter(Boolean));
    const orphanBranches: OrphanBranch[] = [];
    for (const [branch, info] of refInfo) {
      if (wtBranches.has(branch)) continue;
      let mergedIntoDefault = false;
      if (originDefaultExists) {
        mergedIntoDefault = await gitOk(["merge-base", "--is-ancestor", info.head, `refs/remotes/origin/${defaultBranch}`], repoRoot);
      }
      orphanBranches.push({
        branch,
        head: info.head,
        lastCommitAt: info.lastCommitAt,
        upstreamGone: info.upstreamGone,
        neverPushed: !info.upstream && !originBranches.has(branch),
        mergedIntoDefault,
      });
    }
    orphanBranches.sort((a, b) => (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0));

    const tombstones: WorktreeTombstone[] = store
      .listWorktreeRows(repoRoot, { includeTombstones: true })
      .filter((r) => r.reaped_at != null)
      .map((r) => ({
        path: r.path,
        branch: r.branch,
        label: r.label,
        ticketId: r.ticket_id,
        prTitle: r.pr_title,
        firstPrompt: r.first_prompt,
        reapedAt: r.reaped_at as number,
        reapEvidence: r.reap_evidence,
        salvagePath: r.salvage_path,
        atticTag: r.attic_tag,
      }))
      .sort((a, b) => b.reapedAt - a.reapedAt);

    const response: WorktreesFullResponse = {
      repoRoot,
      worktrees: annotated,
      orphanBranches,
      tombstones,
      defaultBranch,
      scannedAt: now,
    };
    lastScan.set(repoRoot, response);
    return response;
  }

  async function annotateOne(
    wt: PorcelainWorktree,
    repoRoot: string,
    ctx: {
      refInfo: Map<string, RefInfo>;
      originBranches: Set<string>;
      defaultBranch: string;
      originDefaultExists: boolean;
      template: string;
      liveCwds: string[];
      rowsByPath: Map<string, WorktreeRow>;
      baseCounts: Map<string, number>;
      now: number;
      opts: ScanOptions;
    },
  ): Promise<WorktreeAnnotated> {
    const isPrimary = path.resolve(wt.path) === path.resolve(repoRoot);
    const row = ctx.rowsByPath.get(wt.path);
    const priorDetail = parseStateDetail(row);
    const ref = wt.branch ? (ctx.refInfo.get(wt.branch) ?? null) : null;

    let status: StatusSummary | null = null;
    let rawStatus = "";
    if (!wt.prunable && fs.existsSync(wt.path)) {
      try {
        rawStatus = await git(["status", "--porcelain=v2", "--ignored"], wt.path, 30_000);
        status = summarizeStatusV2(rawStatus);
      } catch {
        status = null;
      }
    }

    // HEAD-reflog activity catches checkouts/rebases even without sessions.
    let reflogAt: number | null = null;
    try {
      const out = await git(["log", "-g", "-1", "--format=%ct", "HEAD"], wt.path);
      const sec = Number.parseInt(out.trim(), 10);
      reflogAt = Number.isFinite(sec) ? sec * 1000 : null;
    } catch {
      reflogAt = null;
    }

    let lastCommitAt = ref?.lastCommitAt ?? null;
    if (lastCommitAt == null && wt.head) {
      try {
        const out = await git(["log", "-1", "--format=%ct", wt.head], repoRoot);
        const sec = Number.parseInt(out.trim(), 10);
        lastCommitAt = Number.isFinite(sec) ? sec * 1000 : null;
      } catch {
        lastCommitAt = null;
      }
    }

    let unpushedCount: number | null = null;
    if (ref?.upstream && !ref.upstreamGone) {
      try {
        const out = await git(["rev-list", "--count", "@{u}..HEAD"], wt.path);
        const n = Number.parseInt(out.trim(), 10);
        unpushedCount = Number.isFinite(n) ? n : null;
      } catch {
        unpushedCount = null;
      }
    }

    let hasUnmergedCommits: boolean | null = null;
    let ancestryMerged: boolean | null = null;
    if (ctx.originDefaultExists && wt.branch) {
      try {
        const out = await git(["rev-list", "--count", `refs/remotes/origin/${ctx.defaultBranch}..refs/heads/${wt.branch}`], repoRoot);
        const n = Number.parseInt(out.trim(), 10);
        hasUnmergedCommits = Number.isFinite(n) ? n > 0 : null;
      } catch {
        hasUnmergedCommits = null;
      }
      if (wt.head) {
        ancestryMerged = await gitOk(["merge-base", "--is-ancestor", wt.head, `refs/remotes/origin/${ctx.defaultBranch}`], repoRoot);
      }
    }

    const neverPushed = !!wt.branch && !ref?.upstream && !ctx.originBranches.has(wt.branch);

    const candidatePaths = [wt.path, ...parsePriorPaths(row)];
    const sessionCtx = store.agentSessionContextForPath(candidatePaths);
    const liveSessionCount = ctx.liveCwds.filter((c) => c === wt.path || c.startsWith(wt.path + "/")).length;

    // Merge proof: persisted row first, then live poller state, then on-demand lookup.
    let prStatus = priorDetail.prStatus ?? null;
    let prId = row?.pr_id ?? null;
    let prTitle = row?.pr_title ?? null;
    let mergeSourceSha = priorDetail.mergeSourceSha ?? null;
    let prCompletedAt = priorDetail.prCompletedAt ?? null;
    if (wt.branch && deps.getPrStateForBranch) {
      const live = deps.getPrStateForBranch(repoRoot, wt.branch);
      if (live) {
        prStatus = live.status ?? "active";
        prId = String(live.id);
        prTitle = live.title;
      }
    }
    if (wt.branch && ref?.upstreamGone && !mergeSourceSha && !prStatus && ctx.opts.verifyProofs && deps.lookupMergeProof) {
      try {
        const proof = await deps.lookupMergeProof(repoRoot, wt.branch);
        if (proof) {
          prStatus = proof.status;
          prId = String(proof.prId);
          prTitle = proof.title;
          mergeSourceSha = proof.mergeSourceSha;
          prCompletedAt = proof.completedAt;
          store.setWorktreePrProofByBranch(repoRoot, wt.branch, {
            prId: String(proof.prId),
            prTitle: proof.title,
            prStatus: proof.status,
            mergeSourceSha: proof.mergeSourceSha,
            prCompletedAt: proof.completedAt,
          });
        }
      } catch (err) {
        logger.debug({ err: String(err), branch: wt.branch }, "worktree-scanner: merge-proof lookup failed");
      }
    }

    const templatePath = wt.branch ? resolveWorktreePath(repoRoot, wt.branch, ctx.template) : null;
    const lastSessionActivityAt = sessionCtx.lastSeenAt;

    const classifyInput = {
      wt,
      ref,
      status,
      isPrimary,
      liveSessionCount,
      lastSessionActivityAt: lastSessionActivityAt == null && reflogAt != null ? reflogAt : lastSessionActivityAt,
      neverPushed,
      hasUnmergedCommits,
      ancestryMerged,
      prStatus,
      prId,
      prCompletedAt,
      mergeSourceSha,
      unpushedCount,
      ignoredBytes: priorDetail.ignoredBytes ?? null,
      templatePath,
      now: ctx.now,
    };
    let result = classifyWorktree(classifyInput);

    // Ignored-payload guard (F2): before anything can look reapable, price the
    // gitignored data that a removal would destroy — big payloads demote.
    let ignoredBytes = priorDetail.ignoredBytes ?? null;
    let diskBytes = priorDetail.diskBytes ?? null;
    const needIgnoredBytes = result.reapClass !== null || ctx.opts.expensive;
    if (needIgnoredBytes && rawStatus) {
      const ignoredEntries = ignoredEntriesFromStatus(rawStatus).slice(0, 30);
      if (ignoredEntries.length > 0) {
        let total = 0;
        for (const entry of ignoredEntries) {
          const b = await duBytes(path.join(wt.path, entry));
          if (b != null) total += b;
        }
        ignoredBytes = total;
      } else {
        ignoredBytes = 0;
      }
      result = classifyWorktree({ ...classifyInput, ignoredBytes });
    }
    if (ctx.opts.expensive || result.reapClass !== null) {
      diskBytes = (await duBytes(wt.path)) ?? diskBytes;
    }

    const lastActivityAt = Math.max(reflogAt ?? 0, lastSessionActivityAt ?? 0, lastCommitAt ?? 0) || null;
    const base = wt.branch ? stackBase(wt.branch) : null;
    const stack = base && (ctx.baseCounts.get(base) ?? 0) >= 3 ? path.basename(base) : null;

    const detail: StateDetail = {
      evidence: result.evidence,
      overlays: result.overlays,
      head: wt.head,
      statusHash: status?.statusHash ?? null,
      lastActivityAt,
      lastCommitAt,
      prStatus,
      mergeSourceSha,
      prCompletedAt,
      diskBytes,
      ignoredBytes,
      stack,
    };
    store.upsertWorktreeObservation({
      repoRoot,
      path: wt.path,
      branch: wt.branch || null,
      state: result.state,
      stateDetail: detail,
      scannedAt: ctx.now,
      origin: wt.path.includes("/.claude/worktrees/") ? "claude-code" : "oob",
    });

    // Backfill recovered context once; user edits win afterwards.
    const meta: { firstPrompt?: string; ticketId?: string } = {};
    if (!row?.first_prompt && sessionCtx.earliestName) meta.firstPrompt = sessionCtx.earliestName;
    if (!row?.ticket_id && wt.branch) {
      const ticket = ticketFromBranch(wt.branch);
      if (ticket) meta.ticketId = ticket;
    }
    if (Object.keys(meta).length > 0) store.setWorktreeMeta(repoRoot, wt.path, meta);

    return {
      name: wt.branch || path.basename(wt.path),
      path: wt.path,
      branch: wt.branch,
      head: wt.head,
      detached: wt.detached,
      isPrimary,
      state: result.state,
      reapClass: result.reapClass,
      evidence: result.evidence,
      statusHash: status?.statusHash ?? null,
      overlays: result.overlays,
      lastActivityAt,
      lastCommitAt,
      label: row?.label ?? null,
      ticketId: row?.ticket_id ?? meta.ticketId ?? null,
      prId,
      prTitle,
      prStatus,
      firstPrompt: row?.first_prompt ?? meta.firstPrompt ?? null,
      origin: row?.origin ?? null,
      stack,
      diskBytes,
      ignoredBytes,
      sessionCount: sessionCtx.sessionCount,
      liveSessionCount,
    };
  }

  function getCached(repoRoot: string): WorktreesFullResponse | null {
    return lastScan.get(path.resolve(repoRoot)) ?? null;
  }

  /** Serve a recent scan when fresh enough; otherwise scan (no prune). */
  async function getFullFresh(repoRoot: string): Promise<WorktreesFullResponse> {
    const cached = getCached(repoRoot);
    if (cached && Date.now() - cached.scannedAt < CACHE_FRESH_MS) return cached;
    return scan(repoRoot);
  }

  function notifyPrResolved(info: {
    repoRoot: string;
    branch: string;
    prId: number;
    title: string;
    status: "completed" | "abandoned";
    mergeSourceSha: string | null;
    completedAt: number | null;
  }): void {
    store.setWorktreePrProofByBranch(info.repoRoot, info.branch, {
      prId: String(info.prId),
      prTitle: info.title,
      prStatus: info.status,
      mergeSourceSha: info.mergeSourceSha,
      prCompletedAt: info.completedAt,
    });
    // Targeted rescan so the landed pill / reap badge appears promptly.
    void scan(info.repoRoot).catch((err) =>
      logger.debug({ err: String(err), repoRoot: info.repoRoot }, "worktree-scanner: post-resolution rescan failed"),
    );
  }

  async function knownRepoRoots(): Promise<string[]> {
    const roots = new Set<string>();
    for (const cwd of await deps.getLivePtyCwds()) {
      try {
        const out = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
        roots.add(path.dirname(out.trim()));
      } catch {
        // not a git dir
      }
    }
    for (const root of store.listWorktreeRepoRoots()) roots.add(root);
    return [...roots];
  }

  function startSweep(intervalMs = 24 * 60 * 60 * 1000): void {
    if (sweepTimer) return;
    const run = async () => {
      for (const root of await knownRepoRoots()) {
        try {
          await scan(root, { fetchPrune: true, verifyProofs: true });
        } catch (err) {
          logger.debug({ err: String(err), root }, "worktree-scanner: sweep scan failed");
        }
      }
    };
    sweepTimer = setInterval(() => void run(), intervalMs);
    sweepTimer.unref?.();
  }

  function stopSweep(): void {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
  }

  /** Tombstone worktrees that only exist in session history (deleted before agmux tracked them). */
  async function backfillTombstones(repoRoot: string): Promise<number> {
    const template = await repoTemplate(repoRoot);
    const templateParent = path.dirname(resolveWorktreePath(repoRoot, "x", template));
    const repoParent = path.dirname(repoRoot);
    let inserted = 0;
    for (const rec of store.listAgentSessionCwds()) {
      const cwd = rec.cwd;
      if (!cwd || cwd === repoRoot) continue;
      const parent = path.dirname(cwd);
      if (parent !== templateParent && parent !== repoParent) continue;
      if (fs.existsSync(cwd)) continue;
      const ok = store.insertWorktreeTombstoneIfMissing({
        repoRoot,
        path: cwd,
        branch: null,
        firstPrompt: rec.earliestName,
        reapEvidence: "discovered from session history",
        origin: "backfill",
        reapedAt: rec.lastSeenAt ?? Date.now(),
      });
      if (ok) inserted += 1;
    }
    return inserted;
  }

  return {
    scan,
    getCached,
    getFullFresh,
    notifyPrResolved,
    startSweep,
    stopSweep,
    backfillTombstones,
    /** Exposed for the reap route: demotion threshold shared with classify. */
    IGNORED_BYTES_DEMOTION_THRESHOLD,
  };
}

export type WorktreeScanner = ReturnType<typeof createWorktreeScanner>;
