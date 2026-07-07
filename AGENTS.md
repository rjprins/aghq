# Agent conventions for this repo

## Worktrees

- Placement: sibling of the repo — `../agmux-<branch>` (template `../{repo-name}-{branch}`; per-repo override lives in `git config agmux.worktreeTemplate`).
- The directory basename ends with the branch name. Never reuse a directory for a different branch.
- Create through agmux when it's running: `POST http://127.0.0.1:4821/api/worktrees/create {projectRoot, branch?, purpose}` — purpose is required, it's what makes the worktree findable later. Fallback: `git worktree add -b <branch> ../agmux-<branch>` from the repo root.
- Never create worktrees under `.worktrees/` (retired layout).
- Remove only through the agmux funnel (`POST /api/worktrees/reap` or the Worktrees panel) — it salvages uncommitted files and attic-tags branch tips (`git tag -l 'attic/*'`) before any deletion. Never `git worktree remove --force` or `git branch -D` by hand.
