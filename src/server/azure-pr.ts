import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PrReviewVote, PrSummary } from "../types.js";

const execFileAsync = promisify(execFile);
const AZ_MAX_BUFFER = 16 * 1024 * 1024;
const AZ_TIMEOUT_MS = 30_000;

export type AzureRepoRef = { orgUrl: string; project: string; repo: string };

/** A human (non-system) review comment we may surface or hand to an agent. */
export type PrComment = {
  threadId: number;
  author: string;
  text: string;
  file: string | null;
  line: number | null;
  /** epoch ms of the comment's last update */
  at: number;
};

export type PrThreadsSummary = {
  resolvedCount: number;
  unresolvedCount: number;
  /** Unresolved human comments authored by someone other than `me`, newest last. */
  newComments: PrComment[];
  /** epoch ms of the newest human comment by anyone other than `me`, or 0. */
  latestOtherCommentAt: number;
};

const RESOLVED_THREAD_STATUS = new Set(["fixed", "closed", "wontfix", "bydesign"]);

const VOTE_MAP: Record<number, PrReviewVote> = {
  10: "approved",
  5: "approvedWithSuggestions",
  0: "noVote",
  [-5]: "waitingForAuthor",
  [-10]: "rejected",
};

/**
 * Parse an Azure DevOps git remote into { orgUrl, project, repo }. Supports the
 * dev.azure.com HTTPS form (with optional user@), the legacy *.visualstudio.com
 * form, and the SSH form. Returns null for non-Azure remotes.
 */
export function parseAzureRemote(remoteUrl: string): AzureRepoRef | null {
  const url = remoteUrl.trim();

  // https://[user@]dev.azure.com/{org}/{project}/_git/{repo}
  let m = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  if (m) {
    return { orgUrl: `https://dev.azure.com/${decodeURIComponent(m[1])}`, project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]) };
  }

  // https://{org}.visualstudio.com/{project}/_git/{repo}
  m = /^https?:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  if (m) {
    return { orgUrl: `https://dev.azure.com/${m[1]}`, project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]) };
  }

  // git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
  m = /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(url);
  if (m) {
    return { orgUrl: `https://dev.azure.com/${m[1]}`, project: m[2], repo: m[3] };
  }

  return null;
}

/** Deep link to the PR's Files tab. */
export function prFilesUrl(ref: AzureRepoRef, prId: number): string {
  return `${ref.orgUrl}/${encodeURIComponent(ref.project)}/_git/${encodeURIComponent(ref.repo)}/pullrequest/${prId}?_a=files`;
}

async function azJson<T>(args: string[]): Promise<T> {
  const { stdout } = await execFileAsync("az", args, { maxBuffer: AZ_MAX_BUFFER, timeout: AZ_TIMEOUT_MS });
  return JSON.parse(stdout) as T;
}

let cachedUser: { value: string; at: number } | null = null;

/** The signed-in az user (email/uniqueName), cached for 5 minutes. */
export async function getCurrentUser(): Promise<string> {
  if (cachedUser && Date.now() - cachedUser.at < 5 * 60_000) return cachedUser.value;
  const { stdout } = await execFileAsync("az", ["account", "show", "--query", "user.name", "-o", "tsv"], {
    timeout: AZ_TIMEOUT_MS,
  });
  const value = stdout.trim();
  cachedUser = { value, at: Date.now() };
  return value;
}

type RawPr = {
  pullRequestId: number;
  title: string;
  sourceRefName: string;
  reviewers?: { uniqueName?: string; displayName?: string; vote?: number }[];
};

export type AzurePr = {
  id: number;
  title: string;
  sourceBranch: string;
  votes: { by: string; vote: PrReviewVote }[];
};

/** List the signed-in user's active PRs in a repo. */
export async function listMyActivePRs(ref: AzureRepoRef, creator: string): Promise<AzurePr[]> {
  const raw = await azJson<RawPr[]>([
    "repos", "pr", "list",
    "--org", ref.orgUrl,
    "--project", ref.project,
    "--repository", ref.repo,
    "--status", "active",
    "--creator", creator,
    "-o", "json",
  ]);
  return raw.map((pr) => ({
    id: pr.pullRequestId,
    title: pr.title,
    sourceBranch: pr.sourceRefName.replace(/^refs\/heads\//, ""),
    votes: (pr.reviewers ?? []).map((r) => ({
      by: r.uniqueName || r.displayName || "?",
      vote: VOTE_MAP[r.vote ?? 0] ?? "noVote",
    })),
  }));
}

type RawThread = {
  id: number;
  status?: string | null;
  isDeleted?: boolean;
  threadContext?: { filePath?: string | null; rightFileStart?: { line?: number } | null } | null;
  comments?: {
    author?: { uniqueName?: string; displayName?: string };
    content?: string;
    commentType?: string;
    isDeleted?: boolean;
    lastUpdatedDate?: string;
    publishedDate?: string;
  }[];
};

async function fetchRawThreads(ref: AzureRepoRef, prId: number): Promise<RawThread[]> {
  const res = await azJson<{ value: RawThread[] }>([
    "devops", "invoke",
    "--org", ref.orgUrl,
    "--area", "git",
    "--resource", "pullRequestThreads",
    "--route-parameters", `project=${ref.project}`, `repositoryId=${ref.repo}`, `pullRequestId=${prId}`,
    "--api-version", "7.1",
    "-o", "json",
  ]);
  return res.value ?? [];
}

/** Fetch + summarize the comment threads of a PR. `me` is excluded from "new comments". */
export async function getPrThreadsSummary(ref: AzureRepoRef, prId: number, me: string): Promise<PrThreadsSummary> {
  const threads = await fetchRawThreads(ref, prId);

  let resolvedCount = 0;
  let unresolvedCount = 0;
  let latestOtherCommentAt = 0;
  const newComments: PrComment[] = [];

  for (const thread of threads) {
    if (thread.isDeleted) continue;
    const textComments = (thread.comments ?? []).filter(
      (c) => !c.isDeleted && c.commentType === "text" && (c.content ?? "").trim().length > 0,
    );
    if (textComments.length === 0) continue; // system-only thread (push/vote/build) — ignore

    const status = (thread.status ?? "").toLowerCase();
    if (RESOLVED_THREAD_STATUS.has(status)) resolvedCount++;
    else unresolvedCount++;

    const isUnresolved = !RESOLVED_THREAD_STATUS.has(status);
    for (const c of textComments) {
      const at = Date.parse(c.lastUpdatedDate || c.publishedDate || "") || 0;
      const author = c.author?.uniqueName || c.author?.displayName || "?";
      if (author !== me) {
        if (at > latestOtherCommentAt) latestOtherCommentAt = at;
        if (isUnresolved) {
          newComments.push({
            threadId: thread.id,
            author,
            text: (c.content ?? "").trim(),
            file: thread.threadContext?.filePath ?? null,
            line: thread.threadContext?.rightFileStart?.line ?? null,
            at,
          });
        }
      }
    }
  }

  newComments.sort((a, b) => a.at - b.at);
  return { resolvedCount, unresolvedCount, newComments, latestOtherCommentAt };
}

/** Build the immutable parts of a PrSummary (UI-facing). hasNewComments is set by the caller. */
export function buildPrSummary(
  ref: AzureRepoRef,
  pr: AzurePr,
  threads: PrThreadsSummary,
  hasNewComments: boolean,
): PrSummary {
  return {
    id: pr.id,
    url: prFilesUrl(ref, pr.id),
    title: pr.title,
    sourceBranch: pr.sourceBranch,
    resolvedCount: threads.resolvedCount,
    unresolvedCount: threads.unresolvedCount,
    hasNewComments,
    votes: pr.votes,
  };
}

export type PrCommentThread = {
  threadId: number;
  resolved: boolean;
  status: string;
  file: string | null;
  line: number | null;
  comments: { author: string; text: string; at: number }[];
};

/** All human comment threads on a PR (resolved + active), ordered oldest activity first. */
export async function getPrComments(ref: AzureRepoRef, prId: number): Promise<PrCommentThread[]> {
  const threads = await fetchRawThreads(ref, prId);
  const out: PrCommentThread[] = [];
  for (const thread of threads) {
    if (thread.isDeleted) continue;
    const textComments = (thread.comments ?? []).filter(
      (c) => !c.isDeleted && c.commentType === "text" && (c.content ?? "").trim().length > 0,
    );
    if (textComments.length === 0) continue;
    const status = (thread.status ?? "").toLowerCase();
    out.push({
      threadId: thread.id,
      resolved: RESOLVED_THREAD_STATUS.has(status),
      status: status || "active",
      file: thread.threadContext?.filePath ?? null,
      line: thread.threadContext?.rightFileStart?.line ?? null,
      comments: textComments.map((c) => ({
        author: c.author?.uniqueName || c.author?.displayName || "?",
        text: (c.content ?? "").trim(),
        at: Date.parse(c.lastUpdatedDate || c.publishedDate || "") || 0,
      })),
    });
  }
  const latest = (t: PrCommentThread) => t.comments.reduce((m, c) => Math.max(m, c.at), 0);
  out.sort((a, b) => latest(a) - latest(b));
  return out;
}

/** Parse a PR Files-tab URL (as built by prFilesUrl) back into its repo ref + id. */
export function parseAzurePrUrl(url: string): { ref: AzureRepoRef; prId: number } | null {
  const m = /^(https?:\/\/dev\.azure\.com\/[^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/i.exec(url);
  if (!m) return null;
  return {
    ref: { orgUrl: m[1], project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]) },
    prId: Number(m[4]),
  };
}
