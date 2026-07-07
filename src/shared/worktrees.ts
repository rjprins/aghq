// Shared worktree-management types used by server, UI, and MCP.
// Design doc: worktree management redesign (2026-07). Git is truth for
// existence; the sqlite `worktrees` table is truth for meaning (labels,
// context, tombstones); lifecycle state is computed, cached, never trusted.

/** Computed lifecycle state, cached in the row at scan time. */
export type WorktreeState =
  | "active" // live PTY inside, or HEAD-reflog/session activity <= 7 days
  | "open" // PR active, or upstream alive with unmerged commits
  | "merged" // upstream [gone] (squash-merge signal) / PR completed / ancestry
  | "local-only" // never had an upstream AND has commits not on the default branch
  | "review" // detached pr-<id> checkout
  | "stale" // none of the above, idle >= 14 days
  | "ephemeral" // lives under .claude/worktrees/ (Claude Code manages cleanup)
  | "unknown";

/** Destructive-action class derived from state + safety evidence. */
export type ReapClass = "reap-safe" | "reap-check" | null;

export type WorktreeOverlays = {
  dirty: boolean;
  /** True when the only dirt is gitignored files (the .venv case). */
  ignoredOnly: boolean;
  /** Commits not on the upstream (when upstream exists). */
  unpushedCount: number | null;
  /** Directory basename does not match the sanitized branch name. */
  drifted: boolean;
  /** Path does not match the repo's worktree template. */
  offConvention: boolean;
  locked: boolean;
  prunable: boolean;
  /** Upstream configured but remote branch deleted (squash-merge completion signal). */
  upstreamGone: boolean;
  /** Branch never had an upstream configured and no origin ref exists. */
  neverPushed: boolean;
};

export type WorktreeAnnotated = {
  /** Back-compat fields (existing consumers). */
  name: string;
  path: string;
  branch: string; // "" when detached

  head: string | null;
  detached: boolean;
  isPrimary: boolean;

  state: WorktreeState;
  reapClass: ReapClass;
  /** Human-readable proof, e.g. "PR !4812 completed Jun 3 · tip matches merge-source · clean". */
  evidence: string;
  /** Hash of the status output this classification was computed from (TOCTOU guard). */
  statusHash: string | null;

  overlays: WorktreeOverlays;

  /** Last activity: max(HEAD-reflog time, latest session activity). Epoch ms. */
  lastActivityAt: number | null;
  lastCommitAt: number | null;

  // Meaning (from the sqlite row).
  label: string | null;
  ticketId: string | null;
  prId: string | null;
  prTitle: string | null;
  prStatus: string | null;
  /** Recovered context: earliest session name/first prompt for this cwd. */
  firstPrompt: string | null;
  origin: string | null;

  /** Display grouping for stacked-PR sets (shared branch prefix or shared label). */
  stack: string | null;

  // Expensive tier (may be null until computed).
  diskBytes: number | null;
  ignoredBytes: number | null;

  sessionCount: number;
  liveSessionCount: number;
};

export type OrphanBranch = {
  branch: string;
  head: string;
  lastCommitAt: number | null;
  upstreamGone: boolean;
  neverPushed: boolean;
  mergedIntoDefault: boolean;
};

export type WorktreeTombstone = {
  path: string;
  branch: string | null;
  label: string | null;
  ticketId: string | null;
  prTitle: string | null;
  firstPrompt: string | null;
  reapedAt: number;
  reapEvidence: string | null;
  salvagePath: string | null;
  atticTag: string | null;
};

export type WorktreesFullResponse = {
  repoRoot: string;
  worktrees: WorktreeAnnotated[];
  orphanBranches: OrphanBranch[];
  tombstones: WorktreeTombstone[];
  defaultBranch: string;
  scannedAt: number;
};

export type ReapRequest = {
  path: string;
  /** HEAD sha the caller saw when the proposal was rendered; mismatch aborts. */
  expectedHead: string;
  /** Hash of the status summary the caller saw (required for reap-check rows). */
  expectedStatusHash?: string;
  /** Tarball non-ignored dirt before removal. Server forces true when such dirt exists. */
  salvage?: boolean;
  /** "auto" (default): attic-tag then delete when merged-proven; "never": keep branch. */
  deleteBranch?: "auto" | "never";
};

export type ReapResult = {
  ok: boolean;
  aborted?: boolean;
  reason?: string;
  freedBytes?: number;
  salvagePath?: string | null;
  atticTag?: string | null;
  branchDeleted?: boolean;
};

export type BranchDropRequest = {
  repoRoot: string;
  branch: string;
};

export type BranchDropResult = {
  ok: boolean;
  reason?: string;
  atticTag?: string | null;
  deleted?: boolean;
};

/** Sanitize a branch name for use in paths/tags (matches resolveWorktreePath). */
export function sanitizeBranchName(branch: string): string {
  return branch.replace(/[/\\ ]+/g, "-");
}

const BRANCH_VERBS = [
  "forge", "weave", "prime", "grind", "brave", "swift", "quiet", "amber",
  "bold", "calm", "deft", "eager", "fleet", "keen", "lucid", "merry",
];
const BRANCH_NOUNS = [
  "heron", "otter", "grove", "vale", "thorn", "ridge", "brook", "cove",
  "fern", "gale", "knoll", "marsh", "pine", "reef", "spire", "wren",
];

/** Random verb-noun branch name for exploratory work (e.g. forge-heron). */
export function generateBranchName(): string {
  const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)];
  return `${pick(BRANCH_VERBS)}-${pick(BRANCH_NOUNS)}`;
}

/** Fixed display order for lifecycle state groups (panel + sidebar). */
export const WORKTREE_STATE_ORDER: WorktreeState[] = [
  "active",
  "open",
  "local-only",
  "review",
  "stale",
  "ephemeral",
  "unknown",
  "merged",
];
