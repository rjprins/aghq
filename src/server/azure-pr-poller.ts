import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyBaseLogger } from "fastify";

import type { PtySummary } from "../types.js";
import type { SqliteStore } from "../persist/sqlite.js";
import { branchAtCwd, getWorktreeCache } from "../worktree.js";
import {
  buildPrSummary,
  getCompletedPrForBranch,
  getCurrentUser,
  getPrById,
  getPrThreadsSummary,
  listMyActivePRs,
  parseAzureRemote,
  type AzureRepoRef,
  type PrComment,
} from "./azure-pr.js";

const execFileAsync = promisify(execFile);

// repoRoot -> Azure ref (or null if not an Azure remote); avoids re-shelling git.
const remoteCache = new Map<string, AzureRepoRef | null>();

async function azureRefForRepo(repoRoot: string): Promise<AzureRepoRef | null> {
  if (remoteCache.has(repoRoot)) return remoteCache.get(repoRoot) ?? null;
  let ref: AzureRepoRef | null = null;
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, "remote", "get-url", "origin"], { timeout: 10_000 });
    ref = parseAzureRemote(stdout.trim());
  } catch {
    ref = null;
  }
  remoteCache.set(repoRoot, ref);
  return ref;
}

/** Durable record of a PR's completion, enough to detect post-merge commits offline. */
export type MergeProof = {
  repoRoot: string;
  branch: string;
  prId: number;
  title: string;
  status: "completed" | "abandoned";
  /** Azure's lastMergeSourceCommit — the exact commit the squash was cut from. */
  mergeSourceSha: string | null;
  /** epoch ms of the PR's closedDate. */
  completedAt: number | null;
};

// Bracketed-paste wrappers so multi-line text lands in the agent's input box as a
// paste (visible, not submitted) rather than being interpreted line-by-line.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const DELIVERED_PREF = "azurePrDelivered"; // prId -> latestOtherCommentAt already dispatched
const VIEWED_PREF = "azurePrViewed"; // prId -> ts the user last viewed (set by the UI)

export type AzurePrPollerDeps = {
  store: SqliteStore;
  logger: FastifyBaseLogger;
  listPtys: () => Promise<PtySummary[]>;
  writeToPty: (ptyId: string, data: string) => void;
  setPrStateForBranch: (projectRoot: string, branch: string, pr: ReturnType<typeof buildPrSummary> | null) => void;
  getActiveEditBranch: (ptyId: string) => string | null;
  broadcastPtyList: () => Promise<void>;
  launchSession: (opts: { agent: string; worktree: string; name: string; initialInput: string }) => Promise<void>;
  /** Called once when a previously active PR turns completed/abandoned. */
  onPrResolved?: (info: MergeProof) => void;
  pollIntervalMs: number;
  autoSubmit: boolean;
};

export function createAzurePrPoller(deps: AzurePrPollerDeps) {
  const { store, logger } = deps;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  // (repoRoot, branch) keys decorated on the previous tick, so we can clear stale ones.
  let lastKeys = new Set<string>();
  // Active PRs seen on previous ticks; a PR vanishing from the list means it closed.
  const trackedPrs = new Map<number, { repoRoot: string; branch: string; title: string }>();

  const branchKey = (repoRoot: string, branch: string) => `${repoRoot}\n${branch}`;
  const readMap = (key: string) => store.getPreference<Record<string, number>>(key) ?? {};

  function formatCommentPrompt(prId: number, title: string, unresolved: number, comments: PrComment[], url: string): string {
    const lines = comments
      .map((c) => {
        const loc = c.file ? `${c.file}${c.line ? `:${c.line}` : ""}` : "PR-level";
        return `- [${loc}] ${c.author}: ${c.text.replace(/\s+/g, " ").slice(0, 600)}`;
      })
      .join("\n");
    return [
      `New review comments on PR #${prId} "${title}" (${unresolved} unresolved):`,
      "",
      lines,
      "",
      "Read each against the current diff and propose a response and/or a code fix. Do not push or resolve threads — propose for my review.",
      `PR (Files): ${url}`,
      "",
    ].join("\n");
  }

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    const seenKeys = new Set<string>();
    try {
      const sessions = (await deps.listPtys()).filter((p) => p.status === "running");
      const repoRoots = [...new Set(sessions.map((p) => p.projectRoot).filter((r): r is string => !!r))];
      if (repoRoots.length === 0) {
        clearStale(seenKeys);
        return;
      }

      let me: string;
      try {
        me = await getCurrentUser();
      } catch (err) {
        logger.debug({ err: String(err) }, "azure-pr: could not resolve az user; skipping tick");
        return;
      }

      const delivered = readMap(DELIVERED_PREF);
      const viewed = readMap(VIEWED_PREF);
      let deliveredChanged = false;
      const activeNow = new Map<number, { repoRoot: string; branch: string; title: string }>();
      const polledRepos = new Set<string>();

      for (const repoRoot of repoRoots) {
        const ref = await azureRefForRepo(repoRoot);
        if (!ref) continue;

        let prs;
        try {
          prs = await listMyActivePRs(ref, me);
        } catch (err) {
          logger.debug({ err: String(err), repoRoot }, "azure-pr: pr list failed");
          continue;
        }
        polledRepos.add(repoRoot);

        const worktrees = getWorktreeCache(repoRoot);
        for (const pr of prs) {
          activeNow.set(pr.id, { repoRoot, branch: pr.sourceBranch, title: pr.title });
          let threads;
          try {
            threads = await getPrThreadsSummary(ref, pr.id, me);
          } catch (err) {
            logger.debug({ err: String(err), prId: pr.id }, "azure-pr: threads fetch failed");
            continue;
          }

          const hasNewComments = threads.latestOtherCommentAt > (viewed[pr.id] ?? 0);
          const summary = buildPrSummary(ref, pr, threads, hasNewComments);

          // Decorate any running session(s) on this branch.
          deps.setPrStateForBranch(repoRoot, pr.sourceBranch, summary);
          seenKeys.add(branchKey(repoRoot, pr.sourceBranch));

          // Dispatch new comments once (until a newer comment arrives).
          const undelivered = threads.latestOtherCommentAt > (delivered[pr.id] ?? 0) && threads.newComments.length > 0;
          if (!undelivered) continue;

          const prompt = formatCommentPrompt(pr.id, pr.title, threads.unresolvedCount, threads.newComments, summary.url);
          const branchSessions = sessions.filter(
            (p) =>
              p.projectRoot === repoRoot &&
              ((branchAtCwd(p.cwd ?? null) ?? p.worktree) === pr.sourceBranch ||
                deps.getActiveEditBranch(p.id) === pr.sourceBranch),
          );

          if (branchSessions.length > 0) {
            const target = branchSessions[0];
            deps.writeToPty(target.id, PASTE_START + prompt + PASTE_END + (deps.autoSubmit ? "\r" : ""));
            logger.info({ prId: pr.id, ptyId: target.id }, "azure-pr: delivered comments to live session");
            delivered[pr.id] = threads.latestOtherCommentAt;
            deliveredChanged = true;
          } else {
            const wt = worktrees.find((w) => w.branch === pr.sourceBranch);
            if (!wt) {
              logger.debug({ prId: pr.id, branch: pr.sourceBranch }, "azure-pr: no worktree for branch; cannot launch");
              continue;
            }
            try {
              await deps.launchSession({
                agent: "claude",
                worktree: wt.path,
                name: `PR ${pr.id}: ${pr.sourceBranch}`.slice(0, 80),
                initialInput: prompt,
              });
              logger.info({ prId: pr.id, worktree: wt.path }, "azure-pr: launched agent for PR comments");
              delivered[pr.id] = threads.latestOtherCommentAt;
              deliveredChanged = true;
            } catch (err) {
              logger.warn({ err: String(err), prId: pr.id }, "azure-pr: launch failed");
            }
          }
        }
      }

      await reportResolvedPrs(activeNow, polledRepos);

      if (deliveredChanged) store.setPreference(DELIVERED_PREF, delivered);
      clearStale(seenKeys);
      await deps.broadcastPtyList();
    } catch (err) {
      logger.warn({ err: String(err) }, "azure-pr: poll tick failed");
    } finally {
      running = false;
    }
  }

  /**
   * A PR tracked last tick that vanished from the active list has closed: fetch
   * its final state and report the merge proof. Only repos whose list call
   * succeeded this tick are judged, so a failed poll can't fake a disappearance.
   */
  async function reportResolvedPrs(
    activeNow: Map<number, { repoRoot: string; branch: string; title: string }>,
    polledRepos: Set<string>,
  ): Promise<void> {
    for (const [prId, info] of [...trackedPrs]) {
      if (!polledRepos.has(info.repoRoot) || activeNow.has(prId)) continue;
      const ref = await azureRefForRepo(info.repoRoot);
      if (!ref) {
        trackedPrs.delete(prId);
        continue;
      }
      try {
        const pr = await getPrById(ref, prId);
        if (pr.status === "completed" || pr.status === "abandoned") {
          deps.onPrResolved?.({
            repoRoot: info.repoRoot,
            branch: info.branch,
            prId,
            title: pr.title || info.title,
            status: pr.status,
            mergeSourceSha: pr.mergeSourceSha,
            completedAt: pr.closedAt,
          });
          logger.info({ prId, status: pr.status, mergeSourceSha: pr.mergeSourceSha }, "azure-pr: pr resolved");
        }
        trackedPrs.delete(prId); // final state known (or PR left our view another way)
      } catch (err) {
        // keep the entry: retry the lookup next tick
        logger.debug({ err: String(err), prId }, "azure-pr: resolution lookup failed");
      }
    }
    for (const [prId, info] of activeNow) trackedPrs.set(prId, info);
  }

  function clearStale(seenKeys: Set<string>): void {
    for (const key of lastKeys) {
      if (!seenKeys.has(key)) {
        const idx = key.indexOf("\n");
        deps.setPrStateForBranch(key.slice(0, idx), key.slice(idx + 1), null);
      }
    }
    lastKeys = seenKeys;
  }

  return {
    start(): void {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), deps.pollIntervalMs);
      logger.info({ intervalMs: deps.pollIntervalMs }, "azure-pr: poller started");
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

const PROOF_TTL_MS = 10 * 60_000;
// (repoRoot, branch) -> cached lookup, so repeated checks don't hammer az.
const proofCache = new Map<string, { at: number; value: MergeProof | null }>();

/**
 * Look up the merge proof for a branch on demand (outside the poller): the most
 * recently completed/abandoned PR whose source is `branch`. Null if the repo has
 * no Azure remote or no closed PR exists for the branch.
 */
export async function lookupMergeProof(repoRoot: string, branch: string): Promise<MergeProof | null> {
  const key = `${repoRoot}\n${branch}`;
  const cached = proofCache.get(key);
  if (cached && Date.now() - cached.at < PROOF_TTL_MS) return cached.value;

  const ref = await azureRefForRepo(repoRoot);
  if (!ref) return null;
  const pr = await getCompletedPrForBranch(ref, branch);
  const value: MergeProof | null = pr
    ? {
        repoRoot,
        branch,
        prId: pr.id,
        title: pr.title,
        status: pr.status,
        mergeSourceSha: pr.mergeSourceSha,
        completedAt: pr.closedAt,
      }
    : null;
  proofCache.set(key, { at: Date.now(), value });
  return value;
}

const prByIdCache = new Map<string, { at: number; value: PrByIdProof | null }>();

export type PrByIdProof = {
  id: number;
  title: string;
  status: string;
  mergeSourceSha: string | null;
  completedAt: number | null;
};

/** Look up a PR by id (for detached pr-<N> review checkouts with no branch). */
export async function lookupPrProofById(repoRoot: string, prId: number): Promise<PrByIdProof | null> {
  const key = `${repoRoot}\n#${prId}`;
  const cached = prByIdCache.get(key);
  if (cached && Date.now() - cached.at < PROOF_TTL_MS) return cached.value;

  const ref = await azureRefForRepo(repoRoot);
  if (!ref) return null;
  let value: PrByIdProof | null = null;
  try {
    const pr = await getPrById(ref, prId);
    value = {
      id: pr.id,
      title: pr.title,
      status: pr.status,
      mergeSourceSha: pr.mergeSourceSha,
      completedAt: pr.closedAt,
    };
  } catch {
    value = null;
  }
  prByIdCache.set(key, { at: Date.now(), value });
  return value;
}

/** Mark a PR as viewed (now), clearing its new-comment flag on the next poll. */
export function markPrViewed(store: SqliteStore, prId: number): void {
  const viewed = store.getPreference<Record<string, number>>(VIEWED_PREF) ?? {};
  viewed[prId] = Date.now();
  store.setPreference(VIEWED_PREF, viewed);
}
