// Pure worktree classification: parsers for git plumbing output plus the
// lifecycle-state decision table. No I/O — git truth and session context come
// in via ClassifyInput. All timestamps are epoch ms; `now` is caller-supplied.
import path from "node:path";
import { createHash } from "node:crypto";
import { sanitizeBranchName } from "./shared/worktrees.js";
import type { ReapClass, WorktreeOverlays, WorktreeState } from "./shared/worktrees.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_WINDOW_MS = 7 * DAY_MS;
const STALE_IDLE_MS = 14 * DAY_MS;
const IGNORED_BYTES_LIMIT = 500 * 1024 * 1024;
const STATUS_SAMPLE_LIMIT = 5;

export type PorcelainWorktree = {
  path: string;
  head: string | null;
  branch: string; // "" when detached or bare
  detached: boolean;
  locked: boolean;
  prunable: boolean;
};

/**
 * Parse `git worktree list --porcelain` output including attribute lines
 * (detached/locked/prunable/bare). The simple parser in worktree.ts stays as-is.
 */
export function parseWorktreeListPorcelainV2(output: string): PorcelainWorktree[] {
  const entries: PorcelainWorktree[] = [];
  for (const block of output.split(/\n\n+/)) {
    const lines = block.split("\n").filter((l) => l.length > 0);
    let entryPath = "";
    let head: string | null = null;
    let branch = "";
    let detached = false;
    let locked = false;
    let prunable = false;
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        entryPath = line.slice("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      } else if (line === "detached") {
        detached = true;
      } else if (line === "locked" || line.startsWith("locked ")) {
        locked = true; // optional reason after the keyword is not tracked
      } else if (line === "prunable" || line.startsWith("prunable ")) {
        prunable = true;
      }
      // "bare" needs no flag of its own: the entry keeps branch "" and no HEAD.
    }
    if (entryPath) {
      entries.push({ path: entryPath, head, branch, detached, locked, prunable });
    }
  }
  return entries;
}

/** Sha1 of raw `git status` output — the reap handshake token. */
export function hashStatusOutput(raw: string): string {
  return createHash("sha1").update(raw).digest("hex");
}

export type StatusSummary = {
  dirty: boolean;
  /** Only gitignored files present (the .venv case); a fully clean tree is false. */
  ignoredOnly: boolean;
  changedCount: number;
  sample: string[];
  statusHash: string;
};

/**
 * Summarize `git status --porcelain=v2 --ignored` output.
 * Changed (`1 `/`2 `/`u `) and untracked (`? `) both count as non-ignored dirt;
 * `! ` entries are gitignored and never make the tree dirty.
 */
export function summarizeStatusV2(porcelainV2Output: string): StatusSummary {
  let changed = 0;
  let ignored = 0;
  const sample: string[] = [];
  for (const line of porcelainV2Output.split("\n")) {
    if (line.length === 0 || line.startsWith("# ")) continue;
    if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ") || line.startsWith("? ")) {
      changed += 1;
      const entryPath = statusEntryPath(line);
      if (entryPath != null && sample.length < STATUS_SAMPLE_LIMIT) sample.push(entryPath);
    } else if (line.startsWith("! ")) {
      ignored += 1;
    }
  }
  return {
    dirty: changed > 0,
    ignoredOnly: changed === 0 && ignored > 0,
    changedCount: changed,
    sample,
    statusHash: hashStatusOutput(porcelainV2Output),
  };
}

/** Extract the path from a porcelain=v2 status entry line. */
function statusEntryPath(line: string): string | null {
  if (line.startsWith("? ") || line.startsWith("! ")) return line.slice(2) || null;
  // Path is the tail after a fixed number of space-separated fields per entry kind.
  if (line.startsWith("1 ")) return tailAfterFields(line, 8);
  if (line.startsWith("2 ")) {
    const tail = tailAfterFields(line, 9);
    return tail == null ? null : (tail.split("\t")[0] || null); // "<path>\t<origPath>"
  }
  if (line.startsWith("u ")) return tailAfterFields(line, 10);
  return null;
}

function tailAfterFields(line: string, fieldCount: number): string | null {
  let idx = 0;
  for (let i = 0; i < fieldCount; i++) {
    idx = line.indexOf(" ", idx);
    if (idx === -1) return null;
    idx += 1;
  }
  return line.slice(idx) || null;
}

export type RefInfo = {
  branch: string;
  upstream: string | null;
  /** Upstream configured but the remote branch is deleted (squash-merge signal). */
  upstreamGone: boolean;
  /** Committer date of the branch tip, epoch ms. */
  lastCommitAt: number | null;
  head: string;
};

/**
 * Parse one line of `git for-each-ref` with format
 * `%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(committerdate:unix)%09%(objectname)`.
 */
export function parseForEachRefLine(line: string): RefInfo | null {
  const parts = line.split("\t");
  if (parts.length < 5) return null;
  const [branch, upstream, track, dateUnix, head] = parts;
  if (!branch || !head) return null;
  const seconds = Number.parseInt(dateUnix, 10);
  return {
    branch,
    upstream: upstream ? upstream : null,
    upstreamGone: track.includes("gone"),
    lastCommitAt: Number.isFinite(seconds) ? seconds * 1000 : null,
    head,
  };
}

export type ClassifyInput = {
  wt: PorcelainWorktree;
  ref: RefInfo | null;
  status: StatusSummary | null;
  isPrimary: boolean;
  liveSessionCount: number;
  lastSessionActivityAt: number | null;
  neverPushed: boolean;
  hasUnmergedCommits: boolean | null;
  ancestryMerged: boolean | null;
  prStatus: string | null;
  prId: string | null;
  prCompletedAt: number | null;
  /** Sha the PR merged (squash source); tip mismatch means post-merge commits. */
  mergeSourceSha: string | null;
  unpushedCount: number | null;
  ignoredBytes: number | null;
  /** Expected path per the repo's worktree template, already resolved. */
  templatePath: string | null;
  now: number;
};

export type ClassifyResult = {
  state: WorktreeState;
  reapClass: ReapClass;
  evidence: string;
  overlays: WorktreeOverlays;
};

/** Decide lifecycle state, reap safety, and human-readable evidence. */
export function classifyWorktree(input: ClassifyInput): ClassifyResult {
  return { ...decideState(input), overlays: computeOverlays(input) };
}

type StateDecision = { state: WorktreeState; reapClass: ReapClass; evidence: string };

function decideState(input: ClassifyInput): StateDecision {
  const { wt, ref, status } = input;
  const clean = status != null && !status.dirty;
  const lastCommitAt = ref?.lastCommitAt ?? null;
  const lastActivityAt = maxTime(lastCommitAt, input.lastSessionActivityAt);
  const idleMs = lastActivityAt == null ? null : input.now - lastActivityAt;
  const recentlyActive = input.liveSessionCount > 0 || (idleMs != null && idleMs < ACTIVE_WINDOW_MS);

  // 1. Claude Code's own worktrees — it manages their cleanup.
  if (wt.path.includes("/.claude/worktrees/")) {
    return { state: "ephemeral", reapClass: null, evidence: "Claude Code worktree under .claude/worktrees" };
  }

  // 2. The primary worktree is never reap material.
  if (input.isPrimary) {
    return { state: recentlyActive ? "active" : "open", reapClass: null, evidence: "primary worktree" };
  }

  // 3. Detached checkouts: pr-<n> review worktrees; anything else is opaque.
  if (wt.detached) {
    const base = path.basename(wt.path);
    if (/^pr-\d+/.test(base)) {
      if (input.prStatus === "completed" || input.prStatus === "abandoned") {
        const facts = ["review checkout, PR closed", clean ? "clean" : dirtFact(status)];
        if (input.liveSessionCount > 0) facts.push(plural(input.liveSessionCount, "live session"));
        return {
          state: "review",
          reapClass: clean && input.liveSessionCount === 0 ? "reap-safe" : "reap-check",
          evidence: facts.join(" · "),
        };
      }
      return { state: "review", reapClass: null, evidence: `review checkout (${base})` };
    }
    return { state: "unknown", reapClass: null, evidence: "detached HEAD" };
  }

  // 4. Recent activity keeps it active — but a landed branch (upstream gone or
  //    PR completed) should still be offered for reaping, so merged wins then.
  const upstreamGone = ref?.upstreamGone === true;
  const strongMerged = upstreamGone || input.prStatus === "completed";
  if (recentlyActive && !strongMerged) {
    const facts: string[] = [];
    if (input.liveSessionCount > 0) facts.push(plural(input.liveSessionCount, "live session"));
    if (lastCommitAt != null) facts.push(`last commit ${isoDate(lastCommitAt)}`);
    if (input.lastSessionActivityAt != null) facts.push(`session activity ${isoDate(input.lastSessionActivityAt)}`);
    return { state: "active", reapClass: null, evidence: facts.join(" · ") };
  }

  // 5. Merged (abandoned PRs are merged-class too: closed, never landing).
  if (strongMerged || input.prStatus === "abandoned" || input.ancestryMerged === true) {
    return classifyMerged(input, clean, upstreamGone);
  }

  // 6. Never pushed anywhere but carrying real commits: purely local work.
  if (input.neverPushed && input.hasUnmergedCommits === true) {
    const commits =
      input.unpushedCount != null ? plural(input.unpushedCount, "local commit") : "unmerged local commits";
    return { state: "local-only", reapClass: null, evidence: `never pushed · ${commits}` };
  }

  // 7. Work in flight.
  const upstreamAlive = ref?.upstream != null && !upstreamGone;
  if (input.prStatus === "active" || (upstreamAlive && input.hasUnmergedCommits === true)) {
    const facts: string[] = [];
    if (input.prStatus === "active") {
      facts.push(input.prId != null ? `PR !${input.prId} active` : "PR active");
    } else {
      facts.push("upstream alive");
      facts.push(
        input.unpushedCount != null && input.unpushedCount > 0
          ? plural(input.unpushedCount, "unpushed commit")
          : "unmerged commits",
      );
    }
    return { state: "open", reapClass: null, evidence: facts.join(" · ") };
  }

  // 8. Nothing else: long idle is stale, otherwise we just don't know.
  if (idleMs != null && idleMs >= STALE_IDLE_MS) {
    const days = Math.floor(idleMs / DAY_MS);
    return {
      state: "stale",
      reapClass: null,
      evidence: `idle ${days} days · last activity ${isoDate(lastActivityAt as number)}`,
    };
  }
  return {
    state: "unknown",
    reapClass: null,
    evidence: idleMs == null ? "no recorded activity" : `idle ${Math.floor(idleMs / DAY_MS)} days`,
  };
}

function classifyMerged(input: ClassifyInput, clean: boolean, upstreamGone: boolean): StateDecision {
  const head = input.ref?.head ?? input.wt.head;
  const tipAhead = input.mergeSourceSha != null && head !== input.mergeSourceSha;
  const abandoned = input.prStatus === "abandoned";
  const bigIgnored = input.ignoredBytes != null && input.ignoredBytes >= IGNORED_BYTES_LIMIT;
  // A gone upstream alone proves deletion, not merging — demand a PR record or ancestry.
  const mergeUnproven =
    upstreamGone && input.prStatus == null && input.mergeSourceSha == null && input.ancestryMerged !== true;

  const facts: string[] = [];
  if (input.prStatus === "completed") {
    const id = input.prId != null ? ` !${input.prId}` : "";
    const when = input.prCompletedAt != null ? ` ${isoDate(input.prCompletedAt)}` : "";
    facts.push(`PR${id} completed${when}`);
  } else if (abandoned) {
    const id = input.prId != null ? ` !${input.prId}` : "";
    facts.push(`PR${id} abandoned (never merged)`);
  } else if (upstreamGone) {
    facts.push("upstream gone");
    if (input.ancestryMerged === true) facts.push("merged into default branch");
    else if (mergeUnproven) facts.push("merge unproven (no PR record)");
  } else {
    facts.push("merged into default branch (ancestry)");
  }
  if (input.mergeSourceSha != null) {
    facts.push(tipAhead ? "tip differs from merged commit" : "tip matches merge-source");
  }
  facts.push(clean ? "clean" : dirtFact(input.status));
  if (bigIgnored) {
    const gb = ((input.ignoredBytes as number) / 2 ** 30).toFixed(1);
    facts.push(`${gb} GB gitignored data will be destroyed (not salvageable)`);
  }
  if (input.liveSessionCount > 0) facts.push(plural(input.liveSessionCount, "live session"));

  const reapSafe =
    clean &&
    !input.isPrimary &&
    !bigIgnored &&
    !tipAhead &&
    input.liveSessionCount === 0 &&
    !abandoned &&
    !mergeUnproven;
  return { state: "merged", reapClass: reapSafe ? "reap-safe" : "reap-check", evidence: facts.join(" · ") };
}

function computeOverlays(input: ClassifyInput): WorktreeOverlays {
  const { wt, ref, status } = input;
  return {
    dirty: status?.dirty ?? false,
    ignoredOnly: status?.ignoredOnly ?? false,
    unpushedCount: input.unpushedCount,
    // Primary worktree dirs are named after the repo, not the branch.
    drifted: !input.isPrimary && wt.branch !== "" && path.basename(wt.path) !== sanitizeBranchName(wt.branch),
    offConvention: input.templatePath != null && path.resolve(wt.path) !== input.templatePath,
    locked: wt.locked,
    prunable: wt.prunable,
    upstreamGone: ref?.upstreamGone ?? false,
    neverPushed: input.neverPushed,
  };
}

function maxTime(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function dirtFact(status: StatusSummary | null): string {
  if (status == null) return "status unknown";
  return plural(status.changedCount, "changed file");
}
