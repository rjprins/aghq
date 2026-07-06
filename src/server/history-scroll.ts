import type { TmuxServer } from "../tmux.js";
import {
  tmuxCaptureHistoryRegion,
  tmuxGotoHistoryScroll,
  tmuxPanePosition,
  tmuxSearchHistoryText,
} from "../tmux.js";

// ---------------------------------------------------------------------------
// Input anchors: where in the pane's scrollback each submit happened.
//
// Terminal scrollback lives in tmux, so the only reliable way to find a past
// prompt again is to remember its absolute line (history_size + cursor_y) at
// the moment it was submitted, keyed by time. Transcript messages carry
// timestamps, so ts is the join key between "what was said" (JSONL logs) and
// "where it landed" (pane lines).
// ---------------------------------------------------------------------------

export type InputAnchor = {
  ts: number;
  line: number;
};

const MAX_ANCHORS_PER_PTY = 200;

export class InputAnchorStore {
  private byPty = new Map<string, InputAnchor[]>();

  record(ptyId: string, anchor: InputAnchor): void {
    const list = this.byPty.get(ptyId) ?? [];
    list.push(anchor);
    if (list.length > MAX_ANCHORS_PER_PTY) list.splice(0, list.length - MAX_ANCHORS_PER_PTY);
    this.byPty.set(ptyId, list);
  }

  // The anchor sampled closest in time to ts. A submit and its log entry (or
  // its client-side history entry) are stamped within ~1s of each other, so
  // nearest-by-time is the join that survives rapid successive prompts —
  // latest-at-or-before with slack would grab the next submit's anchor.
  closestTo(ptyId: string, ts: number, maxDeltaMs = 15_000): InputAnchor | null {
    const list = this.byPty.get(ptyId);
    if (!list || list.length === 0) return null;
    let best: InputAnchor | null = null;
    for (const anchor of list) {
      if (best == null || Math.abs(anchor.ts - ts) < Math.abs(best.ts - ts)) best = anchor;
    }
    if (best == null || Math.abs(best.ts - ts) > maxDeltaMs) return null;
    return best;
  }

  clear(ptyId: string): void {
    this.byPty.delete(ptyId);
  }
}

// ---------------------------------------------------------------------------
// Text locating
// ---------------------------------------------------------------------------

function compactWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Reduce a history entry to a needle that survives how terminals render it:
// first line only (multi-line prompts echo their first line), whitespace
// compacted, truncation ellipsis dropped, capped at a word boundary so the
// needle fits within one grid line even in narrow panes.
export function historyNeedle(text: string, max = 60): string {
  const firstLine = text.split("\n", 1)[0] ?? "";
  let q = compactWhitespace(firstLine);
  if (q.endsWith("...")) q = q.slice(0, -3).trimEnd();
  if (q.length > max) {
    const cut = q.slice(0, max);
    const lastSpace = cut.lastIndexOf(" ");
    q = lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut;
  }
  return q.trim();
}

// Find the absolute line of the best needle match in a captured region.
// Prefers the occurrence closest to the estimate (disambiguates repeated
// commands); otherwise the most recent one. Case-insensitive fallback covers
// renderers that restyle text.
export function locateInLines(
  lines: string[],
  regionStartLine: number,
  needle: string,
  estimateLine: number | null,
): number | null {
  if (!needle) return null;
  const matches: number[] = [];
  const lowered = needle.toLowerCase();
  let caseSensitive = true;
  for (let pass = 0; pass < 2 && matches.length === 0; pass++) {
    caseSensitive = pass === 0;
    for (let i = 0; i < lines.length; i++) {
      const line = compactWhitespace(lines[i]);
      const hit = caseSensitive ? line.includes(needle) : line.toLowerCase().includes(lowered);
      if (hit) matches.push(regionStartLine + i);
    }
  }
  if (matches.length === 0) return null;
  if (estimateLine == null) return matches[matches.length - 1];
  let best = matches[0];
  for (const m of matches) {
    if (Math.abs(m - estimateLine) < Math.abs(best - estimateLine)) best = m;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Resolution: anchor estimate -> narrow capture -> wide capture -> fallbacks
// ---------------------------------------------------------------------------

const NARROW_BEFORE = 120;
const NARROW_AFTER = 240;
const WIDE_SCAN_LINES = 5_000;
const TOP_CONTEXT_LINES = 3;

export async function scrollTmuxToHistoryEntry(opts: {
  tmuxSession: string;
  tmuxServer?: TmuxServer | null;
  text: string;
  anchor?: InputAnchor | null;
}): Promise<void> {
  const { tmuxSession, tmuxServer, text } = opts;
  const needle = historyNeedle(text);
  if (!needle) return;

  const pos = await tmuxPanePosition(tmuxSession, tmuxServer);
  if (!pos) {
    await tmuxSearchHistoryText(tmuxSession, needle, tmuxServer);
    return;
  }
  const bottomLine = pos.historySize + pos.paneHeight - 1;
  const estimate = opts.anchor?.line ?? null;

  let found: number | null = null;
  if (estimate != null) {
    const start = Math.max(0, estimate - NARROW_BEFORE);
    const end = Math.min(bottomLine, estimate + NARROW_AFTER);
    const lines = await tmuxCaptureHistoryRegion(tmuxSession, pos.historySize, start, end, tmuxServer);
    if (lines) found = locateInLines(lines, start, needle, estimate);
  }
  if (found == null) {
    const start = Math.max(0, bottomLine - WIDE_SCAN_LINES);
    const lines = await tmuxCaptureHistoryRegion(tmuxSession, pos.historySize, start, bottomLine, tmuxServer);
    if (lines) found = locateInLines(lines, start, needle, estimate);
  }

  const target = found ?? estimate;
  if (target == null) {
    await tmuxSearchHistoryText(tmuxSession, needle, tmuxServer);
    return;
  }
  const scroll = Math.min(pos.historySize, Math.max(0, pos.historySize - target + TOP_CONTEXT_LINES));
  await tmuxGotoHistoryScroll(tmuxSession, scroll, tmuxServer);
}
