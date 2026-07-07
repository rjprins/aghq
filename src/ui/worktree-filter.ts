import type { WorktreeAnnotated } from "../shared/worktrees.js";

/** Case-insensitive substring match over a row's searchable fields. Pass `q` pre-lowercased. */
export function rowMatchesFilter(w: WorktreeAnnotated, q: string): boolean {
  if (!q) return true;
  const hay = [w.branch, w.name, w.label, w.ticketId, w.prTitle, w.firstPrompt, w.path]
    .filter((s): s is string => Boolean(s))
    .join("\n")
    .toLowerCase();
  return hay.includes(q);
}
