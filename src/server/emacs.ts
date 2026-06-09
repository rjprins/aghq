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

export function buildBranchReviewEval(worktreePath: string): string {
  return [
    "(progn",
    "  (require 'branch-review nil t)",
    `  (let ((default-directory (file-name-as-directory ${elispString(path.resolve(worktreePath))})))`,
    "    (call-interactively 'branch-review)",
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

export async function openBranchReviewInEmacs(
  cwd: string,
  execFileText: ExecFileText = execFile,
): Promise<{ path: string }> {
  const worktreePath = await resolveGitWorktreeRoot(cwd, execFileText);
  const emacsclient = process.env.AGMUX_EMACSCLIENT?.trim() || "emacsclient";
  await execFileText(emacsclient, emacsclientEvalArgs(buildBranchReviewEval(worktreePath)), {
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
