import type { PtySummary } from "../shared/protocol.js";

export type PtyReorderPlacement = "before" | "after";

function sidebarBasename(input: string): string {
  const segments = input.split("/").filter(Boolean);
  return segments.at(-1) ?? input;
}

export function compareSidebarGroupKeys(a: string, b: string): number {
  if (!a) return 1;
  if (!b) return -1;
  return sidebarBasename(a).localeCompare(sidebarBasename(b));
}

export function compareSidebarWorktreeKeys(a: string | null, b: string | null): number {
  const left = a?.trim() || "";
  const right = b?.trim() || "";
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

export function orderRunningPtysForSidebar(
  ptys: PtySummary[],
  opts: {
    pinnedDirectories: ReadonlySet<string>;
    getGroupKey: (pty: PtySummary) => string;
    getWorktreeKey?: (pty: PtySummary) => string | null;
    manualOrder?: readonly string[];
  },
): PtySummary[] {
  const runningByDir = new Map<string, PtySummary[]>();
  for (const pty of ptys) {
    if (pty.status !== "running") continue;
    const key = opts.getGroupKey(pty);
    const items = runningByDir.get(key);
    if (items) {
      items.push(pty);
    } else {
      runningByDir.set(key, [pty]);
    }
  }

  for (const items of runningByDir.values()) {
    items.sort((a, b) => a.createdAt - b.createdAt);
  }

  const orderedKeys = [
    ...[...runningByDir.keys()].filter((key) => opts.pinnedDirectories.has(key)).sort(compareSidebarGroupKeys),
    ...[...runningByDir.keys()].filter((key) => !opts.pinnedDirectories.has(key)).sort(compareSidebarGroupKeys),
  ];

  const manualOrderIndex = new Map((opts.manualOrder ?? []).map((id, index) => [id, index]));
  return orderedKeys.flatMap((key) => {
    const items = runningByDir.get(key) ?? [];
    return [...items].sort((a, b) => {
      if (opts.getWorktreeKey) {
        const worktreeOrder = compareSidebarWorktreeKeys(opts.getWorktreeKey(a), opts.getWorktreeKey(b));
        if (worktreeOrder !== 0) return worktreeOrder;
      }
      if (manualOrderIndex.size === 0) return 0;
      const aIndex = manualOrderIndex.get(a.id);
      const bIndex = manualOrderIndex.get(b.id);
      if (aIndex === undefined && bIndex === undefined) return 0;
      if (aIndex === undefined) return 1;
      if (bIndex === undefined) return -1;
      return aIndex - bIndex;
    });
  });
}

export function reorderPtyIds(
  ids: readonly string[],
  sourceId: string,
  targetId: string,
  placement: PtyReorderPlacement,
): string[] {
  if (sourceId === targetId) return [...ids];
  if (!ids.includes(sourceId) || !ids.includes(targetId)) return [...ids];
  const withoutSource = ids.filter((id) => id !== sourceId);
  const targetIndex = withoutSource.indexOf(targetId);
  if (targetIndex === -1) return [...ids];
  const insertIndex = placement === "after" ? targetIndex + 1 : targetIndex;
  return [
    ...withoutSource.slice(0, insertIndex),
    sourceId,
    ...withoutSource.slice(insertIndex),
  ];
}

function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

function findMatchingPtyIndex(
  ptys: PtySummary[],
  startIdx: number,
  direction: 1 | -1,
  matches: (pty: PtySummary) => boolean,
): number {
  for (let i = 1; i <= ptys.length; i += 1) {
    const idx = wrapIndex(startIdx + (i * direction), ptys.length);
    if (matches(ptys[idx])) return idx;
  }
  return -1;
}

export function findRunningPtyByOffset(
  ptys: PtySummary[],
  activePtyId: string | null,
  offset: number,
  opts?: {
    isVisible?: (pty: PtySummary) => boolean;
  },
): PtySummary | null {
  if (ptys.length === 0) return null;
  if (offset === 0) return ptys.find((pty) => pty.id === activePtyId) ?? null;
  const direction: 1 | -1 = offset > 0 ? 1 : -1;
  const steps = Math.abs(offset);
  const isVisible = opts?.isVisible ?? (() => true);
  let cursor = ptys.findIndex((pty) => pty.id === activePtyId);
  if (cursor === -1 && direction < 0) cursor = 0;
  for (let step = 0; step < steps; step += 1) {
    cursor = findMatchingPtyIndex(ptys, cursor, direction, isVisible);
    if (cursor === -1) return null;
  }
  return ptys[cursor] ?? null;
}

export function findNextReadyRunningPty(
  ptys: PtySummary[],
  activePtyId: string | null,
  opts: {
    isReady: (pty: PtySummary) => boolean;
    isVisible?: (pty: PtySummary) => boolean;
  },
): PtySummary | null {
  if (ptys.length === 0) return null;
  const startIdx = ptys.findIndex((pty) => pty.id === activePtyId);
  const isVisible = opts.isVisible ?? (() => true);
  const idx = findMatchingPtyIndex(ptys, startIdx, 1, (pty) => isVisible(pty) && opts.isReady(pty));
  return idx === -1 ? null : (ptys[idx] ?? null);
}
