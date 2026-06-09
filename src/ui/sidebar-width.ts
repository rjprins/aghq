export const SIDEBAR_WIDTH_DEFAULT = 280;
export const SIDEBAR_WIDTH_MIN = 220;
export const SIDEBAR_WIDTH_MAX = 560;
export const SIDEBAR_WIDTH_STEP = 16;
export const TERMINAL_WIDTH_MIN = 360;

export function maxSidebarWidthForViewport(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return SIDEBAR_WIDTH_MAX;
  const viewportMax = Math.round(viewportWidth) - TERMINAL_WIDTH_MIN;
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, viewportMax));
}

export function normalizeSidebarWidth(width: number, viewportWidth = Number.POSITIVE_INFINITY): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(maxSidebarWidthForViewport(viewportWidth), Math.round(width)));
}

export function parseStoredSidebarWidth(raw: string | null, viewportWidth = Number.POSITIVE_INFINITY): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return normalizeSidebarWidth(parsed, viewportWidth);
}

export function adjustSidebarWidth(
  currentWidth: number,
  delta: number,
  viewportWidth = Number.POSITIVE_INFINITY,
): number {
  return normalizeSidebarWidth(currentWidth + delta, viewportWidth);
}
