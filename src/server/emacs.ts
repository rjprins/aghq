import { execFile as execFileCallback } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type ExecFileText = (
  file: string,
  args: string[],
  options?: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

function elispString(value: string): string {
  return JSON.stringify(value);
}

// Reuse an existing GUI frame, otherwise create one, then raise it. Done in
// elisp because the agmux server runs headless (no DISPLAY): emacsclient flags
// like --reuse-frame fail trying to create a frame of their own. When we fall
// back to an auto-started daemon (-a "" below) there is no GUI frame yet, so we
// create one on $DISPLAY (the daemon inherits it from the emacsclient env).
function withRaisedFrameEval(bodyLines: string[]): string[] {
  return [
    "  (let ((frame (or (car (filtered-frame-list #'display-graphic-p))",
    "                   (let ((d (or (getenv \"DISPLAY\") (getenv \"WAYLAND_DISPLAY\"))))",
    "                     (and d (ignore-errors (make-frame-on-display d))))",
    "                   (selected-frame))))",
    "    (select-frame frame)",
    ...bodyLines,
    "    (make-frame-visible frame)",
    "    (raise-frame frame)",
    "    (select-frame-set-input-focus frame))",
  ];
}

// `-a ""` makes emacsclient start an Emacs daemon when no server is reachable
// (loading the user's init, so branch-review/magit are available) instead of
// failing. When a server is already running it just connects, so this is a
// no-op on the happy path.
function emacsclientEvalArgs(evalForm: string): string[] {
  return ["-n", "-a", "", "--eval", evalForm];
}

function branchReviewCallEval(baseBranch?: string | null): string[] {
  const trimmedBase = baseBranch?.trim();
  // No base resolved: plain `branch-review` auto-detects one (origin/main etc.).
  // `branch-review-with-base` would instead pop a blocking minibuffer prompt,
  // leaving the button looking dead until someone types into Emacs.
  if (!trimmedBase) return ["      (call-interactively 'branch-review)"];

  return [
    `      (let ((agmux-branch-review-base ${elispString(trimmedBase)}))`,
    "        (require 'cl-lib)",
    "        (cl-letf (((symbol-function 'magit-read-branch-or-commit)",
    "                   (lambda (&rest _) agmux-branch-review-base)))",
    "          (call-interactively 'branch-review-with-base)))",
  ];
}

export function buildBranchReviewEval(worktreePath: string, baseBranch?: string | null): string {
  return [
    "(progn",
    "  (require 'branch-review nil t)",
    ...withRaisedFrameEval([
      `    (let ((default-directory (file-name-as-directory ${elispString(path.resolve(worktreePath))})))`,
      ...branchReviewCallEval(baseBranch),
      "      )",
    ]),
    "  )",
  ].join("\n");
}

export function buildMagitStatusEval(worktreePath: string): string {
  return [
    "(progn",
    "  (require 'magit nil t)",
    ...withRaisedFrameEval([
      `    (let ((default-directory (file-name-as-directory ${elispString(path.resolve(worktreePath))})))`,
      "      (call-interactively 'magit-status))",
    ]),
    "  )",
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

// A daemon auto-started by `-a ""` inherits this process's environment. The
// agmux service usually runs headless, so hand it a graphical environment
// (falling back to the GNOME/mutter Xwayland cookie) so it can open a real
// window. Overridable via AGMUX_EMACS_DISPLAY / AGMUX_EMACS_XAUTHORITY.
export function resolveEmacsGraphicalEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const display = env.AGMUX_EMACS_DISPLAY?.trim() || env.DISPLAY?.trim() || ":0";
  out.DISPLAY = display;

  let xauth = env.AGMUX_EMACS_XAUTHORITY?.trim() || env.XAUTHORITY?.trim();
  if (!xauth) {
    const runtimeDir = env.XDG_RUNTIME_DIR?.trim() || (process.getuid ? `/run/user/${process.getuid()}` : "");
    if (runtimeDir) {
      try {
        const cookie = readdirSync(runtimeDir).find((name) => name.startsWith(".mutter-Xwaylandauth."));
        if (cookie) xauth = path.join(runtimeDir, cookie);
      } catch {
        // no runtime dir / not readable — leave XAUTHORITY unset
      }
    }
  }
  if (xauth) out.XAUTHORITY = xauth;
  return out;
}

// Cold-starting a daemon loads the full user init, which can take a while.
const EMACS_EVAL_TIMEOUT_MS = 30_000;

export async function openBranchReviewInEmacs(
  cwd: string,
  execFileText: ExecFileText = execFile,
): Promise<{ path: string }> {
  const worktreePath = await resolveGitWorktreeRoot(cwd, execFileText);
  const baseBranch = await resolveBranchReviewBaseBranch(worktreePath, execFileText);
  const emacsclient = process.env.AGMUX_EMACSCLIENT?.trim() || "emacsclient";
  await execFileText(emacsclient, emacsclientEvalArgs(buildBranchReviewEval(worktreePath, baseBranch)), {
    timeout: EMACS_EVAL_TIMEOUT_MS,
    env: resolveEmacsGraphicalEnv(),
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
    timeout: EMACS_EVAL_TIMEOUT_MS,
    env: resolveEmacsGraphicalEnv(),
  });
  return { path: worktreePath };
}
