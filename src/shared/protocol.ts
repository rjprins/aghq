import type { ReapClass, WorktreeState } from "./worktrees.js";

export type PtyId = string;

export type PtyStatus = "running" | "exited";
export type PtyReadinessState = "ready" | "busy" | "unknown";
export type PtyReadinessIndicator = "ready" | "busy" | "unknown";
export type TmuxServer = "agmux" | "default";

export type SessionTaskRef = {
  projectRoot: string;
  provider: string;
  taskId: string;
};

export type SessionTaskAssignment = SessionTaskRef & {
  assignedAt: number;
  worktreePath: string | null;
  cwd: string | null;
};

export type PrReviewVote =
  | "approved"
  | "approvedWithSuggestions"
  | "noVote"
  | "waitingForAuthor"
  | "rejected";

export type PrSummary = {
  id: number;
  url: string; // deep link to the PR Files tab
  title: string;
  sourceBranch: string; // short branch name (no refs/heads/ prefix)
  resolvedCount: number;
  unresolvedCount: number;
  hasNewComments: boolean;
  votes: { by: string; vote: PrReviewVote }[];
};

export type PrReviewComment = {
  id: number;
  author: string;
  text: string;
  at: number;
  url: string;
};

export type PrReviewCommentThread = {
  threadId: number;
  resolved: boolean;
  status: string;
  file: string | null;
  line: number | null;
  comments: PrReviewComment[];
};

export type PrAttention = "new" | "published";

export type AzurePrMenuItem = {
  id: number;
  title: string;
  author: string;
  isOwnAuthor?: boolean;
  isDraft: boolean;
  sourceBranch: string;
  targetBranch: string;
  createdAt: number;
  updatedAt: number;
  headSha: string | null;
  url: string;
  worktree: { name: string; path: string; dirty: boolean } | null;
  attention: PrAttention | null;
};

export type AzurePrMenuResponse =
  | { supported: false; projectRoot: string }
  | { supported: true; projectRoot: string; fetchedAt: number; prs: AzurePrMenuItem[] };

/**
 * Lifecycle annotation for the worktree a session lives in, taken from the
 * worktree scanner's cache. Absent when the project has no cached scan.
 */
export type PtyWorktreeInfo = {
  path: string;
  isPrimary: boolean;
  state: WorktreeState;
  reapClass: ReapClass;
  /** One-line context: label, PR title, or recovered first prompt. */
  context: string | null;
  lastActivityAt: number | null;
  stack: string | null;
};

export type PtySummary = {
  id: PtyId;
  name: string;
  nameSource?: "derived" | "provider" | "user";
  backend: "tmux";
  tmuxSession?: string | null;
  tmuxServer?: TmuxServer | null;
  agentProvider?: AgentProvider | null;
  agentProviderSessionId?: string | null;
  activeProcess?: string | null;
  ready?: boolean;
  readyState?: PtyReadinessState;
  readyIndicator?: PtyReadinessIndicator;
  readyReason?: string | null;
  readyStateChangedAt?: number | null;
  command: string;
  args: string[];
  cwd: string | null;
  projectRoot?: string | null;
  worktree?: string | null;
  worktreeInfo?: PtyWorktreeInfo | null;
  createdAt: number;
  lastSeenAt?: number;
  status: PtyStatus;
  exitCode?: number | null;
  exitSignal?: string | null;
  task?: SessionTaskAssignment | null;
  pr?: PrSummary | null;
};

export type ClientToServerMessage =
  | { type: "subscribe"; ptyId: PtyId }
  | { type: "input"; ptyId: PtyId; data: string }
  | { type: "resize"; ptyId: PtyId; cols: number; rows: number }
  | { type: "tmux_control"; ptyId: PtyId; direction: "up" | "down"; lines: number }
  | { type: "history_scroll_to"; ptyId: PtyId; text: string; ts?: number }
  | { type: "mobile_submit"; ptyId: PtyId; body: string }
  | { type: "mobile_snapshot_request"; requestId: string; ptyId: PtyId; lines: number }
  | { type: "kick_other_subscribers"; ptyId: PtyId };

export type ServerToClientMessage =
  | { type: "pty_list"; ptys: PtySummary[] }
  | { type: "viewer_counts"; counts: Record<PtyId, number> }
  | { type: "pty_output"; ptyId: PtyId; data: string }
  | { type: "pty_exit"; ptyId: PtyId; code: number | null; signal: string | null }
  | {
      type: "pty_ready";
      ptyId: PtyId;
      state: PtyReadinessState;
      indicator: PtyReadinessIndicator;
      reason: string;
      ts: number;
      cwd?: string | null;
      activeProcess?: string | null;
    }
  | {
      type: "trigger_fired";
      ptyId: PtyId;
      trigger: string;
      match: string;
      line: string;
      ts: number;
    }
  | { type: "pty_highlight"; ptyId: PtyId; reason: string; ttlMs: number }
  | { type: "trigger_error"; ptyId: PtyId; trigger: string; ts: number; message: string }
  | {
      type: "mobile_snapshot_response";
      requestId: string;
      ptyId: PtyId;
      ok: true;
      capturedAt: number;
      lineCount: number;
      truncated: boolean;
      text: string;
    }
  | {
      type: "mobile_snapshot_response";
      requestId: string;
      ptyId: PtyId;
      ok: false;
      error: string;
    };

export type AgentProvider = "claude" | "codex" | "pi";
export type AgentSessionCwdSource = "runtime" | "db" | "log" | "user";

export type AgentSessionSummary = {
  id: string;
  provider: AgentProvider;
  providerSessionId: string;
  name: string;
  command: string;
  args: string[];
  cwd: string | null;
  cwdSource: AgentSessionCwdSource;
  projectRoot: string | null;
  worktree: string | null;
  createdAt: number;
  lastSeenAt: number;
  lastRestoredAt?: number | null;
};

export type TmuxSessionInfo = {
  name: string;
  server: TmuxServer;
  createdAt: number | null;
  windows: number | null;
};

export type TmuxSessionCheck = {
  name: string;
  server: TmuxServer;
  warnings: string[];
  observed: {
    mouse: string | null;
    alternateScreen: string | null;
    historyLimit: number | null;
    terminalOverrides: string | null;
  };
};
