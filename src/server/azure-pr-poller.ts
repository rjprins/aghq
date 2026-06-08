import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyBaseLogger } from "fastify";

import type { PtySummary } from "../types.js";
import type { SqliteStore } from "../persist/sqlite.js";
import { getWorktreeCache } from "../worktree.js";
import {
  buildPrSummary,
  getCurrentUser,
  getPrThreadsSummary,
  listMyActivePRs,
  parseAzureRemote,
  type AzureRepoRef,
  type PrComment,
} from "./azure-pr.js";

const execFileAsync = promisify(execFile);

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
  broadcastPtyList: () => Promise<void>;
  launchSession: (opts: { agent: string; worktree: string; name: string; initialInput: string }) => Promise<void>;
  pollIntervalMs: number;
  autoSubmit: boolean;
};

export function createAzurePrPoller(deps: AzurePrPollerDeps) {
  const { store, logger } = deps;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  // (repoRoot, branch) keys decorated on the previous tick, so we can clear stale ones.
  let lastKeys = new Set<string>();
  // repoRoot -> Azure ref (or null if not an Azure remote); avoids re-shelling git every tick.
  const remoteCache = new Map<string, AzureRepoRef | null>();

  const branchKey = (repoRoot: string, branch: string) => `${repoRoot}\n${branch}`;
  const readMap = (key: string) => store.getPreference<Record<string, number>>(key) ?? {};

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

        const worktrees = getWorktreeCache(repoRoot);
        for (const pr of prs) {
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
          const branchSessions = sessions.filter((p) => p.projectRoot === repoRoot && p.worktree === pr.sourceBranch);

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

      if (deliveredChanged) store.setPreference(DELIVERED_PREF, delivered);
      clearStale(seenKeys);
      await deps.broadcastPtyList();
    } catch (err) {
      logger.warn({ err: String(err) }, "azure-pr: poll tick failed");
    } finally {
      running = false;
    }
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

/** Mark a PR as viewed (now), clearing its new-comment flag on the next poll. */
export function markPrViewed(store: SqliteStore, prId: number): void {
  const viewed = store.getPreference<Record<string, number>>(VIEWED_PREF) ?? {};
  viewed[prId] = Date.now();
  store.setPreference(VIEWED_PREF, viewed);
}
