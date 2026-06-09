import { describe, expect, test } from "vitest";

import {
  buildBranchReviewEval,
  openBranchReviewInEmacs,
  resolveGitWorktreeRoot,
  type ExecFileText,
} from "../src/server/emacs.js";

describe("emacs branch-review integration", () => {
  test("builds an eval form with the worktree as default-directory", () => {
    const form = buildBranchReviewEval("/tmp/project feature");

    expect(form).toContain("(require 'branch-review nil t)");
    expect(form).toContain('(file-name-as-directory "/tmp/project feature")');
    expect(form).toContain("(call-interactively 'branch-review)");
  });

  test("resolves a nested cwd to the git worktree root", async () => {
    const calls: Array<{ file: string; args: string[]; cwd?: string }> = [];
    const execFileText: ExecFileText = async (file, args, options) => {
      calls.push({ file, args, cwd: options?.cwd });
      return { stdout: "/repo/worktree\n", stderr: "" };
    };

    await expect(resolveGitWorktreeRoot("/repo/worktree/src", execFileText)).resolves.toBe("/repo/worktree");
    expect(calls).toEqual([
      { file: "git", args: ["rev-parse", "--show-toplevel"], cwd: "/repo/worktree/src" },
    ]);
  });

  test("opens branch-review through emacsclient", async () => {
    const calls: Array<{ file: string; args: string[]; cwd?: string }> = [];
    const execFileText: ExecFileText = async (file, args, options) => {
      calls.push({ file, args, cwd: options?.cwd });
      if (file === "git") return { stdout: "/repo/worktree\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };

    await expect(openBranchReviewInEmacs("/repo/worktree/src", execFileText)).resolves.toEqual({
      path: "/repo/worktree",
    });
    expect(calls[1]?.file).toBe("emacsclient");
    expect(calls[1]?.args[0]).toBe("-n");
    expect(calls[1]?.args[1]).toBe("--eval");
    expect(calls[1]?.args[2]).toContain("/repo/worktree");
  });
});
