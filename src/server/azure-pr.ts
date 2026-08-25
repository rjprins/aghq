import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { AzurePrMenuReview, PrCheckStatus, PrMergeReadiness } from "../shared/protocol.js";
import type { PrReviewCommentThread, PrReviewVote, PrSummary } from "../types.js";

const execFileAsync = promisify(execFile);
const AZ_MAX_BUFFER = 16 * 1024 * 1024;
const AZ_TIMEOUT_MS = 30_000;

export type AzureRepoRef = { orgUrl: string; project: string; repo: string };

export type AzurePrMergeStatus =
  | "notSet"
  | "queued"
  | "conflicts"
  | "succeeded"
  | "rejectedByPolicy"
  | "failure"
  | "unknown";

export type AzureActivePr = {
  id: number;
  title: string;
  author: string;
  authorUniqueName: string | null;
  isDraft: boolean;
  sourceBranch: string;
  targetBranch: string;
  createdAt: number;
  headSha: string | null;
  mergeStatus: AzurePrMergeStatus;
  reviewerVotes: number[];
  url: string;
};

/** A human (non-system) review comment we may surface or hand to an agent. */
export type PrComment = {
  commentId: number;
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

const MERGE_STATUSES = new Set<AzurePrMergeStatus>([
  "notSet",
  "queued",
  "conflicts",
  "succeeded",
  "rejectedByPolicy",
  "failure",
]);

const REVIEWER_VOTES = new Set([-10, -5, 0, 5, 10]);
// Azure DevOps' documented Build validation policy type.
// https://learn.microsoft.com/azure/devops/repos/git/branch-policies#build-validation
const BUILD_POLICY_TYPE_ID = "0609b952-1397-4640-95ec-e00a01b2c241";

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

const remoteCache = new Map<string, AzureRepoRef | null>();

/** Resolve and cache the Azure DevOps repository represented by a git root. */
export async function azureRepoRefForRoot(repoRoot: string): Promise<AzureRepoRef | null> {
  if (remoteCache.has(repoRoot)) return remoteCache.get(repoRoot) ?? null;
  let ref: AzureRepoRef | null = null;
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, "remote", "get-url", "origin"], {
      timeout: 10_000,
    });
    ref = parseAzureRemote(stdout.trim());
  } catch {
    ref = null;
  }
  remoteCache.set(repoRoot, ref);
  return ref;
}

/** Deep link to the PR's Files tab. */
export function prFilesUrl(ref: AzureRepoRef, prId: number): string {
  return `${ref.orgUrl}/${encodeURIComponent(ref.project)}/_git/${encodeURIComponent(ref.repo)}/pullrequest/${prId}?_a=files`;
}

/** Browser link that opens one PR discussion. */
export function prDiscussionUrl(ref: AzureRepoRef, prId: number, threadId: number): string {
  // Source: https://learn.microsoft.com/azure/devops/service-hooks/events#pull-request-commented-on
  return `${ref.orgUrl}/${encodeURIComponent(ref.project)}/_git/${encodeURIComponent(ref.repo)}/pullrequest/${prId}?discussionId=${threadId}`;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function shortBranch(value: unknown): string | null {
  const refName = nonEmptyString(value);
  if (!refName?.startsWith("refs/heads/")) return null;
  const branch = refName.slice("refs/heads/".length);
  return branch ? branch : null;
}

/** Validate and normalize the third-party payload returned by `az repos pr list`. */
export function normalizeActivePrRecords(ref: AzureRepoRef, value: unknown): AzureActivePr[] {
  if (!Array.isArray(value)) return [];
  const prs: AzureActivePr[] = [];
  for (const candidate of value) {
    const raw = objectRecord(candidate);
    if (!raw) continue;
    const id = raw.pullRequestId;
    const title = nonEmptyString(raw.title);
    const sourceBranch = shortBranch(raw.sourceRefName);
    const targetBranch = shortBranch(raw.targetRefName);
    const createdAt = typeof raw.creationDate === "string" ? Date.parse(raw.creationDate) : Number.NaN;
    if (!Number.isSafeInteger(id) || Number(id) <= 0 || !title || !sourceBranch || !targetBranch) continue;
    if (!Number.isFinite(createdAt) || typeof raw.isDraft !== "boolean") continue;

    const createdBy = objectRecord(raw.createdBy);
    const authorUniqueName = nonEmptyString(createdBy?.uniqueName);
    const author = nonEmptyString(createdBy?.displayName) ?? authorUniqueName ?? "Unknown";
    const lastMergeSourceCommit = objectRecord(raw.lastMergeSourceCommit);
    const headSha = nonEmptyString(lastMergeSourceCommit?.commitId);
    const rawMergeStatus = nonEmptyString(raw.mergeStatus);
    const mergeStatus = rawMergeStatus && MERGE_STATUSES.has(rawMergeStatus as AzurePrMergeStatus)
      ? rawMergeStatus as AzurePrMergeStatus
      : "unknown";
    const reviewerVotes = Array.isArray(raw.reviewers)
      ? raw.reviewers.flatMap((candidate) => {
        const reviewer = objectRecord(candidate);
        return typeof reviewer?.vote === "number" && REVIEWER_VOTES.has(reviewer.vote) ? [reviewer.vote] : [];
      })
      : [];
    prs.push({
      id: Number(id),
      title,
      author,
      authorUniqueName,
      isDraft: raw.isDraft,
      sourceBranch,
      targetBranch,
      createdAt,
      headSha,
      mergeStatus,
      reviewerVotes,
      url: prFilesUrl(ref, Number(id)),
    });
  }
  return prs;
}

/** Latest documented PR iteration timestamp, with a stable creation-time fallback. */
export function latestIterationUpdatedAt(value: unknown, fallback: number): number {
  const raw = objectRecord(value);
  if (!Array.isArray(raw?.value)) return fallback;
  let latest = fallback;
  for (const candidate of raw.value) {
    const iteration = objectRecord(candidate);
    const updatedAt = typeof iteration?.updatedDate === "string" ? Date.parse(iteration.updatedDate) : Number.NaN;
    if (Number.isFinite(updatedAt)) latest = Math.max(latest, updatedAt);
  }
  return latest;
}

type PolicySummary = {
  ciStatus: PrCheckStatus;
  requiredPolicyStatus: PrCheckStatus;
};

type NormalizedPolicyEvaluation = {
  status: string;
  isBlocking: boolean;
  typeId: string;
};

function aggregatePolicyStatuses(statuses: string[]): PrCheckStatus {
  if (statuses.length === 0) return "none";
  if (statuses.some((status) => status === "rejected" || status === "broken")) return "failed";
  if (statuses.some((status) => status === "queued" || status === "running")) return "pending";
  if (statuses.some((status) => status !== "approved" && status !== "notapplicable")) return "unknown";
  return "passing";
}

/** Summarize documented ADO policy evaluations into CI and blocking-policy state. */
export function summarizePolicyEvaluations(value: unknown): PolicySummary {
  const wrapped = objectRecord(value);
  const candidates = Array.isArray(value) ? value : Array.isArray(wrapped?.value) ? wrapped.value : null;
  if (!candidates) return { ciStatus: "unknown", requiredPolicyStatus: "unknown" };

  let malformed = false;
  const evaluations: NormalizedPolicyEvaluation[] = [];
  for (const candidate of candidates) {
    const raw = objectRecord(candidate);
    const configuration = objectRecord(raw?.configuration);
    const type = objectRecord(configuration?.type);
    const status = nonEmptyString(raw?.status)?.toLowerCase();
    const typeId = nonEmptyString(type?.id)?.toLowerCase();
    if (!status || typeof configuration?.isBlocking !== "boolean" || !typeId) {
      malformed = true;
      continue;
    }
    evaluations.push({ status, isBlocking: configuration.isBlocking, typeId });
  }

  const requiredStatuses = evaluations.filter((evaluation) => evaluation.isBlocking).map((evaluation) => evaluation.status);
  const buildStatuses = evaluations.filter((evaluation) => evaluation.typeId === BUILD_POLICY_TYPE_ID).map((evaluation) => evaluation.status);
  if (malformed) {
    requiredStatuses.push("unknown");
    buildStatuses.push("unknown");
  }
  return {
    ciStatus: aggregatePolicyStatuses(buildStatuses),
    requiredPolicyStatus: aggregatePolicyStatuses(requiredStatuses),
  };
}

export type PrMergeReadinessInput = {
  isDraft: boolean;
  mergeStatus: AzurePrMergeStatus;
  unresolvedComments: number | null;
  approvals: number;
  hasBlockingVote: boolean;
  requiredPolicyStatus: PrCheckStatus;
};

/** Calculate a conservative merge readiness summary from independently fetched ADO state. */
export function calculatePrMergeReadiness(input: PrMergeReadinessInput): PrMergeReadiness {
  if (
    input.isDraft ||
    (input.unresolvedComments !== null && input.unresolvedComments > 0) ||
    input.approvals === 0 ||
    input.hasBlockingVote ||
    input.mergeStatus === "conflicts" ||
    input.mergeStatus === "rejectedByPolicy" ||
    input.mergeStatus === "failure" ||
    input.requiredPolicyStatus === "failed"
  ) return "blocked";

  if (
    input.mergeStatus === "notSet" ||
    input.mergeStatus === "queued" ||
    input.requiredPolicyStatus === "pending"
  ) return "checking";

  if (
    input.unresolvedComments === null ||
    input.mergeStatus === "unknown" ||
    input.requiredPolicyStatus === "unknown"
  ) return "unknown";

  return input.mergeStatus === "succeeded" ? "ready" : "unknown";
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

/** List every active PR in a repo, including draft PRs. */
export async function listActivePRs(ref: AzureRepoRef): Promise<AzureActivePr[]> {
  const raw = await azJson<unknown>([
    "repos", "pr", "list",
    "--org", ref.orgUrl,
    "--project", ref.project,
    "--repository", ref.repo,
    "--status", "active",
    "--top", "1000",
    "--only-show-errors",
    "-o", "json",
  ]);
  return normalizeActivePrRecords(ref, raw);
}

/** Fetch the latest code-iteration timestamp documented by ADO for one PR. */
export async function getLatestPrUpdateAt(ref: AzureRepoRef, pr: AzureActivePr): Promise<number> {
  const raw = await azJson<unknown>([
    "devops", "invoke",
    "--org", ref.orgUrl,
    "--area", "git",
    "--resource", "pullRequestIterations",
    "--route-parameters", `project=${ref.project}`, `repositoryId=${ref.repo}`, `pullRequestId=${pr.id}`,
    "--api-version", "7.1",
    "--only-show-errors",
    "-o", "json",
  ]);
  return latestIterationUpdatedAt(raw, pr.createdAt);
}

async function getPrPolicyEvaluations(ref: AzureRepoRef, prId: number): Promise<unknown> {
  return azJson<unknown>([
    "repos", "pr", "policy", "list",
    "--id", String(prId),
    "--org", ref.orgUrl,
    "--only-show-errors",
    "-o", "json",
  ]);
}

/** Fetch review comments and policy evaluations without letting one failed detail hide the other. */
export async function getPrMenuReviewDetails(
  ref: AzureRepoRef,
  pr: AzureActivePr,
  currentUser: string,
): Promise<AzurePrMenuReview> {
  const [threadsResult, policiesResult] = await Promise.allSettled([
    getPrThreadsSummary(ref, pr.id, currentUser),
    getPrPolicyEvaluations(ref, pr.id),
  ]);
  const comments = threadsResult.status === "fulfilled"
    ? {
      resolved: threadsResult.value.resolvedCount,
      total: threadsResult.value.resolvedCount + threadsResult.value.unresolvedCount,
    }
    : null;
  const policies = policiesResult.status === "fulfilled"
    ? summarizePolicyEvaluations(policiesResult.value)
    : { ciStatus: "unknown" as const, requiredPolicyStatus: "unknown" as const };
  const approvals = pr.reviewerVotes.filter((vote) => vote === 5 || vote === 10).length;
  const hasBlockingVote = pr.reviewerVotes.some((vote) => vote === -5 || vote === -10);
  return {
    comments,
    approvals,
    readiness: calculatePrMergeReadiness({
      isDraft: pr.isDraft,
      mergeStatus: pr.mergeStatus,
      unresolvedComments: comments ? comments.total - comments.resolved : null,
      approvals,
      hasBlockingVote,
      requiredPolicyStatus: policies.requiredPolicyStatus,
    }),
    ciStatus: policies.ciStatus,
  };
}

type RawPrDetails = {
  pullRequestId: number;
  title: string;
  status?: string;
  sourceRefName?: string;
  closedDate?: string | null;
  lastMergeSourceCommit?: { commitId?: string } | null;
};

export type PrResolution = {
  id: number;
  title: string;
  /** Azure PR status, lowercased ("active" | "completed" | "abandoned" | ...). */
  status: string;
  /** epoch ms of closedDate, or null while open. */
  closedAt: number | null;
  /** lastMergeSourceCommit.commitId — the commit the squash was cut from. */
  mergeSourceSha: string | null;
};

const isClosedStatus = (s: string): s is "completed" | "abandoned" => s === "completed" || s === "abandoned";

function toPrResolution(pr: RawPrDetails): PrResolution {
  return {
    id: pr.pullRequestId,
    title: pr.title,
    status: (pr.status ?? "").toLowerCase(),
    closedAt: pr.closedDate ? Date.parse(pr.closedDate) || null : null,
    mergeSourceSha: pr.lastMergeSourceCommit?.commitId ?? null,
  };
}

/** The most recently closed (completed or abandoned) PR from a branch, or null. */
export async function getCompletedPrForBranch(
  ref: AzureRepoRef,
  branch: string,
): Promise<(PrResolution & { status: "completed" | "abandoned" }) | null> {
  const raw = await azJson<RawPrDetails[]>([
    "repos", "pr", "list",
    "--org", ref.orgUrl,
    "--project", ref.project,
    "--repository", ref.repo,
    "--source-branch", branch,
    "--status", "all",
    "-o", "json",
  ]);
  const closed = raw
    .filter((pr) => pr.sourceRefName === `refs/heads/${branch}`)
    .map(toPrResolution)
    .filter((pr): pr is PrResolution & { status: "completed" | "abandoned" } => isClosedStatus(pr.status));
  closed.sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  return closed[0] ?? null;
}

/** Fetch a single PR by id (any status). Throws if the PR does not exist. */
export async function getPrById(ref: AzureRepoRef, prId: number): Promise<PrResolution> {
  const raw = await azJson<RawPrDetails>([
    "repos", "pr", "show",
    "--id", String(prId),
    "--org", ref.orgUrl,
    "-o", "json",
  ]);
  return toPrResolution(raw);
}

type RawThread = {
  id: number;
  status?: string | null;
  isDeleted?: boolean;
  threadContext?: { filePath?: string | null; rightFileStart?: { line?: number } | null } | null;
  comments?: {
    id?: number;
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
      const commentId = Number(c.id);
      if (!Number.isSafeInteger(commentId) || commentId <= 0) continue;
      const at = Date.parse(c.lastUpdatedDate || c.publishedDate || "") || 0;
      const author = c.author?.uniqueName || c.author?.displayName || "?";
      if (author !== me) {
        if (at > latestOtherCommentAt) latestOtherCommentAt = at;
        if (isUnresolved) {
          newComments.push({
            commentId,
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

/** All human comment threads on a PR (resolved + active), ordered oldest activity first. */
export async function getPrComments(ref: AzureRepoRef, prId: number): Promise<PrReviewCommentThread[]> {
  const threads = await fetchRawThreads(ref, prId);
  const out: PrReviewCommentThread[] = [];
  for (const thread of threads) {
    if (thread.isDeleted) continue;
    const textComments = (thread.comments ?? []).filter(
      (c) => !c.isDeleted && c.commentType === "text" && (c.content ?? "").trim().length > 0 &&
        Number.isSafeInteger(c.id) && Number(c.id) > 0,
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
        id: Number(c.id),
        author: c.author?.uniqueName || c.author?.displayName || "?",
        text: (c.content ?? "").trim(),
        at: Date.parse(c.lastUpdatedDate || c.publishedDate || "") || 0,
        url: prDiscussionUrl(ref, prId, thread.id),
      })),
    });
  }
  const latest = (t: PrReviewCommentThread) => t.comments.reduce((m, c) => Math.max(m, c.at), 0);
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
