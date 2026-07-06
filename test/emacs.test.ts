import { describe, expect, test } from "vitest";

import {
  buildBranchReviewEval,
  buildMagitStatusEval,
  openBranchReviewInEmacs,
  openMagitInEmacs,
  resolveBranchReviewBaseBranch,
  resolveGitWorktreeRoot,
  type ExecFileText,
} from "../src/server/emacs.js";

describe("emacs branch-review integration", () => {
  test("builds an eval form with the worktree as default-directory", () => {
    const form = buildBranchReviewEval("/tmp/project feature");

    expect(form).toContain("(require 'branch-review nil t)");
    expect(form).toContain('(file-name-as-directory "/tmp/project feature")');
    // No base resolved -> plain branch-review (auto-detect), not a base prompt.
    expect(form).toContain("(call-interactively 'branch-review)");
    expect(form).not.toContain("branch-review-with-base");
    // Reuse an existing GUI frame via display-graphic-p (the `window-system`
    // frame parameter is unset on GUI frames), else create one.
    expect(form).toContain("(filtered-frame-list #'display-graphic-p)");
    expect(form).not.toContain("'window-system");
    expect(form).toContain("make-frame-on-display");
    expect(form).toContain("(select-frame frame)");
    expect(form).toContain("(make-frame-visible frame)");
    expect(form).toContain("(raise-frame frame)");
    expect(form).toContain("(select-frame-set-input-focus frame)");
  });

  test("builds an eval form that prefers a configured base branch", () => {
    const form = buildBranchReviewEval("/tmp/project feature", "origin/develop");

    expect(form).toContain('(let ((agmux-branch-review-base "origin/develop"))');
    expect(form).toContain("(symbol-function 'magit-read-branch-or-commit)");
    expect(form).toContain("(call-interactively 'branch-review-with-base)");
    expect(form).not.toContain("branch-review-base-branch-fallbacks");
  });

  test("builds a Magit status eval form with the worktree as default-directory", () => {
    const form = buildMagitStatusEval("/tmp/project feature");

    expect(form).toContain("(require 'magit nil t)");
    expect(form).toContain('(file-name-as-directory "/tmp/project feature")');
    expect(form).toContain("(call-interactively 'magit-status)");
    expect(form).toContain("(filtered-frame-list #'display-graphic-p)");
    expect(form).toContain("(select-frame frame)");
    expect(form).toContain("(make-frame-visible frame)");
    expect(form).toContain("(raise-frame frame)");
    expect(form).toContain("(select-frame-set-input-focus frame)");
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

  test("resolves branch-review base branch from current branch merge-base config", async () => {
    const calls: Array<{ file: string; args: string[]; cwd?: string }> = [];
    const execFileText: ExecFileText = async (file, args, options) => {
      calls.push({ file, args, cwd: options?.cwd });
      if (args.join(" ") === "branch --show-current") return { stdout: "feature/review\n", stderr: "" };
      if (args.join(" ") === "config --get branch.feature/review.vscode-merge-base") {
        return { stdout: "origin/develop\n", stderr: "" };
      }
      if (args.join(" ") === "rev-parse --verify --quiet origin/develop^{commit}") {
        return { stdout: "abc123\n", stderr: "" };
      }
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    };

    await expect(resolveBranchReviewBaseBranch("/repo/worktree", execFileText)).resolves.toBe("origin/develop");
    expect(calls.map((call) => call.args)).toEqual([
      ["branch", "--show-current"],
      ["config", "--get", "branch.feature/review.vscode-merge-base"],
      ["rev-parse", "--verify", "--quiet", "origin/develop^{commit}"],
    ]);
  });

  test("resolves branch-review base branch for slash-delimited worktree branches", async () => {
    const execFileText: ExecFileText = async (file, args) => {
      if (file !== "git") throw new Error(`unexpected command: ${file}`);
      if (args.join(" ") === "branch --show-current") return { stdout: "feat/sample-app-04-auth\n", stderr: "" };
      if (args.join(" ") === "config --get branch.feat/sample-app-04-auth.vscode-merge-base") {
        return { stdout: "origin/feat/sample-app-03-api\n", stderr: "" };
      }
      if (args.join(" ") === "rev-parse --verify --quiet origin/feat/sample-app-03-api^{commit}") {
        return { stdout: "abc123\n", stderr: "" };
      }
      throw new Error(`unexpected git command: ${args.join(" ")}`);
    };

    await expect(resolveBranchReviewBaseBranch("/home/user/sample/sample-app-04-auth", execFileText)).resolves.toBe(
      "origin/feat/sample-app-03-api",
    );
  });

  test("resolves branch-review base branch from the latest rebase target", async () => {
    const execFileText: ExecFileText = async (file, args) => {
      if (file !== "git") throw new Error(`unexpected command: ${file}`);
      if (args.join(" ") === "branch --show-current") return { stdout: "feat/sample-app-02-db\n", stderr: "" };
      if (args[0] === "config") throw new Error("no explicit branch base config");
      if (args.join(" ") === "reflog show --format=%gs feat/sample-app-02-db") {
        return {
          stdout: [
            "commit (amend): database layer",
            "rebase (finish): refs/heads/feat/sample-app-02-db onto 5df06c1043ab59aed0a830ae9ee12bff14cbd581",
            "commit: older work",
          ].join("\n"),
          stderr: "",
        };
      }
      if (args.join(" ") === "rev-parse --verify --quiet 5df06c1043ab59aed0a830ae9ee12bff14cbd581^{commit}") {
        return { stdout: "5df06c1043ab59aed0a830ae9ee12bff14cbd581\n", stderr: "" };
      }
      if (
        args.join(" ") ===
        "for-each-ref --points-at 5df06c1043ab59aed0a830ae9ee12bff14cbd581 --format=%(refname:short) refs/heads refs/remotes"
      ) {
        return { stdout: "origin/feat/sample-app-01-frontend\nfeat/sample-app-01-frontend\n", stderr: "" };
      }
      throw new Error(`unexpected git command: ${args.join(" ")}`);
    };

    await expect(resolveBranchReviewBaseBranch("/repo/worktree", execFileText)).resolves.toBe(
      "feat/sample-app-01-frontend",
    );
  });

  test("opens branch-review through emacsclient", async () => {
    const calls: Array<{ file: string; args: string[]; cwd?: string }> = [];
    const execFileText: ExecFileText = async (file, args, options) => {
      calls.push({ file, args, cwd: options?.cwd });
      if (args.join(" ") === "rev-parse --show-toplevel") return { stdout: "/repo/worktree\n", stderr: "" };
      if (args.join(" ") === "branch --show-current") return { stdout: "feature/review\n", stderr: "" };
      if (args.join(" ") === "config --get branch.feature/review.vscode-merge-base") {
        return { stdout: "origin/develop\n", stderr: "" };
      }
      if (args.join(" ") === "rev-parse --verify --quiet origin/develop^{commit}") {
        return { stdout: "abc123\n", stderr: "" };
      }
      if (file === "git") throw new Error(`unexpected git command: ${args.join(" ")}`);
      return { stdout: "", stderr: "" };
    };

    await expect(openBranchReviewInEmacs("/repo/worktree/src", execFileText)).resolves.toEqual({
      path: "/repo/worktree",
    });
    const emacsCall = calls.find((call) => call.file === "emacsclient");
    // -a "" auto-starts a daemon when no server is reachable. No --reuse-frame:
    // it makes emacsclient create a frame, which fails without DISPLAY.
    expect(emacsCall?.args.slice(0, 4)).toEqual(["-n", "-a", "", "--eval"]);
    const form = emacsCall?.args[4] ?? "";
    expect(form).toContain("/repo/worktree");
    expect(form).toContain("origin/develop");
    expect(form).toContain("branch-review-with-base");
    expect(form).toContain("select-frame-set-input-focus");
  });

  test("opens Magit through emacsclient", async () => {
    const calls: Array<{ file: string; args: string[]; cwd?: string }> = [];
    const execFileText: ExecFileText = async (file, args, options) => {
      calls.push({ file, args, cwd: options?.cwd });
      if (file === "git") return { stdout: "/repo/worktree\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };

    await expect(openMagitInEmacs("/repo/worktree/src", execFileText)).resolves.toEqual({
      path: "/repo/worktree",
    });
    expect(calls[1]?.file).toBe("emacsclient");
    expect(calls[1]?.args.slice(0, 4)).toEqual(["-n", "-a", "", "--eval"]);
    const magitForm = calls[1]?.args[4] ?? "";
    expect(magitForm).toContain("/repo/worktree");
    expect(magitForm).toContain("magit-status");
    expect(magitForm).toContain("select-frame-set-input-focus");
  });
});
