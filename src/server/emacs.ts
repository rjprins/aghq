import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type ExecFileText = (
  file: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

function elispString(value: string): string {
  return JSON.stringify(value);
}

function focusSelectedFrameEval(): string {
  return [
    "    (let ((frame (selected-frame)))",
    "      (make-frame-visible frame)",
    "      (raise-frame frame)",
    "      (select-frame-set-input-focus frame))",
  ].join("\n");
}

function emacsclientEvalArgs(evalForm: string): string[] {
  return ["-n", "--reuse-frame", "--eval", evalForm];
}

function branchReviewCallEval(baseBranch?: string | null): string[] {
  const trimmedBase = baseBranch?.trim();
  if (!trimmedBase) return ["    (call-interactively 'branch-review)"];

  return [
    `    (let ((agmux-branch-review-base ${elispString(trimmedBase)}))`,
    "      (when (and (boundp 'branch-review--sessions)",
    "                 (fboundp 'branch-review-session-base)",
    "                 (fboundp 'branch-review--teardown)",
    "                 (fboundp 'magit-toplevel))",
    "        (let* ((root (magit-toplevel))",
    "               (session (and root (gethash root branch-review--sessions))))",
    "          (when (and session",
    "                     (not (equal (branch-review-session-base session) agmux-branch-review-base)))",
    "            (branch-review--teardown session))))",
    "      (let ((branch-review-base-branch-fallbacks",
    "             (cons agmux-branch-review-base branch-review-base-branch-fallbacks)))",
    "        (call-interactively 'branch-review)))",
  ];
}

export function buildBranchReviewEval(worktreePath: string, baseBranch?: string | null): string {
  return [
    "(progn",
    "  (require 'branch-review nil t)",
    `  (let ((default-directory (file-name-as-directory ${elispString(path.resolve(worktreePath))})))`,
    ...branchReviewCallEval(baseBranch),
    `${focusSelectedFrameEval()}))`,
  ].join("\n");
}

export function buildMagitStatusEval(worktreePath: string): string {
  return [
    "(progn",
    "  (require 'magit nil t)",
    `  (let ((default-directory (file-name-as-directory ${elispString(path.resolve(worktreePath))})))`,
    "    (call-interactively 'magit-status)",
    `${focusSelectedFrameEval()}))`,
  ].join("\n");
}

export async function resolveGitWorktreeRoot(cwd: string, execFileText: ExecFileText = execFile): Promise<string> {
  const resolvedCwd = path.resolve(cwd);
  try {
    const { stdout } = await execFileText("git", ["rev-parse", "--show-toplevel"], {
      cwd: resolvedCwd,
      timeout: 5000,
    });
    const gitRoot = stdout.trim();
    return gitRoot ? path.resolve(gitRoot) : resolvedCwd;
  } catch {
    return resolvedCwd;
  }
}

async function gitText(cwd: string, args: string[], execFileText: ExecFileText): Promise<string | null> {
  try {
    const { stdout } = await execFileText("git", args, {
      cwd,
      timeout: 5000,
    });
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

async function gitRefExists(cwd: string, ref: string, execFileText: ExecFileText): Promise<boolean> {
  const trimmed = ref.trim();
  if (!trimmed) return false;
  return (await gitText(cwd, ["rev-parse", "--verify", "--quiet", `${trimmed}^{commit}`], execFileText)) != null;
}

function parseRebaseOntoTarget(reflog: string, currentBranch: string): string | null {
  const currentRef = `refs/heads/${currentBranch}`;
  for (const line of reflog.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const finishMatch = /^rebase \(finish\): (?:returning to )?(.+?) onto ([^\s]+)$/.exec(trimmed);
    if (!finishMatch) continue;
    const rebasedRef = finishMatch[1]?.trim();
    const onto = finishMatch[2]?.trim();
    if (!onto) continue;
    if (rebasedRef && rebasedRef !== currentRef && rebasedRef !== currentBranch) continue;
    return onto;
  }
  return null;
}

function branchNameForRebaseTarget(refs: string, currentBranch: string): string | null {
  const currentRemote = `origin/${currentBranch}`;
  const candidates = refs
    .split("\n")
    .map((line) => line.trim())
    .filter((ref) => ref && ref !== "origin/HEAD" && ref !== currentBranch && ref !== currentRemote);
  return candidates.find((ref) => !ref.includes("/")) ?? candidates.find((ref) => !ref.startsWith("origin/")) ?? candidates[0] ?? null;
}

async function resolveReflogRebaseBaseBranch(
  cwd: string,
  currentBranch: string,
  execFileText: ExecFileText,
): Promise<string | null> {
  const reflog = await gitText(cwd, ["reflog", "show", "--format=%gs", currentBranch], execFileText);
  if (!reflog) return null;
  const target = parseRebaseOntoTarget(reflog, currentBranch);
  if (!target || !(await gitRefExists(cwd, target, execFileText))) return null;
  const refs = await gitText(cwd, ["for-each-ref", "--points-at", target, "--format=%(refname:short)", "refs/heads", "refs/remotes"], execFileText);
  return (refs && branchNameForRebaseTarget(refs, currentBranch)) ?? target;
}

function upstreamTracksCurrentBranch(upstream: string, currentBranch: string): boolean {
  const upstreamBranch = upstream
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\/[^/]+\//, "");
  return upstreamBranch === currentBranch;
}

export async function resolveBranchReviewBaseBranch(
  cwd: string,
  execFileText: ExecFileText = execFile,
): Promise<string | null> {
  const resolvedCwd = path.resolve(cwd);
  const currentBranch = await gitText(resolvedCwd, ["branch", "--show-current"], execFileText);
  if (!currentBranch) return null;

  // VS Code and GitHub tooling store an explicit review/PR base in branch-local
  // config. Prefer that over upstream, because feature branches often track
  // origin/<feature> while their review base is origin/main or similar.
  for (const key of ["vscode-merge-base", "gh-merge-base", "agmux-base-branch", "merge-base"]) {
    const candidate = await gitText(resolvedCwd, ["config", "--get", `branch.${currentBranch}.${key}`], execFileText);
    if (candidate && await gitRefExists(resolvedCwd, candidate, execFileText)) return candidate;
  }

  const rebaseBase = await resolveReflogRebaseBaseBranch(resolvedCwd, currentBranch, execFileText);
  if (rebaseBase) return rebaseBase;

  const upstream = await gitText(resolvedCwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], execFileText);
  if (upstream && !upstreamTracksCurrentBranch(upstream, currentBranch)) {
    if (await gitRefExists(resolvedCwd, upstream, execFileText)) return upstream;
  }

  return null;
}

export async function openBranchReviewInEmacs(
  cwd: string,
  execFileText: ExecFileText = execFile,
): Promise<{ path: string }> {
  const worktreePath = await resolveGitWorktreeRoot(cwd, execFileText);
  const baseBranch = await resolveBranchReviewBaseBranch(worktreePath, execFileText);
  const emacsclient = process.env.AGMUX_EMACSCLIENT?.trim() || "emacsclient";
  await execFileText(emacsclient, emacsclientEvalArgs(buildBranchReviewEval(worktreePath, baseBranch)), {
    timeout: 10_000,
  });
  return { path: worktreePath };
}

export async function openMagitInEmacs(
  cwd: string,
  execFileText: ExecFileText = execFile,
): Promise<{ path: string }> {
  const worktreePath = await resolveGitWorktreeRoot(cwd, execFileText);
  const emacsclient = process.env.AGMUX_EMACSCLIENT?.trim() || "emacsclient";
  await execFileText(emacsclient, emacsclientEvalArgs(buildMagitStatusEval(worktreePath)), {
    timeout: 10_000,
  });
  return { path: worktreePath };
}
