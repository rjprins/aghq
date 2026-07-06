import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import {
  THEMES,
  DEFAULT_THEME_KEY,
  SYSTEM_THEME_DARK_TO_LIGHT,
  applyTheme,
  getSystemThemeDarkFallbackKey,
  isSystemThemeDarkKey,
  resolveSystemThemeKey,
  type Theme,
} from "./themes";
import type {
  AgentSessionSummary,
  PtyReadinessIndicator,
  PtyReadinessState,
  PtySummary,
  ServerToClientMessage,
  TmuxSessionCheck,
  TmuxSessionInfo,
} from "../shared/protocol.js";
import {
  renderPtyList,
  type InactiveGroup,
  type InactivePtyItem,
  type InactiveWorktreeSubgroup,
  type PtyGroup,
  type PtyListModel,
  type RunningPtyItem,
  type WorktreeSubgroup,
} from "./pty-list-view";
import {
  renderLaunchModal,
  type LaunchModalViewModel,
  type LaunchOptionControl,
} from "./launch-modal-view";
import {
  renderCloseWorktreeModal,
  type CloseWorktreeModalViewModel,
} from "./close-worktree-modal-view";
import {
  findContainingWorktree,
  isMainWorktreeForCwd,
  type KnownWorktreeSummary,
} from "./worktree-match";
import {
  compareSidebarGroupKeys,
  findNextReadyRunningPty,
  findRunningPtyByOffset,
  orderRunningPtysForSidebar,
  reorderPtyIds,
  type PtyReorderPlacement,
} from "./pty-order";
import {
  adjustSidebarWidth,
  maxSidebarWidthForViewport,
  normalizeSidebarWidth,
  parseStoredSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_STEP,
} from "./sidebar-width";
import {
  renderRestoreSessionModal,
  type RestoreSessionModalViewModel,
  type RestoreTargetChoice,
} from "./restore-session-modal-view";
import {
  renderSettingsModal,
  type SettingsModalViewModel,
} from "./settings-modal-view";
import {
  renderReactivateProjectModal,
  type ReactivateProjectModalViewModel,
} from "./reactivate-project-modal-view";
import {
  renderSessionPreviewModal,
  type SessionPreviewModalViewModel,
  type SessionPreviewMessage,
} from "./session-preview-modal-view";
import {
  renderMobileView,
  type MobileFocus,
  type MobileInactivePreview,
  type MobileInactiveProjectGroup,
  type MobileInactiveSession,
  type MobileProjectGroup,
  type MobileRunningSession,
  type MobileTerminalSnapshot,
  type MobileView,
  type MobileViewModel,
} from "./mobile-view";
import { BOT_NAMES, displaySessionName } from "../session-names.js";

type ServerMsg = ServerToClientMessage;

const $ = (id: string) => document.getElementById(id)!;

const appEl = $("app") as HTMLDivElement;
const sidebarEl = document.querySelector(".sidebar") as HTMLElement;
const sidebarResizerEl = $("sidebar-resizer") as HTMLDivElement;
const listEl = $("pty-list");
const terminalEl = $("terminal");
const eventsEl = document.getElementById("events");
const sessionContextBarEl = $("session-context-bar");
const inputContextEl = $("input-context");
const inputContextToggleEl = $("input-context-toggle");
const inputContextLastEl = $("input-context-last");
const btnBranchReview = $("btn-branch-review") as HTMLButtonElement;
const btnMagit = $("btn-magit") as HTMLButtonElement;
const inputHistoryLabelEl = $("input-history-label");
const inputHistoryListEl = $("input-history-list");
const prContextEl = $("pr-context");
const mobileRoot = document.createElement("div");
mobileRoot.id = "mobile-root";
document.body.appendChild(mobileRoot);

let ptys: PtySummary[] = [];
let agentSessions: AgentSessionSummary[] = [];
let activePtyId: string | null = null;
let pendingActivePtyId: string | null = null;
let inputHistoryExpanded = false;
let branchReviewOpening = false;
let magitOpening = false;
let wsConnected = false;

const MOBILE_VIEW_KEY = "agmux:mobileView";
const MOBILE_SNAPSHOT_OPEN_PTY_KEY = "agmux:mobileSnapshotOpenPtyId";

function loadSavedMobileView(): MobileView {
  try {
    const raw = sessionStorage.getItem(MOBILE_VIEW_KEY);
    if (raw === "session" || raw === "inactive" || raw === "active") return raw;
  } catch {
    // ignore
  }
  return "active";
}

function saveMobileView(): void {
  try {
    sessionStorage.setItem(MOBILE_VIEW_KEY, mobileView);
  } catch {
    // ignore
  }
}

function loadSavedMobileSnapshotPtyId(): string | null {
  try {
    const raw = sessionStorage.getItem(MOBILE_SNAPSHOT_OPEN_PTY_KEY)?.trim() ?? "";
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function saveMobileSnapshotPtyId(ptyId: string | null): void {
  try {
    if (!ptyId) {
      sessionStorage.removeItem(MOBILE_SNAPSHOT_OPEN_PTY_KEY);
      return;
    }
    sessionStorage.setItem(MOBILE_SNAPSHOT_OPEN_PTY_KEY, ptyId);
  } catch {
    // ignore
  }
}

let mobileView: MobileView = loadSavedMobileView();
const mobileInputDraftByPtyId = new Map<string, string>();
let mobilePreviewState: MobileInactivePreview | null = null;
let mobileTerminalSnapshot: MobileTerminalSnapshot | null = null;
let mobileTerminalSnapshotSeq = 0;
let mobileTerminalSnapshotPendingRequestId: string | null = null;
let desktopHydrationPending: { requestId: string; ptyId: string } | null = null;
let mobileSnapshotRestorePtyId: string | null = loadSavedMobileSnapshotPtyId();
let mobilePreviewSeq = 0;
let mobileTermMountEl: HTMLElement | null = null;
let mobileReparentedPtyId: string | null = null;
let mobileSettingsOpen = false;
let latestPtyListModel: PtyListModel | null = null;
let mobileInactiveProjectKey: string | null = null;

// Client-side worktree cache, populated from GET /api/worktrees
let knownWorktrees: KnownWorktreeSummary[] = [];
let serverRepoRoot = "";

const ACTIVE_PTY_KEY = "agmux:activePty";
const AUTH_TOKEN_KEY = "agmux:authToken";
const INPUT_HISTORY_STORAGE_KEY = "agmux:inputHistory";
const HIDDEN_AGENT_SESSIONS_KEY = "agmux:hiddenAgentSessions";
const PINNED_DIRECTORIES_KEY = "agmux:pinnedDirectories";
const ARCHIVED_DIRECTORIES_KEY = "agmux:archivedDirectories";
const SIDEBAR_PTY_ORDER_KEY = "agmux:sidebarPtyOrder";
const PR_WAITING_FOR_REVIEW_KEY = "agmux:prWaitingForReview";
const REQUIRED_PR_APPROVALS = 3;
const hiddenAgentSessionIds = new Set<string>();
const pinnedDirectories = new Set<string>();
const archivedDirectories = new Set<string>();
const prWaitingForReviewPtys = new Set<string>();
let sidebarPtyOrder: string[] = [];

function loadHiddenAgentSessions(): void {
  try {
    const raw = localStorage.getItem(HIDDEN_AGENT_SESSIONS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const value of parsed) {
      if (typeof value === "string" && value.trim().length > 0) {
        hiddenAgentSessionIds.add(value);
      }
    }
  } catch {
    // ignore
  }
}

function saveHiddenAgentSessions(): void {
  try {
    localStorage.setItem(HIDDEN_AGENT_SESSIONS_KEY, JSON.stringify([...hiddenAgentSessionIds]));
  } catch {
    // ignore
  }
}

function loadPinnedDirectories(): void {
  try {
    const raw = localStorage.getItem(PINNED_DIRECTORIES_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const value of parsed) {
      if (typeof value === "string" && value.trim().length > 0) {
        pinnedDirectories.add(value);
      }
    }
  } catch {
    // ignore
  }
}

function savePinnedDirectories(): void {
  try {
    localStorage.setItem(PINNED_DIRECTORIES_KEY, JSON.stringify([...pinnedDirectories]));
  } catch {
    // ignore
  }
}

function loadArchivedDirectories(): void {
  try {
    const raw = localStorage.getItem(ARCHIVED_DIRECTORIES_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const value of parsed) {
      if (typeof value === "string" && value.trim().length > 0) {
        archivedDirectories.add(value);
      }
    }
  } catch {
    // ignore
  }
}

function saveArchivedDirectories(): void {
  try {
    localStorage.setItem(ARCHIVED_DIRECTORIES_KEY, JSON.stringify([...archivedDirectories]));
  } catch {
    // ignore
  }
}

function loadSidebarPtyOrder(): void {
  try {
    const raw = localStorage.getItem(SIDEBAR_PTY_ORDER_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    sidebarPtyOrder = parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  } catch {
    // ignore
  }
}

function saveSidebarPtyOrder(): void {
  try {
    if (sidebarPtyOrder.length === 0) {
      localStorage.removeItem(SIDEBAR_PTY_ORDER_KEY);
      return;
    }
    localStorage.setItem(SIDEBAR_PTY_ORDER_KEY, JSON.stringify(sidebarPtyOrder));
  } catch {
    // ignore
  }
}

function loadPrWaitingForReviewPtys(): void {
  try {
    const raw = localStorage.getItem(PR_WAITING_FOR_REVIEW_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const value of parsed) {
      if (typeof value === "string" && value.trim().length > 0) {
        prWaitingForReviewPtys.add(value);
      }
    }
  } catch {
    // ignore
  }
}

function savePrWaitingForReviewPtys(): void {
  try {
    if (prWaitingForReviewPtys.size === 0) {
      localStorage.removeItem(PR_WAITING_FOR_REVIEW_KEY);
      return;
    }
    localStorage.setItem(PR_WAITING_FOR_REVIEW_KEY, JSON.stringify([...prWaitingForReviewPtys]));
  } catch {
    // ignore
  }
}

function prunePrWaitingForReviewPtys(knownPtyIds: Set<string>): void {
  let changed = false;
  for (const ptyId of [...prWaitingForReviewPtys]) {
    if (knownPtyIds.has(ptyId)) continue;
    prWaitingForReviewPtys.delete(ptyId);
    changed = true;
  }
  if (changed) savePrWaitingForReviewPtys();
}

function pruneSidebarPtyOrder(): void {
  const runningIds = new Set(ptys.filter((p) => p.status === "running").map((p) => p.id));
  const nextOrder = sidebarPtyOrder.filter((id) => runningIds.has(id));
  if (nextOrder.length === sidebarPtyOrder.length) return;
  sidebarPtyOrder = nextOrder;
  saveSidebarPtyOrder();
}

function saveActivePty(ptyId: string | null): void {
  try {
    if (!ptyId) {
      sessionStorage.removeItem(ACTIVE_PTY_KEY);
      // Cleanup legacy shared storage value from older builds.
      localStorage.removeItem(ACTIVE_PTY_KEY);
      return;
    }
    const p = ptys.find((x) => x.id === ptyId);
    sessionStorage.setItem(
      ACTIVE_PTY_KEY,
      JSON.stringify({
        ptyId,
        tmuxSession: p?.tmuxSession ?? null,
        tmuxServer: p?.tmuxServer ?? null,
      }),
    );
    // Cleanup legacy shared storage value from older builds.
    localStorage.removeItem(ACTIVE_PTY_KEY);
  } catch {
    // ignore storage failures
  }
}

function loadSavedActivePty(): { ptyId: string; tmuxSession: string | null; tmuxServer: "agmux" | "default" | null } | null {
  try {
    // sessionStorage is tab-scoped: each browser tab remembers its own active PTY.
    // Fall back to legacy localStorage once, then migrate and clear it.
    const raw = sessionStorage.getItem(ACTIVE_PTY_KEY) ?? localStorage.getItem(ACTIVE_PTY_KEY);
    if (!raw) return null;
    if (!sessionStorage.getItem(ACTIVE_PTY_KEY)) {
      sessionStorage.setItem(ACTIVE_PTY_KEY, raw);
    }
    localStorage.removeItem(ACTIVE_PTY_KEY);
    const v = JSON.parse(raw);
    return typeof v.ptyId === "string"
      ? {
        ptyId: v.ptyId,
        tmuxSession: v.tmuxSession ?? null,
        tmuxServer: v.tmuxServer === "default" ? "default" : v.tmuxServer === "agmux" ? "agmux" : null,
      }
      : null;
  } catch { return null; }
}

type HistoryEntry = {
  text: string;
  /** Epoch ms of the submit; 0 when unknown. Used server-side to find the pane line. */
  ts: number;
};

type InputHistoryRecord = {
  lastInput?: string;
  processHint?: string;
  history?: HistoryEntry[];
};

const ptyTitles = new Map<string, string>();
const ptyLastInput = new Map<string, string>();
const ptyInputHistory = new Map<string, HistoryEntry[]>();
const ptyProviderInputHistory = new Map<string, HistoryEntry[]>();
const ptyProviderHistoryKeys = new Map<string, string>();
const ptyProviderHistoryLoading = new Set<string>();
const ptyProviderHistoryRefreshTimers = new Map<string, number>();
const ptyInputLineBuffers = new Map<string, string>();
const ptyInputProcessHints = new Map<string, string>();
type PtyReadyInfo = { state: PtyReadinessState; indicator: PtyReadinessIndicator; reason: string };
const ptyReady = new Map<string, PtyReadyInfo>();
const ptyStateChangedAt = new Map<string, number>();
const unviewedReadyPtys = new Set<string>();
const MAX_INPUT_HISTORY = 40;

function loadInputHistoryFromStorage(): Record<string, InputHistoryRecord> | null {
  try {
    const raw = sessionStorage.getItem(INPUT_HISTORY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Record<string, InputHistoryRecord>;
  } catch {
    return null;
  }
}

function saveInputHistoryToStorage(): void {
  try {
    const data: Record<string, InputHistoryRecord> = {};
    for (const [ptyId, lastInput] of ptyLastInput) {
      if (lastInput) data[ptyId] = { lastInput };
    }
    for (const [ptyId, processHint] of ptyInputProcessHints) {
      if (!processHint) continue;
      const existing = data[ptyId] ?? {};
      existing.processHint = processHint;
      data[ptyId] = existing;
    }
    for (const [ptyId, history] of ptyInputHistory) {
      if (!history.length) continue;
      const existing = data[ptyId] ?? {};
      existing.history = history;
      data[ptyId] = existing;
    }
    if (Object.keys(data).length === 0) {
      sessionStorage.removeItem(INPUT_HISTORY_STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(INPUT_HISTORY_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // ignore storage failures
  }
}

function applyInputMeta(data: Record<string, InputHistoryRecord>, overwrite: boolean): void {
  for (const [ptyId, meta] of Object.entries(data)) {
    if (!ptyId || !meta || typeof meta !== "object") continue;
    if (typeof meta.lastInput === "string" && meta.lastInput.trim()) {
      if (overwrite || !ptyLastInput.has(ptyId)) ptyLastInput.set(ptyId, meta.lastInput);
    }
    if (typeof meta.processHint === "string" && meta.processHint.trim()) {
      if (overwrite || !ptyInputProcessHints.has(ptyId)) ptyInputProcessHints.set(ptyId, meta.processHint);
    }
    if (Array.isArray(meta.history)) {
      const entries: HistoryEntry[] = meta.history
        .filter((x) => x && typeof x.text === "string" && x.text.trim().length > 0)
        .map((x) => ({ text: x.text, ts: typeof x.ts === "number" ? x.ts : 0 }));
      if (entries.length > 0 && (overwrite || !ptyInputHistory.has(ptyId))) {
        ptyInputHistory.set(ptyId, entries.slice(-MAX_INPUT_HISTORY));
      }
    }
  }
}

loadHiddenAgentSessions();
loadPinnedDirectories();
loadArchivedDirectories();
loadSidebarPtyOrder();
loadPrWaitingForReviewPtys();

async function refreshWorktreeCache(): Promise<void> {
  try {
    const res = await authFetch("/api/worktrees");
    if (!res.ok) return;
    const data = (await res.json()) as {
      worktrees?: Array<{ name: string; path: string; branch: string }>;
      repoRoot?: string;
    };
    if (Array.isArray(data.worktrees)) knownWorktrees = data.worktrees;
    if (typeof data.repoRoot === "string") serverRepoRoot = data.repoRoot;
  } catch {
    // ignore
  }
}

// Periodically refresh worktree cache (low frequency, skip when hidden).
const WORKTREE_REFRESH_MS = 120_000;
setInterval(() => {
  if (document.hidden) return;
  void refreshWorktreeCache();
}, WORKTREE_REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  void refreshWorktreeCache();
});

// Cache of directory existence checks, refreshed on each PTY list update.
const directoryExistsCache = new Map<string, boolean>();
let directoryExistsCheckInFlight = false;

async function checkDirectoryExistence(dirs: string[]): Promise<void> {
  if (directoryExistsCheckInFlight) return;
  directoryExistsCheckInFlight = true;
  try {
    for (const dir of dirs) {
      if (!dir) continue;
      try {
        const res = await authFetch(`/api/directory-exists?path=${encodeURIComponent(dir)}`);
        if (res.ok) {
          const json = (await res.json()) as { exists: boolean };
          directoryExistsCache.set(dir, json.exists);
        }
      } catch {
        // ignore individual failures
      }
    }
  } finally {
    directoryExistsCheckInFlight = false;
  }
}

function autoArchiveMissingDirectories(): void {
  let changed = false;
  for (const dir of [...pinnedDirectories]) {
    if (!dir) continue;
    const exists = directoryExistsCache.get(dir);
    if (exists === false) {
      // Only auto-archive if no running PTYs use this directory
      const hasRunning = ptys.some(
        (p) => p.status === "running" && ptyProjectKey(p) === dir,
      );
      if (!hasRunning) {
        pinnedDirectories.delete(dir);
        archivedDirectories.add(dir);
        changed = true;
      }
    }
  }
  if (changed) {
    savePinnedDirectories();
    saveArchivedDirectories();
  }
}

function archiveDirectory(groupKey: string): void {
  pinnedDirectories.delete(groupKey);
  archivedDirectories.add(groupKey);
  savePinnedDirectories();
  saveArchivedDirectories();
  renderList();
}

function unarchiveDirectory(groupKey: string): void {
  archivedDirectories.delete(groupKey);
  saveArchivedDirectories();
  renderList();
}

function formatElapsedTime(sinceMs: number): string {
  const delta = Date.now() - sinceMs;
  if (delta < 0) return "";
  const secs = Math.floor(delta / 1000);
  if (secs < 5) return "now";
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function readinessFromSummary(p: PtySummary): PtyReadyInfo {
  const state = p.readyState ?? (typeof p.ready === "boolean" ? (p.ready ? "ready" : "busy") : "unknown");
  const indicator = p.readyIndicator ?? (state === "ready" ? "ready" : state === "busy" ? "busy" : "unknown");
  if (p.readyStateChangedAt) ptyStateChangedAt.set(p.id, p.readyStateChangedAt);
  return { state, indicator, reason: String(p.readyReason ?? "") };
}

function shouldMarkReadyUnviewed(ptyId: string, previous: PtyReadyInfo | undefined, next: PtyReadyInfo): boolean {
  return ptyId !== activePtyId && previous?.state === "busy" && next.state === "ready";
}

const pendingHistorySaves = new Set<string>();
let historySaveTimer: ReturnType<typeof setTimeout> | null = null;
const HISTORY_SAVE_DEBOUNCE_MS = 500;

function savePtyInputMeta(changedPtyId?: string): void {
  if (changedPtyId) pendingHistorySaves.add(changedPtyId);
  saveInputHistoryToStorage();
  if (historySaveTimer) return;
  historySaveTimer = setTimeout(() => {
    historySaveTimer = null;
    const ids = [...pendingHistorySaves];
    pendingHistorySaves.clear();
    for (const ptyId of ids) {
      const lastInput = ptyLastInput.get(ptyId);
      const processHint = ptyInputProcessHints.get(ptyId);
      const history = ptyInputHistory.get(ptyId) ?? [];
      void authFetch(`/api/ptys/${encodeURIComponent(ptyId)}/input-history`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lastInput, processHint, history }),
      }).catch(() => {
        // ignore save failures
      });
    }
  }, HISTORY_SAVE_DEBOUNCE_MS);
}

async function loadPtyInputMeta(): Promise<void> {
  const cached = loadInputHistoryFromStorage();
  if (cached) applyInputMeta(cached, false);

  const res = await authFetch("/api/input-history");
  if (!res.ok) return;
  const json = (await res.json()) as { history?: Record<string, unknown> };
  const data = json.history;
  if (!data || typeof data !== "object") return;
  applyInputMeta(data as Record<string, InputHistoryRecord>, false);
}

function prunePtyInputMeta(ptyIds: Set<string>): void {
  for (const ptyId of [...ptyLastInput.keys()]) {
    if (ptyIds.has(ptyId)) continue;
    ptyLastInput.delete(ptyId);
  }
  for (const ptyId of [...ptyInputProcessHints.keys()]) {
    if (ptyIds.has(ptyId)) continue;
    ptyInputProcessHints.delete(ptyId);
  }
  for (const ptyId of [...ptyInputHistory.keys()]) {
    if (ptyIds.has(ptyId)) continue;
    ptyInputHistory.delete(ptyId);
  }
  for (const ptyId of [...ptyProviderInputHistory.keys()]) {
    if (ptyIds.has(ptyId)) continue;
    ptyProviderInputHistory.delete(ptyId);
  }
  for (const ptyId of [...ptyProviderHistoryKeys.keys()]) {
    if (ptyIds.has(ptyId)) continue;
    ptyProviderHistoryKeys.delete(ptyId);
  }
  for (const ptyId of [...ptyProviderHistoryLoading]) {
    if (ptyIds.has(ptyId)) continue;
    ptyProviderHistoryLoading.delete(ptyId);
  }
  for (const [ptyId, timer] of [...ptyProviderHistoryRefreshTimers.entries()]) {
    if (ptyIds.has(ptyId)) continue;
    clearTimeout(timer);
    ptyProviderHistoryRefreshTimers.delete(ptyId);
  }
  saveInputHistoryToStorage();
}

// Input history is loaded from the server after auth; see boot sequence below.

const btnNew = $("btn-new") as HTMLButtonElement;
const btnFollow = $("btn-follow") as HTMLButtonElement;
const btnKickOthers = $("btn-kick-others") as HTMLButtonElement;
const btnSidebarToggle = $("btn-sidebar-toggle") as HTMLButtonElement;
btnNew.disabled = true;
btnFollow.classList.remove("visible");

let viewerCounts: Record<string, number> = {};

const SIDEBAR_WIDTH_KEY = "agmux:sidebarWidth";
let sidebarWidth = parseStoredSidebarWidth(localStorage.getItem(SIDEBAR_WIDTH_KEY), window.innerWidth) ??
  SIDEBAR_WIDTH_DEFAULT;
let sidebarCollapsed = false;
let sidebarFitRaf = 0;

function updateSidebarResizeHandle(): void {
  sidebarResizerEl.setAttribute("aria-valuemin", String(SIDEBAR_WIDTH_MIN));
  sidebarResizerEl.setAttribute("aria-valuemax", String(maxSidebarWidthForViewport(window.innerWidth)));
  sidebarResizerEl.setAttribute("aria-valuenow", String(sidebarWidth));
  sidebarResizerEl.setAttribute("aria-valuetext", `${sidebarWidth}px`);
}

function applySidebarWidth(): void {
  appEl.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
  updateSidebarResizeHandle();
}

function scheduleSidebarTerminalFit(): void {
  if (sidebarFitRaf) return;
  sidebarFitRaf = requestAnimationFrame(() => {
    sidebarFitRaf = 0;
    fitAndResizeActive();
    reflowActiveTerm();
  });
}

function syncSidebarWidthToViewport(): void {
  const nextWidth = normalizeSidebarWidth(sidebarWidth, window.innerWidth);
  if (nextWidth !== sidebarWidth) {
    sidebarWidth = nextWidth;
    applySidebarWidth();
    scheduleSidebarTerminalFit();
    return;
  }
  updateSidebarResizeHandle();
}

function setSidebarWidth(width: number, options: { persist?: boolean; fit?: boolean } = {}): void {
  sidebarWidth = normalizeSidebarWidth(width, window.innerWidth);
  applySidebarWidth();
  if (options.persist ?? true) {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }
  if (options.fit ?? true) {
    scheduleSidebarTerminalFit();
  }
}

function sidebarWidthFromPointer(ev: PointerEvent): number {
  return ev.clientX - appEl.getBoundingClientRect().left;
}

applySidebarWidth();

function toggleSidebar(): void {
  sidebarCollapsed = !sidebarCollapsed;
  appEl.classList.toggle("sidebar-collapsed", sidebarCollapsed);
  sidebarEl.classList.toggle("collapsed", sidebarCollapsed);
  btnSidebarToggle.innerHTML = sidebarCollapsed ? "&raquo;" : "&laquo;";
  btnSidebarToggle.title = sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar";
  renderList();
  // Re-fit after the 0.2s grid-template-columns transition settles. Use the
  // full resize path so the backend learns the new size (queueResize) and the
  // buffer is re-wrapped (reflow); a bare fit() leaves garbled output.
  setTimeout(() => {
    fitAndResizeActive();
    reflowActiveTerm();
  }, 250);
}
btnSidebarToggle.addEventListener("click", toggleSidebar);

// Prevent sidebar clicks from stealing keyboard focus from the terminal.
sidebarEl.addEventListener("mousedown", (ev) => {
  const tag = (ev.target as HTMLElement).tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  ev.preventDefault();
});

let sidebarResizePointerId: number | null = null;

function finishSidebarResize(ev?: PointerEvent): void {
  if (sidebarResizePointerId === null) return;
  if (ev && ev.pointerId !== sidebarResizePointerId) return;
  if (ev && sidebarResizerEl.hasPointerCapture(ev.pointerId)) {
    sidebarResizerEl.releasePointerCapture(ev.pointerId);
  }
  sidebarResizePointerId = null;
  appEl.classList.remove("sidebar-resizing");
  document.body.classList.remove("sidebar-resizing");
  localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  focusActiveTerm();
}

sidebarResizerEl.addEventListener("pointerdown", (ev) => {
  if (ev.button !== 0 || sidebarCollapsed || mobileViewport) return;
  ev.preventDefault();
  sidebarResizePointerId = ev.pointerId;
  sidebarResizerEl.setPointerCapture(ev.pointerId);
  appEl.classList.add("sidebar-resizing");
  document.body.classList.add("sidebar-resizing");
  setSidebarWidth(sidebarWidthFromPointer(ev), { persist: false });
});

sidebarResizerEl.addEventListener("pointermove", (ev) => {
  if (sidebarResizePointerId !== ev.pointerId) return;
  ev.preventDefault();
  setSidebarWidth(sidebarWidthFromPointer(ev), { persist: false });
});

sidebarResizerEl.addEventListener("pointerup", finishSidebarResize);
sidebarResizerEl.addEventListener("pointercancel", finishSidebarResize);
sidebarResizerEl.addEventListener("lostpointercapture", () => finishSidebarResize());
window.addEventListener("blur", () => finishSidebarResize());

sidebarResizerEl.addEventListener("keydown", (ev) => {
  if (sidebarCollapsed || mobileViewport) return;
  switch (ev.key) {
    case "ArrowLeft":
      ev.preventDefault();
      setSidebarWidth(adjustSidebarWidth(sidebarWidth, -SIDEBAR_WIDTH_STEP, window.innerWidth));
      return;
    case "ArrowRight":
      ev.preventDefault();
      setSidebarWidth(adjustSidebarWidth(sidebarWidth, SIDEBAR_WIDTH_STEP, window.innerWidth));
      return;
    case "Home":
      ev.preventDefault();
      setSidebarWidth(SIDEBAR_WIDTH_MIN);
      return;
    case "End":
      ev.preventDefault();
      setSidebarWidth(maxSidebarWidthForViewport(window.innerWidth));
      return;
  }
});

// --- Theme ---

const THEME_KEY = "agmux:theme";
const SYSTEM_THEME_DARK_KEY = "agmux:systemThemeDark";
const USE_SYSTEM_THEME_KEY = "agmux:useSystemTheme";
const MOBILE_TERMINAL_THEME_KEY = "agmux:mobileTerminalTheme";
const MOBILE_TERMINAL_FONT_SIZE_KEY = "agmux:mobileTerminalFontSize";
const MOBILE_TERMINAL_DEFAULT_THEME_KEY = "neutral-light";
const DESKTOP_TERMINAL_FONT_SIZE = 13;
const MOBILE_TERMINAL_FONT_SIZE_MIN = 8;
const MOBILE_TERMINAL_FONT_SIZE_MAX = 22;
const systemThemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
let lastSystemThemePrefersDark = systemThemeMedia.matches;
let selectedThemeKey = normalizeThemeKey(localStorage.getItem(THEME_KEY));
let useSystemTheme = loadStoredBoolean(USE_SYSTEM_THEME_KEY);
let systemThemeDarkKey = normalizeSystemThemeDarkKey(localStorage.getItem(SYSTEM_THEME_DARK_KEY), selectedThemeKey);
let activeThemeKey = resolveActiveThemeKey();
let activeTheme: Theme = THEMES.get(activeThemeKey) ?? THEMES.get(DEFAULT_THEME_KEY)!;
let mobileTerminalThemeKey = localStorage.getItem(MOBILE_TERMINAL_THEME_KEY) ?? MOBILE_TERMINAL_DEFAULT_THEME_KEY;
if (!THEMES.has(mobileTerminalThemeKey)) mobileTerminalThemeKey = activeThemeKey;
const storedMobileTerminalFontSize = Number(localStorage.getItem(MOBILE_TERMINAL_FONT_SIZE_KEY) ?? "");
let mobileTerminalFontSize = Number.isFinite(storedMobileTerminalFontSize)
  ? Math.max(MOBILE_TERMINAL_FONT_SIZE_MIN, Math.min(MOBILE_TERMINAL_FONT_SIZE_MAX, Math.round(storedMobileTerminalFontSize)))
  : DESKTOP_TERMINAL_FONT_SIZE;

// Apply theme to CSS vars immediately (before any terminal creation).
applyTheme(activeTheme, []);

function normalizeThemeKey(key: string | null): string {
  return key && THEMES.has(key) ? key : DEFAULT_THEME_KEY;
}

function loadStoredBoolean(key: string): boolean {
  const raw = localStorage.getItem(key);
  return raw === "1" || raw === "true";
}

function normalizeSystemThemeDarkKey(key: string | null, fallbackThemeKey: string): string {
  if (key && isSystemThemeDarkKey(key)) return key;
  return getSystemThemeDarkFallbackKey(fallbackThemeKey) ?? DEFAULT_THEME_KEY;
}

function resolveActiveThemeKey(): string {
  if (!useSystemTheme) return selectedThemeKey;
  return resolveSystemThemeKey(systemThemeDarkKey, systemThemeMedia.matches);
}

function refreshActiveTheme(options: { focus?: boolean } = {}): void {
  const nextThemeKey = resolveActiveThemeKey();
  const nextTheme = THEMES.get(nextThemeKey) ?? THEMES.get(DEFAULT_THEME_KEY)!;
  activeThemeKey = nextThemeKey;
  activeTheme = nextTheme;
  applyTheme(activeTheme, []);
  applyTerminalAppearanceToAll();
  renderList();
  scheduleMobileRender();
  if (settingsModalState) renderSettingsModalState();
  if (options.focus) focusActiveTerm();
}

function syncSystemThemePreference(): void {
  const prefersDark = systemThemeMedia.matches;
  if (prefersDark === lastSystemThemePrefersDark) return;
  lastSystemThemePrefersDark = prefersDark;
  if (useSystemTheme) {
    refreshActiveTheme();
  } else if (settingsModalState) {
    renderSettingsModalState();
  }
}

const MOBILE_MEDIA_QUERY = "(max-width: 750px)";
const mobileMedia = window.matchMedia(MOBILE_MEDIA_QUERY);
let mobileViewport = mobileMedia.matches;
let mobileViewportSyncRaf = 0;
let mobileViewportSyncNeedsResize = false;

function isMobileKeyboardLikelyOpen(): boolean {
  if (!mobileViewport) return false;
  const vv = window.visualViewport;
  if (!vv) return false;
  return vv.height < (window.innerHeight - 120);
}

function syncMobileRootToVisualViewport(resizeActiveTerm: boolean): void {
  if (!mobileViewport) {
    mobileRoot.style.top = "";
    mobileRoot.style.left = "";
    mobileRoot.style.width = "";
    mobileRoot.style.height = "";
    if (resizeActiveTerm && activePtyId) {
      requestAnimationFrame(() => {
        fitAndResizeActive();
        reflowActiveTerm();
      });
    }
    return;
  }
  const vv = window.visualViewport;
  if (!vv) {
    mobileRoot.style.top = "";
    mobileRoot.style.left = "";
    mobileRoot.style.width = "";
    mobileRoot.style.height = "";
    if (resizeActiveTerm && activePtyId) {
      requestAnimationFrame(() => {
        fitAndResizeActive();
        reflowActiveTerm();
      });
    }
    return;
  }
  // Keep width anchored to layout viewport. Some mobile browsers report a
  // transiently narrow visualViewport.width after refresh/zoom churn, which
  // causes PTY cols to collapse and wrap at roughly half width.
  const layoutWidth = Math.max(window.innerWidth, document.documentElement.clientWidth || 0);
  mobileRoot.style.top = `${Math.max(0, Math.round(vv.offsetTop))}px`;
  mobileRoot.style.left = "0px";
  mobileRoot.style.width = `${Math.max(1, Math.round(layoutWidth))}px`;
  mobileRoot.style.height = `${Math.max(1, Math.round(vv.height))}px`;
  if (resizeActiveTerm && activePtyId) {
    requestAnimationFrame(() => {
      fitAndResizeActive();
      reflowActiveTerm();
    });
  }
}

function scheduleMobileViewportSync(resizeActiveTerm = false): void {
  mobileViewportSyncNeedsResize = mobileViewportSyncNeedsResize || resizeActiveTerm;
  if (mobileViewportSyncRaf) return;
  mobileViewportSyncRaf = requestAnimationFrame(() => {
    mobileViewportSyncRaf = 0;
    const resizeNow = mobileViewportSyncNeedsResize;
    mobileViewportSyncNeedsResize = false;
    syncMobileRootToVisualViewport(resizeNow);
  });
}

mobileMedia.addEventListener("change", (ev) => {
  mobileViewport = ev.matches;
  if (!mobileViewport) {
    mobileSettingsOpen = false;
  }
  scheduleMobileViewportSync(true);
  applyTerminalAppearanceToAll();
  updateFollowButtonVisibility();
  renderMobileViewState();
});
window.addEventListener("resize", () => scheduleMobileViewportSync(true));
window.visualViewport?.addEventListener("resize", () => scheduleMobileViewportSync(true));
window.visualViewport?.addEventListener("scroll", () => {
  scheduleMobileViewportSync(!isMobileKeyboardLikelyOpen());
});
scheduleMobileViewportSync(true);
systemThemeMedia.addEventListener("change", syncSystemThemePreference);
window.addEventListener("focus", syncSystemThemePreference);
document.addEventListener("visibilitychange", syncSystemThemePreference);
window.setInterval(syncSystemThemePreference, 1000);

function effectiveTerminalTheme(): Theme {
  if (!mobileViewport) return activeTheme;
  return THEMES.get(mobileTerminalThemeKey) ?? activeTheme;
}

function effectiveTerminalFontSize(): number {
  return mobileViewport ? mobileTerminalFontSize : DESKTOP_TERMINAL_FONT_SIZE;
}

function applyTerminalAppearanceToAll(): void {
  const nextTheme = effectiveTerminalTheme().terminal;
  const nextFontSize = effectiveTerminalFontSize();
  for (const st of terms.values()) {
    st.term.options.theme = nextTheme;
    st.term.options.fontSize = nextFontSize;
  }
  if (activePtyId) {
    requestAnimationFrame(() => {
      fitAndResizeActive();
      reflowActiveTerm();
    });
  }
}

function setTheme(key: string): void {
  if (useSystemTheme) {
    if (!isSystemThemeDarkKey(key)) return;
    systemThemeDarkKey = key;
    localStorage.setItem(SYSTEM_THEME_DARK_KEY, key);
    refreshActiveTheme({ focus: true });
    return;
  }
  if (!THEMES.has(key)) return;
  selectedThemeKey = key;
  localStorage.setItem(THEME_KEY, key);
  const fallbackSystemThemeKey = getSystemThemeDarkFallbackKey(key);
  if (fallbackSystemThemeKey) {
    systemThemeDarkKey = fallbackSystemThemeKey;
    localStorage.setItem(SYSTEM_THEME_DARK_KEY, fallbackSystemThemeKey);
  }
  refreshActiveTheme({ focus: true });
}

function setUseSystemTheme(enabled: boolean): void {
  useSystemTheme = enabled;
  localStorage.setItem(USE_SYSTEM_THEME_KEY, enabled ? "1" : "0");
  if (enabled) {
    systemThemeDarkKey = normalizeSystemThemeDarkKey(localStorage.getItem(SYSTEM_THEME_DARK_KEY), selectedThemeKey);
    localStorage.setItem(SYSTEM_THEME_DARK_KEY, systemThemeDarkKey);
  }
  refreshActiveTheme({ focus: true });
}

function setMobileTerminalTheme(key: string): void {
  if (!THEMES.has(key)) return;
  mobileTerminalThemeKey = key;
  localStorage.setItem(MOBILE_TERMINAL_THEME_KEY, key);
  applyTerminalAppearanceToAll();
  scheduleMobileRender();
}

function setMobileTerminalFontSize(size: number): void {
  const normalized = Math.max(
    MOBILE_TERMINAL_FONT_SIZE_MIN,
    Math.min(MOBILE_TERMINAL_FONT_SIZE_MAX, Math.round(size)),
  );
  mobileTerminalFontSize = normalized;
  localStorage.setItem(MOBILE_TERMINAL_FONT_SIZE_KEY, String(normalized));
  applyTerminalAppearanceToAll();
  scheduleMobileRender();
}

type TermState = {
  ptyId: string;
  container: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  opened: boolean;
  lastResize: { cols: number; rows: number } | null;
};

const terms = new Map<string, TermState>();
const subscribed = new Set<string>();
const pendingResizeByPtyId = new Map<string, { cols: number; rows: number }>();
let authToken = "";
let ws: WebSocket | null = null;
const TERMINAL_SCROLLBACK_LINES = 0;
const MOBILE_TMUX_SNAPSHOT_LINES = 4_000;
const DESKTOP_TMUX_HYDRATION_LINES = 4_000;
let tmuxSessions: TmuxSessionInfo[] = [];
let selectedTmuxSessionKey = "";

const placeholderEl = document.createElement("div");
placeholderEl.className = "terminal-placeholder";
placeholderEl.textContent = "select a PTY";
terminalEl.appendChild(placeholderEl);

function startAssetReloadPoller(): void {
  const urls = ["/app.js", "/styles.css", "/index.html", "/xterm.css"];
  const last = new Map<string, string>();
  const BASE_INTERVAL_MS = 10_000;
  const HIDDEN_INTERVAL_MS = 60_000;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function headEtag(url: string): Promise<string> {
    try {
      const res = await fetch(url, { method: "HEAD", cache: "no-store" });
      if (!res.ok) return "";
      return res.headers.get("etag") ?? "";
    } catch {
      return "";
    }
  }

  async function tick(): Promise<void> {
    if (document.hidden) return;
    for (const url of urls) {
      const etag = await headEtag(url);
      if (!etag) continue;
      const prev = last.get(url);
      if (prev && prev !== etag) {
        location.reload();
        return;
      }
      last.set(url, etag);
    }
  }

  function schedule(nextImmediate = false): void {
    if (timer) return;
    const delay = nextImmediate
      ? 0
      : (document.hidden ? HIDDEN_INTERVAL_MS : BASE_INTERVAL_MS);
    timer = setTimeout(async () => {
      timer = null;
      await tick();
      schedule();
    }, delay);
  }

  document.addEventListener("visibilitychange", () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    schedule();
  });

  schedule(true);
}

function createTermState(ptyId: string): TermState {
  const container = document.createElement("div");
  container.className = "term-pane hidden";
  container.dataset.ptyId = ptyId;
  terminalEl.appendChild(container);

  const term = new Terminal({
    cursorBlink: true,
    fontSize: effectiveTerminalFontSize(),
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    theme: effectiveTerminalTheme().terminal,
    scrollback: TERMINAL_SCROLLBACK_LINES,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  let opened = false;
  if (!mobileViewport) {
    term.open(container);
    opened = true;
  }

  // Intercept wheel events and scroll tmux history instead.
  container.addEventListener(
    "wheel",
    (ev) => {
      if (ev.ctrlKey) return;
      const dy = ev.deltaY;
      if (!Number.isFinite(dy) || dy === 0) return;
      ev.preventDefault();
      const lines = Math.max(1, Math.round(Math.abs(dy) / 40));
      sendWsMessage({
        type: "tmux_control",
        ptyId,
        direction: dy > 0 ? "down" : "up",
        lines,
      });
    },
    { passive: false, capture: true },
  );

  term.onData((data) => {
    if (activePtyId !== ptyId) return;
    if (mobileViewport) return;
    trackUserInput(ptyId, data);
    sendWsMessage({ type: "input", ptyId, data });
  });

  term.onScroll(() => {
    if (activePtyId !== ptyId) return;
    updateFollowButtonVisibility();
    if (mobileViewport) scheduleMobileRender();
  });

  const copyToast = document.createElement("div");
  copyToast.className = "copy-toast";
  copyToast.textContent = "Copied";
  container.appendChild(copyToast);
  let copyToastTimer = 0;
  let lastCopiedSelection = "";
  let pendingCopiedSelection = "";

  const showCopyToast = () => {
    clearTimeout(copyToastTimer);
    copyToast.classList.add("visible");
    copyToastTimer = window.setTimeout(() => copyToast.classList.remove("visible"), 800);
  };

  const fallbackCopyText = (text: string): boolean => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      return typeof document.execCommand === "function" ? document.execCommand("copy") : false;
    } catch {
      return false;
    } finally {
      textarea.remove();
    }
  };

  const writeClipboardText = async (text: string): Promise<boolean> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fall back to execCommand-based copy below.
    }
    return fallbackCopyText(text);
  };

  const copySelectionToClipboard = () => {
    const sel = cleanupCopiedTerminalText(term.getSelection());
    if (!sel) {
      lastCopiedSelection = "";
      pendingCopiedSelection = "";
      return;
    }
    if (sel === lastCopiedSelection || sel === pendingCopiedSelection) return;
    pendingCopiedSelection = sel;
    void writeClipboardText(sel).then((copied) => {
      if (pendingCopiedSelection === sel) pendingCopiedSelection = "";
      if (!copied) return;
      lastCopiedSelection = sel;
      showCopyToast();
    });
  };

  term.onSelectionChange(() => {
    if (!term.getSelection()) {
      lastCopiedSelection = "";
      pendingCopiedSelection = "";
      return;
    }
    queueMicrotask(copySelectionToClipboard);
  });

  container.addEventListener("mouseup", copySelectionToClipboard);
  container.addEventListener("touchend", copySelectionToClipboard, { passive: true });
  container.addEventListener("keyup", (ev) => {
    if (!(ev instanceof KeyboardEvent)) return;
    if (!ev.shiftKey && ev.key !== "Shift") return;
    copySelectionToClipboard();
  });

  term.onTitleChange((title) => {
    const t = title.trim();
    if (!t) return;
    if (ptyTitles.get(ptyId) === t) return;
    ptyTitles.set(ptyId, t);
    renderList();
  });

  return { ptyId, container, term, fit, opened, lastResize: null };
}

function ensureTerm(ptyId: string): TermState {
  const existing = terms.get(ptyId);
  if (existing) return existing;
  const created = createTermState(ptyId);
  terms.set(ptyId, created);
  return created;
}

function remapPtyState(oldPtyId: string, newPtyId: string): void {
  if (!oldPtyId || !newPtyId || oldPtyId === newPtyId) return;

  const moveMapValue = <T,>(m: Map<string, T>): void => {
    if (!m.has(oldPtyId) || m.has(newPtyId)) return;
    const value = m.get(oldPtyId)!;
    m.set(newPtyId, value);
    m.delete(oldPtyId);
  };
  const moveSetValue = (s: Set<string>): void => {
    if (!s.has(oldPtyId)) return;
    s.delete(oldPtyId);
    s.add(newPtyId);
  };

  const st = terms.get(oldPtyId);
  if (st && !terms.has(newPtyId)) {
    terms.delete(oldPtyId);
    st.ptyId = newPtyId;
    st.container.dataset.ptyId = newPtyId;
    terms.set(newPtyId, st);
  }

  moveMapValue(ptyTitles);
  moveMapValue(ptyLastInput);
  moveMapValue(ptyInputHistory);
  moveMapValue(ptyProviderInputHistory);
  moveMapValue(ptyProviderHistoryKeys);
  moveMapValue(ptyInputLineBuffers);
  moveMapValue(ptyInputProcessHints);
  moveMapValue(mobileInputDraftByPtyId);
  moveMapValue(ptyReady);
  moveMapValue(ptyStateChangedAt);
  moveMapValue(pendingResizeByPtyId);

  moveSetValue(subscribed);
  moveSetValue(unviewedReadyPtys);
  const hadWaitingReview = prWaitingForReviewPtys.has(oldPtyId);
  moveSetValue(prWaitingForReviewPtys);
  moveSetValue(pendingHistorySaves);
  moveSetValue(ptyProviderHistoryLoading);
  if (hadWaitingReview) savePrWaitingForReviewPtys();

  if (pendingActivePtyId === oldPtyId) pendingActivePtyId = newPtyId;
  if (mobileReparentedPtyId === oldPtyId) mobileReparentedPtyId = newPtyId;
  if (mobileSnapshotRestorePtyId === oldPtyId) mobileSnapshotRestorePtyId = newPtyId;
  if (mobileTerminalSnapshot && mobileTerminalSnapshot.ptyId === oldPtyId) {
    mobileTerminalSnapshot = { ...mobileTerminalSnapshot, ptyId: newPtyId };
  }
  const refreshTimer = ptyProviderHistoryRefreshTimers.get(oldPtyId);
  if (refreshTimer != null && !ptyProviderHistoryRefreshTimers.has(newPtyId)) {
    ptyProviderHistoryRefreshTimers.set(newPtyId, refreshTimer);
    ptyProviderHistoryRefreshTimers.delete(oldPtyId);
  }
}

function removeTerm(ptyId: string): void {
  const st = terms.get(ptyId);
  if (!st) return;
  try {
    st.term.dispose();
  } catch {
    // ignore
  }
  st.container.remove();
  terms.delete(ptyId);
  ptyTitles.delete(ptyId);
  ptyProviderInputHistory.delete(ptyId);
  ptyProviderHistoryKeys.delete(ptyId);
  ptyProviderHistoryLoading.delete(ptyId);
  clearProviderHistoryRefreshTimer(ptyId);
  ptyInputLineBuffers.delete(ptyId);
  mobileInputDraftByPtyId.delete(ptyId);
  ptyReady.delete(ptyId);
  ptyStateChangedAt.delete(ptyId);
  unviewedReadyPtys.delete(ptyId);
  subscribed.delete(ptyId);
  pendingResizeByPtyId.delete(ptyId);
  if (desktopHydrationPending?.ptyId === ptyId) {
    desktopHydrationPending = null;
  }
}

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const tokenPart = authToken ? `?token=${encodeURIComponent(authToken)}` : "";
  return `${proto}://${location.host}/ws${tokenPart}`;
}

function sendWsMessage(msg: unknown): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}

function flushPendingResizes(ptyId?: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (ptyId) {
    const resize = pendingResizeByPtyId.get(ptyId);
    if (!resize) return;
    sendWsMessage({ type: "resize", ptyId, cols: resize.cols, rows: resize.rows });
    pendingResizeByPtyId.delete(ptyId);
    return;
  }
  for (const [id, resize] of [...pendingResizeByPtyId.entries()]) {
    sendWsMessage({ type: "resize", ptyId: id, cols: resize.cols, rows: resize.rows });
    pendingResizeByPtyId.delete(id);
  }
}

function queueResize(ptyId: string, cols: number, rows: number): void {
  pendingResizeByPtyId.set(ptyId, { cols, rows });
  flushPendingResizes(ptyId);
}

function authHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  if (authToken) headers.set("x-agmux-token", authToken);
  return headers;
}

async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: authHeaders(init?.headers),
  });
}

let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsReconnectDelay = 0;
const WS_RECONNECT_BASE = 500;
const WS_RECONNECT_MAX = 10_000;

function scheduleWsReconnect(): void {
  if (wsReconnectTimer !== null) return;
  wsReconnectDelay = wsReconnectDelay === 0
    ? WS_RECONNECT_BASE
    : Math.min(wsReconnectDelay * 2, WS_RECONNECT_MAX);
  addEvent(`WS reconnecting in ${wsReconnectDelay}ms…`);
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWs();
  }, wsReconnectDelay);
}

function connectWs(): void {
  ws = new WebSocket(wsUrl());

  ws.addEventListener("open", () => {
    desktopHydrationPending = null;
    wsReconnectDelay = 0;
    addEvent(`WS connected`);
    wsConnected = true;
    scheduleMobileRender();
    if (activePtyId) {
      fitAndResizeActive();
      reflowActiveTerm();
      const st = terms.get(activePtyId);
      if (st && st.term.cols > 0 && st.term.rows > 0) {
        queueResize(activePtyId, st.term.cols, st.term.rows);
      }
    }
    flushPendingResizes();
    for (const ptyId of subscribed) {
      sendWsMessage({ type: "subscribe", ptyId });
    }
    if (activePtyId && !subscribed.has(activePtyId)) {
      subscribeIfNeeded(activePtyId);
    }
    requestAnimationFrame(() => {
      fitAndResizeActive();
      reflowActiveTerm();
    });
    if (listRefreshTimer) {
      clearTimeout(listRefreshTimer);
      listRefreshTimer = null;
    }
    refreshList();
    scheduleListRefresh();
  });

  ws.addEventListener("close", () => {
    desktopHydrationPending = null;
    addEvent(`WS disconnected`);
    wsConnected = false;
    scheduleMobileRender();
    if (listRefreshTimer) {
      clearTimeout(listRefreshTimer);
      listRefreshTimer = null;
    }
    scheduleListRefresh();
    scheduleWsReconnect();
  });

  ws.addEventListener("error", () => {
    // close will fire after error, triggering reconnect
  });

  ws.addEventListener("message", (ev) => {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(String(ev.data)) as ServerMsg;
    } catch {
      return;
    }
    onServerMsg(msg);
  });
}

function setAuthToken(token: string): void {
  authToken = token;
  try {
    sessionStorage.setItem(AUTH_TOKEN_KEY, token);
  } catch {
    // ignore storage failures
  }
  try {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
  } catch {
    // ignore storage failures
  }
}

async function ensureAuthToken(): Promise<void> {
  const qs = new URLSearchParams(location.search);
  const tokenFromUrl = qs.get("token")?.trim() ?? "";
  if (tokenFromUrl) {
    setAuthToken(tokenFromUrl);
    return;
  }

  const tokenFromSession = sessionStorage.getItem(AUTH_TOKEN_KEY)?.trim() ?? "";
  const tokenFromLocal = localStorage.getItem(AUTH_TOKEN_KEY)?.trim() ?? "";
  const tokenFromStorage = tokenFromSession || tokenFromLocal;
  if (tokenFromStorage) {
    authToken = tokenFromStorage;
    return;
  }

  // Auth is opt-in. Probe once: if API works without token, skip prompt.
  // If API returns 401, a token is required for this server instance.
  try {
    const probe = await fetch("/api/ptys", { cache: "no-store" });
    if (probe.status !== 401) {
      return;
    }
  } catch {
    // Ignore probe failures; we'll fall back to prompting.
  }

  const entered = window.prompt(
    "Enter AGMUX token.\nIf AGMUX_TOKEN_ENABLED=1 and the token was auto-generated, check the server log for '[agmux] Token: ...'.",
  );
  const token = entered?.trim() ?? "";
  if (!token) {
    throw new Error("AGMUX token is required");
  }
  setAuthToken(token);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readApiError(res: Response): Promise<string> {
  try {
    const json = (await res.json()) as { error?: unknown };
    if (typeof json.error === "string" && json.error.length > 0) {
      return json.error;
    }
  } catch {
    // ignore
  }
  return `HTTP ${res.status}`;
}

// Use ETag-based asset reload poller as the sole reload mechanism.
startAssetReloadPoller();

function onServerMsg(msg: ServerMsg): void {
  if (msg.type === "pty_list") {
    ptys = msg.ptys;
    syncProviderHistoryStateWithPtys();
    if (mobileSnapshotRestorePtyId && !ptys.some((p) => p.id === mobileSnapshotRestorePtyId && p.status === "running")) {
      mobileSnapshotRestorePtyId = null;
      saveMobileSnapshotPtyId(null);
    }
    const runningPtys = ptys.filter((p) => p.status === "running");
    if (activePtyId) {
      const previousActivePtyId = activePtyId;
      const active = ptys.find((p) => p.id === activePtyId);
      if (!active || active.status !== "running") {
        // PTY ID disappeared (e.g. server restart assigned new IDs).
        // Try to re-match by tmux session identity before giving up.
        const saved = loadSavedActivePty();
        const fallback = saved?.tmuxSession
          ? runningPtys.find(
            (p) =>
              p.backend === "tmux" &&
              (saved.tmuxServer ? p.tmuxServer === saved.tmuxServer : true) &&
              (p.tmuxSession === saved.tmuxSession ||
                (p.tmuxSession ?? "").startsWith(saved.tmuxSession + ":") ||
                saved.tmuxSession.startsWith((p.tmuxSession ?? "") + ":")),
          )
          : null;
        if (fallback) {
          remapPtyState(previousActivePtyId, fallback.id);
          setActive(fallback.id);
        } else {
          activePtyId = null;
          saveActivePty(null);
        }
      }
    }
    if (!activePtyId && !pendingActivePtyId) {
      const saved = loadSavedActivePty();
      const target = saved
        ? (
          runningPtys.find((p) => p.id === saved.ptyId) ??
          (saved.tmuxSession
            ? runningPtys.find(
              (p) =>
                p.backend === "tmux" &&
                p.tmuxSession === saved.tmuxSession &&
                (saved.tmuxServer ? p.tmuxServer === saved.tmuxServer : true),
            )
            : null)
        )
        : null;
      if (target) {
        setActive(target.id);
      }
    }

    // Drop terminals for sessions that are no longer running.
    const running = new Set(runningPtys.map((p) => p.id));
    const allKnown = new Set(ptys.map((p) => p.id));
    prunePtyInputMeta(allKnown);
    prunePrWaitingForReviewPtys(running);
    for (const p of ptys) {
      const previousReady = ptyReady.get(p.id);
      const nextReady = readinessFromSummary(p);
      ptyReady.set(p.id, nextReady);
      if (p.id === activePtyId || p.status !== "running" || nextReady.state !== "ready") {
        unviewedReadyPtys.delete(p.id);
      } else if (shouldMarkReadyUnviewed(p.id, previousReady, nextReady)) {
        unviewedReadyPtys.add(p.id);
      }
    }
    for (const ptyId of ptyReady.keys()) {
      if (!running.has(ptyId)) ptyReady.delete(ptyId);
    }
    for (const ptyId of unviewedReadyPtys) {
      if (!running.has(ptyId)) unviewedReadyPtys.delete(ptyId);
    }
    for (const ptyId of ptyStateChangedAt.keys()) {
      if (!running.has(ptyId)) ptyStateChangedAt.delete(ptyId);
    }
    for (const ptyId of terms.keys()) {
      if (!running.has(ptyId)) removeTerm(ptyId);
    }

    if (pendingActivePtyId) {
      const pending = ptys.find((p) => p.id === pendingActivePtyId);
      if (pending && pending.status === "running") {
        setActive(pendingActivePtyId);
      }
    }

    updateTerminalVisibility();
    updateKickButtonVisibility();
    reflowActiveTerm();
    renderList();

    // Check directory existence for pinned dirs and inactive session dirs without running PTYs
    const allSessionDirs = new Set<string>(pinnedDirectories);
    for (const s of agentSessions) {
      const key = s.projectRoot ?? (s.cwd ? normalizeCwdGroupKey(s.cwd) : null);
      if (key) allSessionDirs.add(key);
    }
    const dirsToCheck = [...allSessionDirs].filter((d) => {
      if (!d) return false;
      if (directoryExistsCache.has(d)) return false;
      return !ptys.some((p) => p.status === "running" && ptyProjectKey(p) === d);
    });
    if (dirsToCheck.length > 0) {
      void checkDirectoryExistence(dirsToCheck).then(() => {
        autoArchiveMissingDirectories();
        renderList();
      });
    }

    return;
  }
  if (msg.type === "pty_output") {
    const st = ensureTerm(msg.ptyId);
    st.term.write(msg.data, () => {
      if (msg.ptyId === activePtyId) {
        updateFollowButtonVisibility();
        scheduleReflow();
      }
      if (mobileViewport) scheduleMobileRender();
    });
    return;
  }
  if (msg.type === "pty_exit") {
    ptyReady.set(msg.ptyId, { state: "busy", indicator: "busy", reason: "exited" });
    unviewedReadyPtys.delete(msg.ptyId);
    addEvent(`PTY exited: ${msg.ptyId} code=${msg.code ?? "?"} signal=${msg.signal ?? "-"}`);
    refreshList();
    return;
  }
  if (msg.type === "pty_ready") {
    const previousReady = ptyReady.get(msg.ptyId);
    const nextReady = { state: msg.state, indicator: msg.indicator, reason: msg.reason };
    ptyReady.set(msg.ptyId, nextReady);
    ptyStateChangedAt.set(msg.ptyId, msg.ts);
    if (msg.ptyId === activePtyId || msg.state !== "ready") {
      unviewedReadyPtys.delete(msg.ptyId);
    } else if (shouldMarkReadyUnviewed(msg.ptyId, previousReady, nextReady)) {
      unviewedReadyPtys.add(msg.ptyId);
    }
    const p = ptys.find((x) => x.id === msg.ptyId);
    if (p) {
      if (msg.cwd != null) p.cwd = msg.cwd;
      if (msg.activeProcess !== undefined) p.activeProcess = msg.activeProcess;
    }
    renderList();
    return;
  }
  if (msg.type === "trigger_fired") {
    addEvent(`[${msg.ptyId}] trigger ${msg.trigger}: ${msg.match}`);
    highlight(msg.ptyId, 2000);
    return;
  }
  if (msg.type === "trigger_error") {
    addEvent(`[${msg.ptyId}] trigger error ${msg.trigger}: ${msg.message}`);
    return;
  }
  if (msg.type === "pty_highlight") {
    highlight(msg.ptyId, msg.ttlMs);
    return;
  }
  if (msg.type === "mobile_snapshot_response") {
    if (msg.requestId === mobileTerminalSnapshotPendingRequestId) {
      mobileTerminalSnapshotPendingRequestId = null;
      if (!mobileTerminalSnapshot || msg.ptyId !== mobileTerminalSnapshot.ptyId) return;
      if (!msg.ok) {
        mobileTerminalSnapshot = {
          ...mobileTerminalSnapshot,
          capturedAt: "",
          text: "",
          lineCount: 0,
          truncated: false,
          loading: false,
          error: msg.error,
        };
        renderMobileViewState();
        return;
      }
      mobileTerminalSnapshot = {
        ...mobileTerminalSnapshot,
        seq: ++mobileTerminalSnapshotSeq,
        capturedAt: new Date(msg.capturedAt).toLocaleTimeString(),
        text: msg.text,
        lineCount: msg.lineCount,
        truncated: msg.truncated,
        loading: false,
        error: null,
      };
      renderMobileViewState();
      return;
    }

    if (desktopHydrationPending && msg.requestId === desktopHydrationPending.requestId) {
      const pendingPtyId = desktopHydrationPending.ptyId;
      desktopHydrationPending = null;
      if (!msg.ok) return;
      const st = terms.get(msg.ptyId);
      if (!st) return;
      if (msg.ptyId !== pendingPtyId) return;
      if (termBufferHasRenderableText(st)) return;
      if (!msg.text) return;
      st.term.write(msg.text, () => {
        if (msg.ptyId === activePtyId) {
          updateFollowButtonVisibility();
          scheduleReflow();
          requestAnimationFrame(() => refreshTermViewport(st));
        }
        if (mobileViewport) scheduleMobileRender();
      });
    }
    return;
  }
  if (msg.type === "viewer_counts") {
    viewerCounts = msg.counts;
    updateKickButtonVisibility();
    return;
  }
}

/** Other running PTYs on the same tmux session group as the active PTY. */
function sameSessionPtys(): PtySummary[] {
  const active = activePtyId ? ptys.find((p) => p.id === activePtyId) : null;
  if (!active?.tmuxSession) return [];
  const marker = "_view_";
  const idx = active.tmuxSession.lastIndexOf(marker);
  if (idx <= 0) return [];
  const base = active.tmuxSession.slice(0, idx);
  return ptys.filter(
    (p) =>
      p.id !== activePtyId &&
      p.status === "running" &&
      p.tmuxServer === active.tmuxServer &&
      typeof p.tmuxSession === "string" &&
      p.tmuxSession.startsWith(`${base}${marker}`),
  );
}

function updateKickButtonVisibility(): void {
  if (!activePtyId || mobileViewport) {
    btnKickOthers.classList.add("hidden");
    return;
  }
  const wsOthers = Math.max(0, (viewerCounts[activePtyId] ?? 0) - 1);
  const sessionOthers = sameSessionPtys().length;
  const total = wsOthers + sessionOthers;
  if (total > 0) {
    btnKickOthers.textContent = total === 1 ? "1 other view \u00d7" : `${total} other views \u00d7`;
    btnKickOthers.classList.remove("hidden");
  } else {
    btnKickOthers.classList.add("hidden");
  }
}

function tmuxSessionKey(s: TmuxSessionInfo): string {
  return `${s.server}:${s.name}`;
}

function selectedTmuxSession(): TmuxSessionInfo | null {
  const key = selectedTmuxSessionKey;
  if (!key) return null;
  return tmuxSessions.find((s) => tmuxSessionKey(s) === key) ?? null;
}

function tmuxSessionLabel(s: TmuxSessionInfo): string {
  const stamp = s.createdAt ? new Date(s.createdAt).toLocaleTimeString() : "";
  const win = s.windows == null ? "" : `, ${s.windows}w`;
  return `${s.name} [${s.server}${win}]${stamp ? ` @ ${stamp}` : ""}`;
}

async function refreshTmuxSessions(): Promise<void> {
  const prev = selectedTmuxSessionKey;
  const res = await authFetch("/api/tmux/sessions", { cache: "no-store" });
  if (!res.ok) {
    addEvent(`Failed to list tmux sessions: ${await readApiError(res)}`);
    return;
  }
  const json = (await res.json()) as { sessions?: unknown };
  if (!Array.isArray(json.sessions)) {
    addEvent("Failed to parse tmux session list");
    return;
  }

  tmuxSessions = json.sessions as TmuxSessionInfo[];
  if (tmuxSessions.length === 0) {
    selectedTmuxSessionKey = "";
    if (settingsModalState) renderSettingsModalState();
    return;
  }
  selectedTmuxSessionKey = tmuxSessions.some((s) => tmuxSessionKey(s) === prev)
    ? prev
    : tmuxSessionKey(tmuxSessions[0]);
  if (settingsModalState) renderSettingsModalState();
}

async function fetchTmuxSessionWarnings(selected: TmuxSessionInfo): Promise<string[]> {
  const qs = new URLSearchParams({
    name: selected.name,
    server: selected.server,
  });
  const res = await authFetch(`/api/tmux/check?${qs.toString()}`, { cache: "no-store" });
  if (!res.ok) {
    addEvent(`Failed to check tmux config: ${await readApiError(res)}`);
    return [];
  }
  const json = (await res.json()) as { checks?: TmuxSessionCheck };
  return Array.isArray(json.checks?.warnings) ? json.checks.warnings : [];
}

async function checkSelectedTmuxSessionAndMaybeWarn(): Promise<void> {
  const selected = selectedTmuxSession();
  if (!selected) return;
  const warnings = await fetchTmuxSessionWarnings(selected);
  if (warnings.length === 0) return;
  window.alert(
    `Selected tmux session has problematic settings:\n\n${warnings.map((w) => `- ${w}`).join("\n")}`,
  );
}

function addEvent(text: string): void {
  if (!eventsEl) return;
  const el = document.createElement("div");
  el.className = "event";
  el.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  eventsEl.prepend(el);
  while (eventsEl.children.length > 50) eventsEl.removeChild(eventsEl.lastElementChild!);
}

type RefreshListOptions = {
  forceAgentSessions?: boolean;
};

const AGENT_SESSIONS_REFRESH_ACTIVE_MS = 30_000;
const AGENT_SESSIONS_REFRESH_IDLE_MS = 60_000;
const AGENT_SESSIONS_REFRESH_HIDDEN_MS = 300_000;

let listRefreshInFlight = false;
let lastAgentSessionsRefreshAt = 0;

function agentSessionsRefreshInterval(): number {
  if (document.hidden) return AGENT_SESSIONS_REFRESH_HIDDEN_MS;
  const running = ptys.some((p) => p.status === "running");
  return running ? AGENT_SESSIONS_REFRESH_ACTIVE_MS : AGENT_SESSIONS_REFRESH_IDLE_MS;
}

function shouldRefreshAgentSessions(force = false, now = Date.now()): boolean {
  if (force || lastAgentSessionsRefreshAt === 0 || agentSessions.length === 0) return true;
  return now - lastAgentSessionsRefreshAt >= agentSessionsRefreshInterval();
}

function samePtys(a: PtySummary[], b: PtySummary[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (!left || !right) return false;
    if (left.id !== right.id) return false;
    if ((left.name ?? "") !== (right.name ?? "")) return false;
    if (left.status !== right.status) return false;
    if ((left.cwd ?? null) !== (right.cwd ?? null)) return false;
    if ((left.tmuxSession ?? null) !== (right.tmuxSession ?? null)) return false;
    if ((left.tmuxServer ?? null) !== (right.tmuxServer ?? null)) return false;
    if ((left.activeProcess ?? null) !== (right.activeProcess ?? null)) return false;
    if ((left.readyState ?? null) !== (right.readyState ?? null)) return false;
    if ((left.readyIndicator ?? null) !== (right.readyIndicator ?? null)) return false;
    if ((left.readyReason ?? null) !== (right.readyReason ?? null)) return false;
    if ((left.readyStateChangedAt ?? null) !== (right.readyStateChangedAt ?? null)) return false;
    if ((left.agentSessionId ?? null) !== (right.agentSessionId ?? null)) return false;
  }
  return true;
}

function sameAgentSessions(a: AgentSessionSummary[], b: AgentSessionSummary[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (!left || !right) return false;
    if (left.id !== right.id) return false;
    if (left.lastSeenAt !== right.lastSeenAt) return false;
    if ((left.lastRestoredAt ?? null) !== (right.lastRestoredAt ?? null)) return false;
    if ((left.cwd ?? null) !== (right.cwd ?? null)) return false;
    if ((left.cwdSource ?? null) !== (right.cwdSource ?? null)) return false;
    if ((left.name ?? "") !== (right.name ?? "")) return false;
    if ((left.projectRoot ?? null) !== (right.projectRoot ?? null)) return false;
    if ((left.worktree ?? null) !== (right.worktree ?? null)) return false;
  }
  return true;
}

async function refreshList(options: RefreshListOptions = {}): Promise<void> {
  if (listRefreshInFlight) return;
  listRefreshInFlight = true;
  try {
    const refreshAgentSessions = shouldRefreshAgentSessions(options.forceAgentSessions);
    const [ptysRes, sessionsRes] = await Promise.all([
      authFetch("/api/ptys", { cache: "no-store" }),
      refreshAgentSessions ? authFetch("/api/agent-sessions", { cache: "no-store" }) : Promise.resolve(null),
    ]);

    if (!ptysRes.ok) {
      throw new Error(await readApiError(ptysRes));
    }
    const ptysJson = (await ptysRes.json()) as { ptys?: unknown };
    if (!Array.isArray(ptysJson.ptys)) {
      throw new Error("invalid PTY list response");
    }
    const nextPtys = ptysJson.ptys as PtySummary[];
    let nextAgentSessions = agentSessions;

    if (sessionsRes) {
      if (sessionsRes.ok) {
        const sessionsJson = (await sessionsRes.json()) as { sessions?: unknown };
        if (Array.isArray(sessionsJson.sessions)) {
          nextAgentSessions = sessionsJson.sessions as AgentSessionSummary[];
        } else {
          nextAgentSessions = [];
        }
        lastAgentSessionsRefreshAt = Date.now();
      } else {
        nextAgentSessions = [];
        lastAgentSessionsRefreshAt = Date.now();
        addEvent(`Failed to refresh agent sessions: ${await readApiError(sessionsRes)}`);
      }
    }

    const ptysChanged = !samePtys(ptys, nextPtys);
    const sessionsChanged = !sameAgentSessions(agentSessions, nextAgentSessions);
    if (!ptysChanged && !sessionsChanged) return;

    ptys = nextPtys;
    agentSessions = nextAgentSessions;

    syncProviderHistoryStateWithPtys();
    prunePrWaitingForReviewPtys(new Set(ptys.filter((p) => p.status === "running").map((p) => p.id)));
    updateTerminalVisibility();
    renderList();
  } catch (err) {
    addEvent(`Failed to refresh PTYs: ${errorMessage(err)}`);
  } finally {
    listRefreshInFlight = false;
  }
}

function hashHue(s: string): number {
  // Deterministic, cheap hash -> hue in [0, 359].
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function ptyColor(ptyId: string): string {
  return hashColor(ptyId);
}

function hashColor(seed: string): string {
  return `hsl(${hashHue(seed)} ${activeTheme.hashSaturation}% ${activeTheme.hashLightness}%)`;
}

function worktreeColor(worktreeName: string): string {
  return hashColor(`worktree:${worktreeName}`);
}

function shortId(ptyId: string): string {
  if (ptyId.length <= 14) return ptyId;
  return `${ptyId.slice(0, 6)}...${ptyId.slice(-6)}`;
}

function compactWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function cleanupCopiedTerminalText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/^ {2}/, "").replace(/[ \t]+$/g, ""))
    .join("\n")
    .trimEnd();
}

const AGENT_CHOICES = ["claude", "codex", "shell"];

type OptionDef =
  | { type: "select"; flag: string; label: string; choices: { value: string; label: string }[]; defaultValue: string }
  | { type: "checkbox"; flag: string; label: string; defaultChecked: boolean };

/** Per-agent launch options, matching the actual CLI flags. */
const AGENT_OPTIONS: Record<string, OptionDef[]> = {
  claude: [
    {
      type: "select", flag: "--permission-mode", label: "Permission mode",
      defaultValue: "default",
      choices: [
        { value: "default", label: "default" },
        { value: "acceptEdits", label: "acceptEdits" },
        { value: "bypassPermissions", label: "bypassPermissions" },
        { value: "plan", label: "plan" },
      ],
    },
    { type: "checkbox", flag: "--dangerously-skip-permissions", label: "--dangerously-skip-permissions", defaultChecked: true },
  ],
  codex: [
    {
      type: "select", flag: "--ask-for-approval", label: "Ask for approval",
      defaultValue: "on-request",
      choices: [
        { value: "untrusted", label: "untrusted" },
        { value: "on-failure", label: "on-failure" },
        { value: "on-request", label: "on-request" },
        { value: "never", label: "never" },
      ],
    },
    {
      type: "select", flag: "--sandbox", label: "Sandbox",
      defaultValue: "workspace-write",
      choices: [
        { value: "read-only", label: "read-only" },
        { value: "workspace-write", label: "workspace-write" },
        { value: "danger-full-access", label: "danger-full-access" },
      ],
    },
    { type: "checkbox", flag: "--full-auto", label: "--full-auto", defaultChecked: true },
    { type: "checkbox", flag: "--dangerously-bypass-approvals-and-sandbox", label: "--dangerously-bypass-approvals-and-sandbox", defaultChecked: false },
  ],
};

function generateBranchName(): string {
  const verbs = [
    "build", "craft", "debug", "patch", "tune", "refine", "shape", "forge", "spark", "wire",
    "mend", "hone", "trace", "carve", "weave", "align", "fuse", "solve", "twist", "stitch",
    "sand", "temper", "splice", "prime", "sift", "grind", "weld", "buff", "etch", "mold",
  ];
  const nouns = [
    "otter", "falcon", "comet", "maple", "cedar", "harbor", "reef", "prism", "flint", "ridge",
    "heron", "quartz", "ember", "thorn", "birch", "delta", "summit", "dusk", "grove", "crest",
    "pike", "frost", "anvil", "cairn", "drift", "glyph", "vale", "shard", "moss", "blaze",
  ];
  const verb = verbs[Math.floor(Math.random() * verbs.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${verb}-${noun}`;
}

type WorktreeOption = { value: string; label: string };

type LaunchModalState = {
  selectedAgent: string;
  directoryOptions: { value: string; label: string }[];
  selectedDirectory: string;
  customDirectoryValue: string;
  selectedWorktree: string;
  customWorktreeTouched: boolean;
  branchValue: string;
  baseBranchValue: string;
  baseBranchOptions: WorktreeOption[];
  generatedBranch: string;
  launching: boolean;
  savedFlags: Record<string, Record<string, string | boolean>>;
  worktreeOptions: WorktreeOption[];
  projectRoot: string;
};

const launchModalRoot = document.createElement("div");
document.body.appendChild(launchModalRoot);
let launchModalState: LaunchModalState | null = null;
let launchModalSeq = 0;
let customDirRefreshTimer: ReturnType<typeof setTimeout> | undefined;
const NOOP_LAUNCH_HANDLERS = {
  onClose: () => {},
  onAgentChange: () => {},
  onOptionChange: () => {},
  onDirectoryChange: () => {},
  onCustomDirectoryChange: () => {},
  onWorktreeChange: () => {},
  onBranchChange: () => {},
  onBaseBranchChange: () => {},
  onLaunch: () => {},
};

function buildWorktreeOptions(
  groupCwd: string,
  worktrees?: Array<{ name: string; path: string }>,
  allowNewWorktree = true,
): WorktreeOption[] {
  const options: WorktreeOption[] = allowNewWorktree ? [{ value: "__new__", label: "+ New worktree" }] : [];
  if (groupCwd) {
    const name = groupCwd.split("/").filter(Boolean).at(-1) ?? groupCwd;
    options.push({ value: groupCwd, label: `Current (${name})` });
  }
  if (Array.isArray(worktrees)) {
    for (const wt of worktrees) {
      if (!wt || typeof wt.path !== "string" || typeof wt.name !== "string") continue;
      if (groupCwd && wt.path === groupCwd) continue;
      options.push({ value: wt.path, label: wt.name });
    }
  }
  return options;
}

function buildBranchOptions(
  branches?: Array<{ name: string }>,
  preferredBranch?: string,
): WorktreeOption[] {
  const names = new Set<string>();
  const options: WorktreeOption[] = [];
  const addBranch = (name: unknown) => {
    if (typeof name !== "string") return;
    const trimmed = name.trim();
    if (!trimmed || names.has(trimmed)) return;
    names.add(trimmed);
    options.push({ value: trimmed, label: trimmed });
  };
  addBranch(preferredBranch);
  if (Array.isArray(branches)) {
    for (const branch of branches) addBranch(branch?.name);
  }
  return options;
}

function syncBaseBranchSelection(state: LaunchModalState): void {
  if (state.baseBranchOptions.length === 0) return;
  if (state.baseBranchOptions.some((branch) => branch.value === state.baseBranchValue)) return;
  state.baseBranchValue = state.baseBranchOptions[0]?.value ?? state.baseBranchValue;
}

function syncLaunchWorktreeSelection(
  state: LaunchModalState,
  dir: string,
  options: WorktreeOption[],
): void {
  if (state.selectedDirectory === "__custom__" && !state.customWorktreeTouched) {
    state.selectedWorktree = options.some((opt) => opt.value === dir)
      ? dir
      : (options[0]?.value ?? "");
    return;
  }
  if (!options.some((opt) => opt.value === state.selectedWorktree)) {
    state.selectedWorktree = options[0]?.value ?? "";
  }
}

function buildDirectoryOptions(): { value: string; label: string }[] {
  const dirs = new Set<string>();
  // Add all active group keys: pinned dirs + dirs with running PTYs
  for (const dir of pinnedDirectories) {
    if (dir && !archivedDirectories.has(dir)) dirs.add(dir);
  }
  for (const p of ptys) {
    if (p.status === "running" && p.cwd) {
      const key = ptyProjectKey(p);
      if (key && !archivedDirectories.has(key)) dirs.add(key);
    }
  }
  const sorted = [...dirs].sort((a, b) => {
    const ba = a.split("/").filter(Boolean).at(-1) ?? a;
    const bb = b.split("/").filter(Boolean).at(-1) ?? b;
    return ba.localeCompare(bb);
  });
  const options = sorted.map((d) => ({
    value: d,
    label: d.split("/").filter(Boolean).at(-1) ?? d,
  }));
  options.push({ value: "__custom__", label: "Custom path..." });
  return options;
}

function getEffectiveProjectRoot(state: LaunchModalState): string {
  if (state.selectedDirectory === "__custom__") return state.customDirectoryValue;
  return state.selectedDirectory;
}

function buildLaunchOptionControls(state: LaunchModalState): LaunchOptionControl[] {
  const defs = AGENT_OPTIONS[state.selectedAgent] ?? [];
  const saved = state.savedFlags[state.selectedAgent] ?? {};
  return defs.map((def) =>
    def.type === "select"
      ? {
        type: "select",
        flag: def.flag,
        label: def.label,
        value: typeof saved[def.flag] === "string" ? String(saved[def.flag]) : def.defaultValue,
        choices: def.choices,
      }
      : {
        type: "checkbox",
        flag: def.flag,
        label: def.label,
        checked: typeof saved[def.flag] === "boolean" ? Boolean(saved[def.flag]) : def.defaultChecked,
      });
}

function closeLaunchModal(): void {
  launchModalState = null;
  renderLaunchModal(launchModalRoot, null, NOOP_LAUNCH_HANDLERS);
}

function renderLaunchModalState(): void {
  const state = launchModalState;
  const effectiveRoot = state ? getEffectiveProjectRoot(state) : "";
  const model: LaunchModalViewModel | null = state
    ? {
      agentChoices: AGENT_CHOICES,
      selectedAgent: state.selectedAgent,
      optionControls: buildLaunchOptionControls(state),
      directoryOptions: state.directoryOptions,
      selectedDirectory: state.selectedDirectory,
      customDirectoryValue: state.customDirectoryValue,
      worktreeOptions: state.worktreeOptions,
      selectedWorktree: state.selectedWorktree,
      branchValue: state.branchValue,
      branchPlaceholder: state.generatedBranch,
      baseBranchValue: state.baseBranchValue,
      baseBranchOptions: state.baseBranchOptions,
      launching: state.launching,
      projectName: effectiveRoot ? effectiveRoot.split("/").pop() : undefined,
    }
    : null;

  renderLaunchModal(launchModalRoot, model, {
    onClose: () => closeLaunchModal(),
    onAgentChange: (agent) => {
      if (!launchModalState) return;
      launchModalState.selectedAgent = agent;
      renderLaunchModalState();
    },
    onOptionChange: (flag, value) => {
      if (!launchModalState) return;
      const agentFlags = launchModalState.savedFlags[launchModalState.selectedAgent] ?? {};
      agentFlags[flag] = value;
      launchModalState.savedFlags[launchModalState.selectedAgent] = agentFlags;
      renderLaunchModalState();
    },
    onDirectoryChange: (dir) => {
      if (!launchModalState) return;
      launchModalState.selectedDirectory = dir;
      launchModalState.projectRoot = dir === "__custom__" ? launchModalState.customDirectoryValue : dir;
      if (dir === "__custom__") launchModalState.customWorktreeTouched = false;
      renderLaunchModalState();
      // Re-fetch worktrees and default branch for the new directory
      const effectiveRoot = getEffectiveProjectRoot(launchModalState);
      if (effectiveRoot) {
        refreshLaunchModalForDirectory(effectiveRoot);
      }
    },
    onCustomDirectoryChange: (pathValue) => {
      if (!launchModalState) return;
      launchModalState.customDirectoryValue = pathValue;
      launchModalState.projectRoot = pathValue;
      launchModalState.customWorktreeTouched = false;
      renderLaunchModalState();
      // Debounce directory refresh for custom path
      clearTimeout(customDirRefreshTimer);
      customDirRefreshTimer = setTimeout(() => {
        if (!launchModalState || launchModalState.selectedDirectory !== "__custom__") return;
        const dir = launchModalState.customDirectoryValue.trim();
        if (dir) refreshLaunchModalForDirectory(dir);
      }, 500);
    },
    onWorktreeChange: (worktree) => {
      if (!launchModalState) return;
      launchModalState.selectedWorktree = worktree;
      if (launchModalState.selectedDirectory === "__custom__") launchModalState.customWorktreeTouched = true;
      renderLaunchModalState();
    },
    onBranchChange: (branch) => {
      if (!launchModalState) return;
      launchModalState.branchValue = branch;
      renderLaunchModalState();
    },
    onBaseBranchChange: (baseBranch) => {
      if (!launchModalState) return;
      launchModalState.baseBranchValue = baseBranch;
      renderLaunchModalState();
    },
    onLaunch: () => {
      if (!launchModalState || launchModalState.launching) return;
      const stateNow = launchModalState;
      if (!stateNow.selectedAgent || !stateNow.selectedWorktree) return;
      stateNow.launching = true;
      renderLaunchModalState();

      const branch = stateNow.selectedWorktree === "__new__"
        ? (stateNow.branchValue.trim() || stateNow.generatedBranch)
        : undefined;
      const baseBranch = stateNow.selectedWorktree === "__new__"
        ? (stateNow.baseBranchValue.trim() || stateNow.baseBranchOptions[0]?.value || "main")
        : undefined;
      const flags = stateNow.savedFlags[stateNow.selectedAgent] ?? {};
      const effectiveProjectRoot = getEffectiveProjectRoot(stateNow);

      void authFetch("/api/ptys/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: stateNow.selectedAgent,
          worktree: stateNow.selectedWorktree,
          branch,
          baseBranch,
          flags,
          projectRoot: effectiveProjectRoot || undefined,
        }),
      })
        .then(async (res) => {
          if (res.ok) {
            const { id } = await res.json() as { id: string };
            const projectRoot = effectiveProjectRoot;
            void authFetch("/api/launch-preferences", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                projectRoot: projectRoot || undefined,
                agent: stateNow.selectedAgent,
                worktree: stateNow.selectedWorktree,
                flags: stateNow.savedFlags,
              }),
            }).catch(() => {});
            closeLaunchModal();
            void refreshWorktreeCache().then(() => renderList());
            setActive(id);
            return;
          }
          const msg = await readApiError(res);
          throw new Error(msg || "Launch failed");
        })
        .catch((err) => {
          if (!launchModalState) return;
          launchModalState.launching = false;
          renderLaunchModalState();
          window.alert(errorMessage(err));
        });
    },
  });
}

function refreshLaunchModalForDirectory(dir: string): void {
  const seq = launchModalSeq;

  const branchesUrl = dir
    ? `/api/branches?projectRoot=${encodeURIComponent(dir)}`
    : "/api/branches";
  void authFetch(branchesUrl)
    .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(await readApiError(r)))))
    .then((data: { branches?: Array<{ name: string }>; defaultBranch?: string }) => {
      if (seq !== launchModalSeq || !launchModalState) return;
      launchModalState.baseBranchOptions = buildBranchOptions(data.branches, data.defaultBranch);
      if (data.defaultBranch) launchModalState.baseBranchValue = data.defaultBranch;
      syncBaseBranchSelection(launchModalState);
      renderLaunchModalState();
    })
    .catch(() => {
      const branchUrl = dir
        ? `/api/default-branch?projectRoot=${encodeURIComponent(dir)}`
        : "/api/default-branch";
      void authFetch(branchUrl)
        .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(await readApiError(r)))))
        .then((data: { branch?: string }) => {
          if (seq !== launchModalSeq || !launchModalState) return;
          launchModalState.baseBranchOptions = [];
          if (data.branch) {
            launchModalState.baseBranchValue = data.branch;
            renderLaunchModalState();
          }
        })
        .catch(() => {});
    });

  const wtUrl = dir
    ? `/api/worktrees?projectRoot=${encodeURIComponent(dir)}`
    : "/api/worktrees";
  void authFetch(wtUrl)
    .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(await readApiError(r)))))
    .then((data: { worktrees?: Array<{ name: string; path: string }> }) => {
      if (seq !== launchModalSeq || !launchModalState) return;
      const options = buildWorktreeOptions(dir, data.worktrees, true);
      launchModalState.worktreeOptions = options;
      syncLaunchWorktreeSelection(launchModalState, dir, options);
      renderLaunchModalState();
    })
    .catch(() => {
      if (seq !== launchModalSeq || !launchModalState) return;
      const options = buildWorktreeOptions(dir, undefined, false);
      launchModalState.worktreeOptions = options;
      syncLaunchWorktreeSelection(launchModalState, dir, options);
      renderLaunchModalState();
    });
}

function openLaunchModal(groupCwd: string, preselectedWorktree?: string): void {
  const seq = ++launchModalSeq;
  const dirOptions = buildDirectoryOptions();
  // If opening from an active group's +, pre-select that directory; otherwise default to __custom__
  const preselectedDir = groupCwd && dirOptions.some((d) => d.value === groupCwd) ? groupCwd : "__custom__";
  const homeDir = typeof window !== "undefined" ? "" : "";

  launchModalState = {
    selectedAgent: AGENT_CHOICES[0],
    directoryOptions: dirOptions,
    selectedDirectory: preselectedDir,
    customDirectoryValue: preselectedDir === "__custom__" ? (groupCwd || homeDir) : "",
    selectedWorktree: preselectedWorktree ?? "__new__",
    customWorktreeTouched: false,
    branchValue: "",
    baseBranchValue: "",
    baseBranchOptions: [],
    generatedBranch: generateBranchName(),
    launching: false,
    savedFlags: {},
    worktreeOptions: buildWorktreeOptions(groupCwd),
    projectRoot: groupCwd,
  };
  renderLaunchModalState();

  const prefsUrl = groupCwd
    ? `/api/launch-preferences?projectRoot=${encodeURIComponent(groupCwd)}`
    : "/api/launch-preferences";
  void authFetch(prefsUrl)
    .then((r) => (r.ok ? r.json() : {}))
    .then((prefs: { agent?: string; flags?: Record<string, Record<string, string | boolean>>; worktree?: string }) => {
      if (seq !== launchModalSeq || !launchModalState) return;
      if (prefs.flags && typeof prefs.flags === "object") {
        for (const [agent, flags] of Object.entries(prefs.flags)) {
          if (flags && typeof flags === "object") {
            launchModalState.savedFlags[agent] = flags;
          }
        }
      }
      if (prefs.agent && AGENT_CHOICES.includes(prefs.agent)) {
        launchModalState.selectedAgent = prefs.agent;
      }
      if (typeof prefs.worktree === "string" && !preselectedWorktree) {
        launchModalState.selectedWorktree = prefs.worktree;
      }
      renderLaunchModalState();
    })
    .catch(() => {});

  refreshLaunchModalForDirectory(groupCwd);
}

// --- Close worktree modal ---

const closeWorktreeModalRoot = document.createElement("div");
document.body.appendChild(closeWorktreeModalRoot);

type CloseWorktreeModalState = {
  ptyId: string;
  ptyProcess: string;
  worktreeName: string;
  worktreePath: string;
  canRemoveWorktree: boolean;
  dirty: boolean | null;
  changes: string[];
  closing: boolean;
};

let closeWorktreeModalState: CloseWorktreeModalState | null = null;

const NOOP_CLOSE_WORKTREE_HANDLERS = {
  onClose: () => {},
  onCloseSession: () => {},
  onCloseAndRemove: () => {},
};

function renderCloseWorktreeModalState(): void {
  const state = closeWorktreeModalState;
  const model: CloseWorktreeModalViewModel | null = state
    ? {
      ptyProcess: state.ptyProcess,
      worktreeName: state.worktreeName,
      canRemoveWorktree: state.canRemoveWorktree,
      dirty: state.dirty,
      changes: state.changes,
      closing: state.closing,
    }
    : null;

  renderCloseWorktreeModal(closeWorktreeModalRoot, model, {
    onClose: () => {
      closeWorktreeModalState = null;
      renderCloseWorktreeModalState();
    },
    onCloseSession: () => {
      if (!closeWorktreeModalState) return;
      const { ptyId } = closeWorktreeModalState;
      closeWorktreeModalState = null;
      renderCloseWorktreeModalState();
      void killPtyDirect(ptyId);
    },
    onCloseAndRemove: () => {
      if (!closeWorktreeModalState || closeWorktreeModalState.closing) return;
      closeWorktreeModalState.closing = true;
      renderCloseWorktreeModalState();
      const { ptyId, worktreePath } = closeWorktreeModalState;
      void (async () => {
        await killPtyDirect(ptyId);
        try {
          await authFetch("/api/worktrees", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: worktreePath }),
          });
        } catch {
          // ignore worktree removal failure
        }
        closeWorktreeModalState = null;
        renderCloseWorktreeModalState();
      })();
    },
  });
}

function openCloseWorktreeModal(ptyId: string): void {
  const p = ptys.find((x) => x.id === ptyId);
  if (!p) return;
  const wt = ptyWorktreeLabel(p);
  if (!wt || !p.cwd) return;

  const readyInfo = ptyReady.get(p.id) ?? readinessFromSummary(p);
  const activeProcess = compactWhitespace(p.activeProcess ?? "");
  const process =
    (activeProcess && !isShellProcess(activeProcess) ? activeProcess : "") || activeProcess || p.name;

  // Determine the full worktree path from the cwd
  const matchedWt = findContainingWorktree(p.cwd, knownWorktrees);
  const worktreePath = matchedWt ? matchedWt.path : p.cwd;
  const canRemoveWorktree = !isMainWorktreeForCwd(p.cwd, knownWorktrees, serverRepoRoot);

  closeWorktreeModalState = {
    ptyId,
    ptyProcess: process,
    worktreeName: wt,
    worktreePath,
    canRemoveWorktree,
    dirty: null,
    changes: [],
    closing: false,
  };
  renderCloseWorktreeModalState();

  // Fetch dirty status
  void authFetch(`/api/worktrees/status?path=${encodeURIComponent(worktreePath)}`)
    .then(async (res) => {
      if (!closeWorktreeModalState || closeWorktreeModalState.ptyId !== ptyId) return;
      if (res.ok) {
        const json = (await res.json()) as { dirty?: boolean; changes?: string[] };
        closeWorktreeModalState.dirty = json.dirty === true;
        closeWorktreeModalState.changes = Array.isArray(json.changes) ? json.changes : [];
      } else {
        closeWorktreeModalState.dirty = false;
      }
      renderCloseWorktreeModalState();
    })
    .catch(() => {
      if (!closeWorktreeModalState || closeWorktreeModalState.ptyId !== ptyId) return;
      closeWorktreeModalState.dirty = false;
      renderCloseWorktreeModalState();
    });
}

const shellProcessNames = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu"]);
const runtimeProcessNames = new Set(["node", "python", "python3", "bun", "deno"]);
const normalizedThreadBaseNames = new Set([...shellProcessNames, ...runtimeProcessNames]);

function normalizeProcessName(s: string): string {
  const v = s.trim();
  if (!v) return "";
  const base = (v.split("/").filter(Boolean).at(-1) ?? v).toLowerCase();
  if (base.endsWith("-mainthread")) {
    const candidate = base.slice(0, -"-mainthread".length);
    if (normalizedThreadBaseNames.has(candidate)) return candidate;
  }
  return base;
}

function isShellProcess(s: string): boolean {
  return shellProcessNames.has(normalizeProcessName(s));
}

function isGenericRuntimeProcess(s: string): boolean {
  return runtimeProcessNames.has(normalizeProcessName(s));
}

function inferAgentFromRecentInput(ptyId: string): "codex" | "claude" | null {
  const recent = (ptyLastInput.get(ptyId) ?? "").toLowerCase();
  if (/\bcodex\b/.test(recent)) return "codex";
  if (/\bclaude\b/.test(recent)) return "claude";
  return null;
}

function truncateText(s: string, max = 68): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 3))}...`;
}

function appendPtyInputHistory(ptyId: string, input: string, ts: number): void {
  const text = truncateText(input, 220);
  const prev = ptyInputHistory.get(ptyId) ?? [];
  if (prev.length > 0 && prev[prev.length - 1].text === text) return;
  const next = [...prev, { text, ts }];
  if (next.length > MAX_INPUT_HISTORY) next.splice(0, next.length - MAX_INPUT_HISTORY);
  ptyInputHistory.set(ptyId, next);
}

function ptySummaryById(ptyId: string): PtySummary | null {
  return ptys.find((p) => p.id === ptyId) ?? null;
}

function attachedAgentSessionForPty(ptyId: string): { provider: string; providerSessionId: string } | null {
  const summary = ptySummaryById(ptyId);
  const provider = summary?.agentProvider?.trim() ?? "";
  const providerSessionId = summary?.agentProviderSessionId?.trim() ?? "";
  if (!provider || !providerSessionId) return null;
  return { provider, providerSessionId };
}

function resolvedAgentSessionNameForPty(ptyId: string): string | null {
  const sessionRef = attachedAgentSessionForPty(ptyId);
  if (!sessionRef) return null;
  const match = agentSessions.find(
    (session) => session.provider === sessionRef.provider && session.providerSessionId === sessionRef.providerSessionId,
  );
  const name = compactWhitespace(match?.name ?? "");
  return name || null;
}

function displayRunningPtyName(pty: PtySummary): string {
  return resolvedAgentSessionNameForPty(pty.id) ?? displaySessionName(pty);
}

function clearProviderHistoryRefreshTimer(ptyId: string): void {
  const timer = ptyProviderHistoryRefreshTimers.get(ptyId);
  if (timer == null) return;
  clearTimeout(timer);
  ptyProviderHistoryRefreshTimers.delete(ptyId);
}

async function loadProviderHistoryForPty(ptyId: string, force = false): Promise<void> {
  const sessionRef = attachedAgentSessionForPty(ptyId);
  if (!sessionRef) {
    ptyProviderInputHistory.delete(ptyId);
    ptyProviderHistoryKeys.delete(ptyId);
    ptyProviderHistoryLoading.delete(ptyId);
    if (activePtyId === ptyId) renderInputContextBar();
    return;
  }

  const key = `${sessionRef.provider}:${sessionRef.providerSessionId}`;
  if (!force && ptyProviderHistoryKeys.get(ptyId) === key && (ptyProviderHistoryLoading.has(ptyId) || ptyProviderInputHistory.has(ptyId))) {
    return;
  }

  ptyProviderHistoryKeys.set(ptyId, key);
  ptyProviderHistoryLoading.add(ptyId);
  try {
    const res = await authFetch(
      `/api/agent-sessions/${encodeURIComponent(sessionRef.provider)}/${encodeURIComponent(sessionRef.providerSessionId)}/conversation`,
      { cache: "no-store" },
    );
    if (!res.ok) {
      if (ptyProviderHistoryKeys.get(ptyId) === key) {
        ptyProviderInputHistory.delete(ptyId);
      }
      return;
    }
    const json = (await res.json()) as { messages?: Array<{ role?: string; text?: string; ts?: number | null }> };
    if (ptyProviderHistoryKeys.get(ptyId) !== key) return;
    const messages = Array.isArray(json.messages) ? json.messages : [];
    const history = messages
      .filter((message) => message?.role === "user" && typeof message.text === "string" && message.text.trim().length > 0)
      .map((message) => ({
        text: truncateText(message.text!.trim(), 220),
        ts: typeof message.ts === "number" && message.ts > 0 ? message.ts : 0,
      }))
      .slice(-MAX_INPUT_HISTORY);
    ptyProviderInputHistory.set(ptyId, history);
  } catch {
    if (ptyProviderHistoryKeys.get(ptyId) === key) {
      ptyProviderInputHistory.delete(ptyId);
    }
  } finally {
    if (ptyProviderHistoryKeys.get(ptyId) === key) {
      ptyProviderHistoryLoading.delete(ptyId);
      if (activePtyId === ptyId) renderInputContextBar();
    }
  }
}

function scheduleProviderHistoryRefresh(ptyId: string, delayMs = 1200, force = true): void {
  if (!attachedAgentSessionForPty(ptyId)) return;
  clearProviderHistoryRefreshTimer(ptyId);
  const timer = window.setTimeout(() => {
    ptyProviderHistoryRefreshTimers.delete(ptyId);
    void loadProviderHistoryForPty(ptyId, force);
  }, delayMs);
  ptyProviderHistoryRefreshTimers.set(ptyId, timer);
}

function syncProviderHistoryStateWithPtys(): void {
  const activeSessionRef = activePtyId ? attachedAgentSessionForPty(activePtyId) : null;
  for (const ptyId of [...ptyProviderHistoryKeys.keys()]) {
    if (ptySummaryById(ptyId)) continue;
    ptyProviderHistoryKeys.delete(ptyId);
    ptyProviderInputHistory.delete(ptyId);
    ptyProviderHistoryLoading.delete(ptyId);
    clearProviderHistoryRefreshTimer(ptyId);
  }
  if (!activePtyId) return;
  if (!activeSessionRef) {
    ptyProviderInputHistory.delete(activePtyId);
    ptyProviderHistoryKeys.delete(activePtyId);
    ptyProviderHistoryLoading.delete(activePtyId);
    clearProviderHistoryRefreshTimer(activePtyId);
    return;
  }
  const key = `${activeSessionRef.provider}:${activeSessionRef.providerSessionId}`;
  if (ptyProviderHistoryKeys.get(activePtyId) === key && ptyProviderInputHistory.has(activePtyId)) return;
  ptyProviderInputHistory.delete(activePtyId);
  void loadProviderHistoryForPty(activePtyId);
}

function renderInputContextBar(): void {
  if (!activePtyId) {
    sessionContextBarEl.classList.add("hidden");
    inputContextEl.classList.add("hidden");
    inputContextLastEl.textContent = "(none yet)";
    btnBranchReview.disabled = true;
    btnBranchReview.setAttribute("aria-busy", "false");
    btnMagit.disabled = true;
    btnMagit.setAttribute("aria-busy", "false");
    inputHistoryLabelEl.textContent = "History (0)";
    inputContextToggleEl.setAttribute("aria-expanded", "false");
    inputHistoryListEl.classList.add("hidden");
    inputHistoryListEl.textContent = "";
    return;
  }

  sessionContextBarEl.classList.remove("hidden");
  inputContextEl.classList.remove("hidden");

  const providerHistory = ptyProviderInputHistory.get(activePtyId) ?? [];
  const history = providerHistory.length > 0 ? providerHistory : (ptyInputHistory.get(activePtyId) ?? []);
  const lastEntry = history.length > 0 ? history[history.length - 1] : null;
  const latest = providerHistory.length > 0
    ? (lastEntry?.text ?? "(none yet)")
    : (ptyLastInput.get(activePtyId) ?? lastEntry?.text ?? "(none yet)");
  inputContextLastEl.textContent = latest;
  inputContextLastEl.title = latest;

  inputContextLastEl.classList.remove("clickable");
  inputContextLastEl.onclick = null;

  btnBranchReview.disabled = branchReviewOpening;
  btnBranchReview.setAttribute("aria-busy", branchReviewOpening ? "true" : "false");
  btnMagit.disabled = magitOpening;
  btnMagit.setAttribute("aria-busy", magitOpening ? "true" : "false");
  inputHistoryLabelEl.textContent = `History (${history.length})`;
  inputContextToggleEl.setAttribute("aria-expanded", inputHistoryExpanded ? "true" : "false");

  if (!inputHistoryExpanded) {
    inputHistoryListEl.classList.add("hidden");
    return;
  }

  inputHistoryListEl.textContent = "";
  if (history.length === 0) {
    const li = document.createElement("li");
    li.textContent = ptyProviderHistoryLoading.has(activePtyId) ? "Loading session history..." : "No inputs yet";
    inputHistoryListEl.appendChild(li);
  } else {
    for (let i = 0; i < history.length; i++) {
      const entry = history[i];
      const li = document.createElement("li");
      li.textContent = entry.text;
      li.classList.add("clickable");
      li.title = `${entry.text}\n(click to scroll the terminal here)`;
      li.onclick = () => scrollActiveTerminalToHistory(entry);
      inputHistoryListEl.appendChild(li);
    }
  }
  inputHistoryListEl.classList.remove("hidden");
}

type PrCommentThreadView = {
  threadId: number;
  resolved: boolean;
  status: string;
  file: string | null;
  line: number | null;
  comments: { author: string; text: string; at: number }[];
};

let prCommentsExpanded = false;
let prCommentsForPty: string | null = null;
let prCommentsLoading = false;
let prCommentsError: string | null = null;
let prCommentsData: PrCommentThreadView[] | null = null;

function resetPrComments(): void {
  prCommentsExpanded = false;
  prCommentsForPty = null;
  prCommentsLoading = false;
  prCommentsError = null;
  prCommentsData = null;
}

async function loadPrComments(ptyId: string): Promise<void> {
  prCommentsLoading = true;
  prCommentsError = null;
  prCommentsData = null;
  prCommentsForPty = ptyId;
  renderPrContextBar();
  try {
    const res = await authFetch(`/api/azure-pr/threads?ptyId=${encodeURIComponent(ptyId)}`);
    if (!res.ok) throw new Error(await readApiError(res));
    const body = (await res.json()) as { threads?: PrCommentThreadView[] };
    if (prCommentsForPty !== ptyId) return; // active session changed while loading
    prCommentsData = body.threads ?? [];
  } catch (err) {
    if (prCommentsForPty !== ptyId) return;
    prCommentsError = err instanceof Error ? err.message : String(err);
  } finally {
    if (prCommentsForPty === ptyId) {
      prCommentsLoading = false;
      renderPrContextBar();
    }
  }
}

function togglePrComments(): void {
  if (!activePtyId) return;
  prCommentsExpanded = !prCommentsExpanded;
  if (prCommentsExpanded && prCommentsForPty !== activePtyId) {
    void loadPrComments(activePtyId);
  } else {
    renderPrContextBar();
  }
}

function renderPrContextBar(): void {
  const summary = activePtyId ? ptys.find((p) => p.id === activePtyId) : null;
  const pr = summary?.pr ?? null;
  if (!pr) {
    if (prCommentsForPty) resetPrComments();
    prContextEl.classList.add("hidden");
    prContextEl.textContent = "";
    return;
  }
  // Collapse if cached comments belong to a different session.
  if (prCommentsForPty && prCommentsForPty !== activePtyId) resetPrComments();

  prContextEl.classList.remove("hidden");
  prContextEl.textContent = "";

  const row = document.createElement("div");
  row.className = "pr-bar-row";
  row.title = "Show review comments";
  row.onclick = () => togglePrComments();

  const chevron = document.createElement("span");
  chevron.className = "pr-chevron";
  chevron.textContent = prCommentsExpanded ? "▾" : "▸";

  const link = document.createElement("a");
  link.className = "pr-link";
  link.href = pr.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = `PR #${pr.id}`;
  link.title = `Open PR #${pr.id} (Files tab): ${pr.title}`;
  link.onclick = (ev) => ev.stopPropagation();

  const title = document.createElement("span");
  title.className = "pr-title";
  title.textContent = pr.title;
  title.title = pr.title;

  const unresolved = document.createElement("span");
  unresolved.className = `pr-count unresolved${pr.unresolvedCount > 0 ? " has" : ""}`;
  unresolved.textContent = `● ${pr.unresolvedCount} unresolved`;

  const resolved = document.createElement("span");
  resolved.className = "pr-count resolved";
  resolved.textContent = `✓ ${pr.resolvedCount} resolved`;

  row.append(chevron, link, title, unresolved, resolved);

  const approvals = pr.votes.filter((v) => v.vote === "approved" || v.vote === "approvedWithSuggestions").length;
  const rejections = pr.votes.filter((v) => v.vote === "rejected" || v.vote === "waitingForAuthor").length;
  if (approvals > 0 || rejections > 0) {
    const votes = document.createElement("span");
    votes.className = "pr-votes";
    votes.textContent = [approvals > 0 ? `✔ ${approvals}` : "", rejections > 0 ? `✖ ${rejections}` : ""].filter(Boolean).join("  ");
    votes.title = "Reviewer votes (approved / rejected-or-waiting)";
    row.append(votes);
  }

  prContextEl.append(row);

  if (!prCommentsExpanded) return;

  const panel = document.createElement("div");
  panel.className = "pr-comments";
  if (prCommentsLoading) {
    panel.textContent = "Loading comments…";
  } else if (prCommentsError) {
    panel.textContent = `Failed to load comments: ${prCommentsError}`;
  } else if (!prCommentsData || prCommentsData.length === 0) {
    panel.textContent = "No review comments.";
  } else {
    for (const t of prCommentsData) {
      const thread = document.createElement("div");
      thread.className = `pr-thread${t.resolved ? " resolved" : ""}`;

      const loc = document.createElement("div");
      loc.className = "pr-thread-loc";
      const where = t.file ? `${t.file}${t.line ? `:${t.line}` : ""}` : "PR-level";
      loc.textContent = `${where} · ${t.resolved ? "resolved" : t.status}`;
      thread.append(loc);

      for (const c of t.comments) {
        const cm = document.createElement("div");
        cm.className = "pr-comment";
        const who = document.createElement("span");
        who.className = "pr-comment-author";
        who.textContent = c.author;
        const text = document.createElement("span");
        text.className = "pr-comment-text";
        text.textContent = c.text;
        cm.append(who, text);
        thread.append(cm);
      }
      panel.append(thread);
    }
  }
  prContextEl.append(panel);
}

function unquoteToken(s: string): string {
  if (s.length >= 2 && ((s.startsWith(`"`) && s.endsWith(`"`)) || (s.startsWith(`'`) && s.endsWith(`'`)))) {
    return s.slice(1, -1);
  }
  return s;
}

function inferProcessFromInput(line: string): string | null {
  const tokens = line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  if (!tokens.length) return null;

  const wrappers = new Set(["sudo", "env", "nohup", "time", "command"]);
  let i = 0;
  while (i < tokens.length) {
    const raw = unquoteToken(tokens[i]).trim();
    if (!raw) {
      i++;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(raw)) {
      i++;
      continue;
    }
    if (wrappers.has(raw) || raw === "--") {
      i++;
      continue;
    }
    let token = raw.replace(/^[({]+/, "").replace(/[;|&)}]+$/, "");
    if (!token) return null;
    if (token.includes("/")) token = token.split("/").filter(Boolean).at(-1) ?? token;
    if (!token) return null;
    return token;
  }
  return null;
}

function maybeUpdateClientCwdFromCommand(ptyId: string, command: string): void {
  const trimmed = command.trim();
  if (!trimmed) return;
  const m = /^cd\s+(.+)$/.exec(trimmed);
  if (!m) return;
  let target = (m[1] ?? "").trim();
  if (!target) return;
  if ((target.startsWith("\"") && target.endsWith("\"")) || (target.startsWith("'") && target.endsWith("'"))) {
    target = target.slice(1, -1).trim();
  }
  if (!target.startsWith("/")) return;
  const p = ptys.find((x) => x.id === ptyId);
  if (!p) return;
  p.cwd = target;
}

function trackUserInput(ptyId: string, data: string): void {
  const cleaned = data
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b./g, "");

  let line = ptyInputLineBuffers.get(ptyId) ?? "";
  let changed = false;
  for (const ch of cleaned) {
    if (ch === "\r" || ch === "\n") {
      const normalized = compactWhitespace(line);
      if (normalized) {
        ptyLastInput.set(ptyId, truncateText(normalized));
        appendPtyInputHistory(ptyId, normalized, Date.now());
        maybeUpdateClientCwdFromCommand(ptyId, normalized);
        const proc = inferProcessFromInput(normalized);
        if (proc) ptyInputProcessHints.set(ptyId, proc);
        changed = true;
      }
      line = "";
      continue;
    }
    if (ch === "\u007f" || ch === "\b") {
      line = line.slice(0, -1);
      continue;
    }
    if (ch === "\u0015") {
      line = "";
      continue;
    }
    if (ch < " ") continue;
    line += ch;
    if (line.length > 512) line = line.slice(-512);
  }
  ptyInputLineBuffers.set(ptyId, line);
  if (changed) {
    scheduleProviderHistoryRefresh(ptyId);
    savePtyInputMeta(ptyId);
    renderList();
    renderInputContextBar();
  }
}

async function killPtyDirect(ptyId: string): Promise<void> {
  const res = await authFetch(`/api/ptys/${encodeURIComponent(ptyId)}/kill`, { method: "POST" });
  if (!res.ok) {
    addEvent(`Failed to kill PTY ${ptyId}: ${await readApiError(res)}`);
    return;
  }
  addEvent(`Killed PTY ${ptyId}`);

  if (activePtyId === ptyId) {
    activePtyId = null;
    saveActivePty(null);
  }
  removeTerm(ptyId);
  updateTerminalVisibility();

  await refreshList({ forceAgentSessions: true });
}

async function renamePty(ptyId: string): Promise<void> {
  const pty = ptys.find((item) => item.id === ptyId);
  if (!pty) {
    addEvent(`Failed to rename PTY ${ptyId}: unknown session`);
    return;
  }

  const currentName = displayRunningPtyName(pty);
  const exampleName = BOT_NAMES.find((candidate) => candidate !== currentName) ?? BOT_NAMES[0] ?? "Ada";
  const proposedName = window.prompt(`Name this session. Example: ${exampleName}`, currentName);
  if (proposedName == null) return;

  const nextName = proposedName.trim();
  if (!nextName || nextName === currentName) return;
  if (nextName.length > 40) {
    addEvent(`Failed to rename PTY ${ptyId}: name must be 40 characters or fewer`);
    return;
  }

  const res = await authFetch(`/api/ptys/${encodeURIComponent(ptyId)}/name`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: nextName }),
  });
  if (!res.ok) {
    addEvent(`Failed to rename PTY ${ptyId}: ${await readApiError(res)}`);
    return;
  }

  ptys = ptys.map((item) => item.id === ptyId ? { ...item, name: nextName } : item);
  renderList();
  void refreshList({ forceAgentSessions: true });
}

function killPty(ptyId: string): void {
  const p = ptys.find((x) => x.id === ptyId);
  if (!p) {
    void killPtyDirect(ptyId);
    return;
  }

  const wt = ptyWorktreeLabel(p);
  if (!wt) {
    void killPtyDirect(ptyId);
    return;
  }

  if (isMainWorktreeForCwd(p.cwd, knownWorktrees, serverRepoRoot)) {
    void killPtyDirect(ptyId);
    return;
  }

  // Check if there are other running PTYs in the same worktree
  const sameWorktree = ptys.filter(
    (x) => x.id !== ptyId && x.status === "running" && ptyWorktreeLabel(x) === wt,
  );
  if (sameWorktree.length > 0) {
    void killPtyDirect(ptyId);
    return;
  }

  // Last PTY in worktree: show the close modal
  openCloseWorktreeModal(ptyId);
}

type RestoreAgentTarget = {
  target?: "same_cwd" | "worktree" | "new_worktree";
  worktreePath?: string;
  branch?: string;
  cwd?: string;
};

async function restoreAgentSession(agentSessionId: string, target?: RestoreAgentTarget): Promise<boolean> {
  const session = agentSessions.find((x) => x.id === agentSessionId);
  if (!session) {
    addEvent(`Failed to restore agent session ${agentSessionId}: unknown session`);
    return false;
  }
  const reqInit: RequestInit = { method: "POST" };
  if (target && Object.keys(target).length > 0) {
    reqInit.headers = { "Content-Type": "application/json" };
    reqInit.body = JSON.stringify(target);
  }
  const res = await authFetch(
    `/api/agent-sessions/${encodeURIComponent(session.provider)}/${encodeURIComponent(session.providerSessionId)}/restore`,
    reqInit,
  );
  if (!res.ok) {
    addEvent(`Failed to restore agent session ${agentSessionId}: ${await readApiError(res)}`);
    return false;
  }
  const json = (await res.json()) as { id: string };
  addEvent(`Restored agent session ${agentSessionId}`);
  await refreshWorktreeCache();
  await refreshList({ forceAgentSessions: true });
  if (mobileViewport) {
    mobileView = "session";
    saveMobileView();
    mobilePreviewState = null;
    mobileTerminalSnapshot = null;
    mobileTerminalSnapshotPendingRequestId = null;
    saveMobileSnapshotPtyId(null);
  }
  setActive(json.id);
  return true;
}

function shortSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (trimmed.length <= 14) return trimmed;
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`;
}

function capitalizeWord(s: string): string {
  if (!s) return s;
  return `${s[0].toUpperCase()}${s.slice(1)}`;
}

function lastPathSegment(pathValue: string | null): string {
  if (!pathValue) return "";
  return pathValue.split("/").filter(Boolean).at(-1) ?? "";
}

function displaySessionIntent(session: AgentSessionSummary): string | null {
  const raw = compactWhitespace(session.name);
  if (!raw) return null;
  const projectLeaf = lastPathSegment(session.projectRoot);
  const generic = new Set(
    [
      session.provider,
      `${session.provider}:${projectLeaf}`,
      `${session.provider}:${session.worktree ?? ""}`,
    ].map((v) => v.toLowerCase()),
  );
  return generic.has(raw.toLowerCase()) ? null : raw;
}

function displaySessionCommand(session: AgentSessionSummary): string {
  const args = session.args.filter((arg) => arg && arg !== session.providerSessionId);
  if (args.length > 0 && (args[0] === "resume" || args[0] === "--resume")) {
    return `resume ${shortSessionId(session.providerSessionId)}`;
  }
  if (session.command && args.length > 0) return truncateText(`${session.command} ${args.join(" ")}`, 56);
  if (session.command) return truncateText(session.command, 56);
  return `resume ${shortSessionId(session.providerSessionId)}`;
}

function displaySessionTitle(session: AgentSessionSummary): string {
  const intent = displaySessionIntent(session);
  if (intent) return intent;
  return `${capitalizeWord(session.provider)} session`;
}

function displaySessionSubtitle(session: AgentSessionSummary): string {
  const parts: string[] = [];
  parts.push(displaySessionCommand(session));
  if (session.worktree) {
    parts.push(`branch:${session.worktree}`);
  }
  parts.push(`${session.provider}:${shortSessionId(session.providerSessionId)}`);
  return parts.join(" · ");
}

function inactiveSessionProject(session: AgentSessionSummary): string | null {
  const root = session.projectRoot ?? (session.cwd ? normalizeCwdGroupKey(session.cwd) : null);
  const leaf = lastPathSegment(root);
  return leaf || null;
}

function displayInactiveSessionTitle(session: AgentSessionSummary): string {
  const project = inactiveSessionProject(session);
  if (project) return project;
  return `${capitalizeWord(session.provider)} session`;
}

function displayInactiveSessionSubtitle(session: AgentSessionSummary): string {
  if (session.worktree) return `branch:${session.worktree}`;
  const project = inactiveSessionProject(session);
  if (project) return `project:${project}`;
  return capitalizeWord(session.provider);
}

// ---------------------------------------------------------------------------
// Reactivate Project Modal
// ---------------------------------------------------------------------------

type ReactivateProjectModalState = {
  groupKey: string;
  selectedSessionId: string;
  target: RestoreTargetChoice;
  selectedWorktreePath: string;
  customCwdValue: string;
  newBranchValue: string;
  worktreeOptions: Array<{ value: string; label: string }>;
  previewMessages: SessionPreviewMessage[];
  previewLoading: boolean;
  restoring: boolean;
};

const reactivateProjectModalRoot = document.createElement("div");
document.body.appendChild(reactivateProjectModalRoot);
let reactivateProjectModalState: ReactivateProjectModalState | null = null;
let reactivateProjectModalSeq = 0;
let reactivateProjectPreviewSeq = 0;

function closeReactivateProjectModal(): void {
  reactivateProjectModalState = null;
  renderReactivateProjectModal(reactivateProjectModalRoot, null, {
    onClose: () => {},
    onSelectSession: () => {},
    onTargetChange: () => {},
    onWorktreeChange: () => {},
    onCustomCwdChange: () => {},
    onNewBranchChange: () => {},
    onHideSession: () => {},
    onRestore: () => {},
  });
}

function applyReactivateProjectSessionDefaults(state: ReactivateProjectModalState, session: AgentSessionSummary): void {
  const matchedWt = session.worktree
    ? knownWorktrees.find((w) => (w.branch || w.name) === session.worktree)
    : null;
  const suggestedWorktreePath = matchedWt?.path ?? "";
  const worktreeAvailable = state.worktreeOptions.some((wt) => wt.value === suggestedWorktreePath);
  state.target = worktreeAvailable ? "worktree" : "same_cwd";
  state.selectedWorktreePath = worktreeAvailable
    ? suggestedWorktreePath
    : (state.worktreeOptions[0]?.value ?? "");
  state.customCwdValue = session.cwd ?? session.projectRoot ?? state.groupKey;
  state.newBranchValue = session.worktree ?? `restore-${Date.now()}`;
}

function loadReactivateProjectPreview(agentSessionId: string): void {
  const session = agentSessions.find((x) => x.id === agentSessionId);
  if (!session || !reactivateProjectModalState) return;
  const previewSeq = ++reactivateProjectPreviewSeq;
  reactivateProjectModalState.previewLoading = true;
  reactivateProjectModalState.previewMessages = [];
  renderReactivateProjectModalState();
  void authFetch(`/api/agent-sessions/${encodeURIComponent(session.provider)}/${encodeURIComponent(session.providerSessionId)}/conversation`)
    .then(async (res) => (res.ok ? res.json() : Promise.reject(new Error(await readApiError(res)))))
    .then((data: { messages?: SessionPreviewMessage[] }) => {
      if (!reactivateProjectModalState || previewSeq !== reactivateProjectPreviewSeq) return;
      if (reactivateProjectModalState.selectedSessionId !== agentSessionId) return;
      const messages = Array.isArray(data.messages) ? data.messages : [];
      reactivateProjectModalState.previewMessages = messages.slice(-6);
      reactivateProjectModalState.previewLoading = false;
      renderReactivateProjectModalState();
    })
    .catch(() => {
      if (!reactivateProjectModalState || previewSeq !== reactivateProjectPreviewSeq) return;
      if (reactivateProjectModalState.selectedSessionId !== agentSessionId) return;
      reactivateProjectModalState.previewMessages = [];
      reactivateProjectModalState.previewLoading = false;
      renderReactivateProjectModalState();
    });
}

function renderReactivateProjectModalState(): void {
  const state = reactivateProjectModalState;
  if (!state) {
    closeReactivateProjectModal();
    return;
  }
  const sessions = getInactiveSessionsForProject(state.groupKey);
  if (sessions.length === 0) {
    closeReactivateProjectModal();
    renderList();
    return;
  }
  const selectedSession = sessions.find((session) => session.id === state.selectedSessionId) ?? sessions[0];
  if (selectedSession.id !== state.selectedSessionId) {
    state.selectedSessionId = selectedSession.id;
    applyReactivateProjectSessionDefaults(state, selectedSession);
    loadReactivateProjectPreview(selectedSession.id);
  }

  const model: ReactivateProjectModalViewModel = {
    projectLabel: lastPathSegment(state.groupKey) || "(unknown project)",
    projectPath: state.groupKey || undefined,
    sessions: sessions.map((session) => ({
      id: session.id,
      title: displaySessionTitle(session),
      subtitle: displaySessionSubtitle(session),
      provider: capitalizeWord(session.provider),
      providerSessionId: session.providerSessionId,
      elapsed: formatElapsedTime(session.lastSeenAt) || undefined,
      worktree: session.worktree ?? undefined,
      firstInput: displaySessionIntent(session),
      exitLabel: session.lastRestoredAt ? "restored before" : "available",
    })),
    selectedSessionId: state.selectedSessionId,
    previewMessages: state.previewMessages,
    previewLoading: state.previewLoading,
    target: state.target,
    sameCwdLabel: selectedSession.cwd
      ? `Use last known location (${selectedSession.cwd})`
      : "Use last known location",
    worktreeOptions: state.worktreeOptions,
    selectedWorktreePath: state.selectedWorktreePath,
    customCwdValue: state.customCwdValue,
    newBranchValue: state.newBranchValue,
    restoring: state.restoring,
  };

  renderReactivateProjectModal(reactivateProjectModalRoot, model, {
    onClose: () => {
      closeReactivateProjectModal();
    },
    onSelectSession: (sessionId) => {
      if (!reactivateProjectModalState || reactivateProjectModalState.restoring) return;
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) return;
      reactivateProjectModalState.selectedSessionId = sessionId;
      applyReactivateProjectSessionDefaults(reactivateProjectModalState, session);
      renderReactivateProjectModalState();
      loadReactivateProjectPreview(sessionId);
    },
    onTargetChange: (target) => {
      if (!reactivateProjectModalState) return;
      reactivateProjectModalState.target = target;
      renderReactivateProjectModalState();
    },
    onWorktreeChange: (pathValue) => {
      if (!reactivateProjectModalState) return;
      reactivateProjectModalState.selectedWorktreePath = pathValue;
      renderReactivateProjectModalState();
    },
    onCustomCwdChange: (cwdValue) => {
      if (!reactivateProjectModalState) return;
      reactivateProjectModalState.customCwdValue = cwdValue;
      renderReactivateProjectModalState();
    },
    onNewBranchChange: (branchValue) => {
      if (!reactivateProjectModalState) return;
      reactivateProjectModalState.newBranchValue = branchValue;
      renderReactivateProjectModalState();
    },
    onHideSession: () => {
      if (!reactivateProjectModalState || reactivateProjectModalState.restoring) return;
      hiddenAgentSessionIds.add(reactivateProjectModalState.selectedSessionId);
      saveHiddenAgentSessions();
      reactivateProjectModalState.previewMessages = [];
      reactivateProjectModalState.previewLoading = false;
      renderList();
      renderReactivateProjectModalState();
    },
    onRestore: () => {
      if (!reactivateProjectModalState || reactivateProjectModalState.restoring) return;
      const stateNow = reactivateProjectModalState;
      let target: RestoreAgentTarget = { target: "same_cwd" };
      if (stateNow.target === "worktree") {
        if (!stateNow.selectedWorktreePath) return;
        target = { target: "worktree", worktreePath: stateNow.selectedWorktreePath };
      } else if (stateNow.target === "new_worktree") {
        target = { target: "new_worktree", branch: stateNow.newBranchValue.trim() || `restore-${Date.now()}` };
      } else if (stateNow.target === "custom_cwd") {
        if (!stateNow.customCwdValue.trim()) return;
        target = { target: "same_cwd", cwd: stateNow.customCwdValue.trim() };
      }

      stateNow.restoring = true;
      renderReactivateProjectModalState();
      void restoreAgentSession(stateNow.selectedSessionId, target).then((ok) => {
        if (!reactivateProjectModalState || reactivateProjectModalState.selectedSessionId !== stateNow.selectedSessionId) return;
        if (ok) {
          closeReactivateProjectModal();
          return;
        }
        reactivateProjectModalState.restoring = false;
        renderReactivateProjectModalState();
      });
    },
  });
}

function openReactivateProjectModal(groupKey: string): void {
  const sessions = getInactiveSessionsForProject(groupKey);
  if (sessions.length === 0) return;
  const selectedSession = sessions[0];
  const seq = ++reactivateProjectModalSeq;
  reactivateProjectModalState = {
    groupKey,
    selectedSessionId: selectedSession.id,
    target: "same_cwd",
    selectedWorktreePath: "",
    customCwdValue: selectedSession.cwd ?? selectedSession.projectRoot ?? groupKey,
    newBranchValue: selectedSession.worktree ?? `restore-${Date.now()}`,
    worktreeOptions: [],
    previewMessages: [],
    previewLoading: true,
    restoring: false,
  };
  renderReactivateProjectModalState();
  loadReactivateProjectPreview(selectedSession.id);

  void authFetch("/api/worktrees")
    .then(async (res) => (res.ok ? res.json() : Promise.reject(new Error(await readApiError(res)))))
    .then((data: { worktrees?: Array<{ name: string; path: string }> }) => {
      if (!reactivateProjectModalState || seq !== reactivateProjectModalSeq) return;
      reactivateProjectModalState.worktreeOptions = buildRestoreWorktreeOptions(selectedSession, data.worktrees);
      applyReactivateProjectSessionDefaults(reactivateProjectModalState, sessions.find((session) => session.id === reactivateProjectModalState!.selectedSessionId) ?? selectedSession);
      renderReactivateProjectModalState();
    })
    .catch(() => {
      if (!reactivateProjectModalState || seq !== reactivateProjectModalSeq) return;
      reactivateProjectModalState.worktreeOptions = [];
      if (reactivateProjectModalState.target === "worktree") reactivateProjectModalState.target = "same_cwd";
      renderReactivateProjectModalState();
    });
}

// ---------------------------------------------------------------------------
// Session Preview Modal
// ---------------------------------------------------------------------------

type SessionPreviewModalState = {
  agentSessionId: string;
  provider: string;
  providerSessionId: string;
  title: string;
  messages: SessionPreviewMessage[];
  loading: boolean;
};

const sessionPreviewModalRoot = document.createElement("div");
document.body.appendChild(sessionPreviewModalRoot);
let sessionPreviewModalState: SessionPreviewModalState | null = null;
let sessionPreviewModalSeq = 0;

function closeSessionPreviewModal(): void {
  sessionPreviewModalState = null;
  renderSessionPreviewModal(sessionPreviewModalRoot, null, {
    onClose: () => {},
    onRestore: () => {},
  });
}

function renderSessionPreviewModalState(): void {
  const state = sessionPreviewModalState;
  if (!state) {
    closeSessionPreviewModal();
    return;
  }
  const model: SessionPreviewModalViewModel = {
    sessionTitle: state.title,
    provider: state.provider,
    providerSessionId: state.providerSessionId,
    messages: state.messages,
    loading: state.loading,
  };
  renderSessionPreviewModal(sessionPreviewModalRoot, model, {
    onClose: () => closeSessionPreviewModal(),
    onRestore: () => {
      const agentSessionId = state.agentSessionId;
      closeSessionPreviewModal();
      openAgentSessionActions(agentSessionId);
    },
  });
}

function openSessionPreviewModal(agentSessionId: string): void {
  const session = agentSessions.find((x) => x.id === agentSessionId);
  if (!session) return;
  const seq = ++sessionPreviewModalSeq;
  sessionPreviewModalState = {
    agentSessionId,
    provider: session.provider,
    providerSessionId: session.providerSessionId,
    title: displaySessionTitle(session),
    messages: [],
    loading: true,
  };
  renderSessionPreviewModalState();

  void authFetch(
    `/api/agent-sessions/${encodeURIComponent(session.provider)}/${encodeURIComponent(session.providerSessionId)}/conversation`,
  )
    .then(async (res) => (res.ok ? res.json() : Promise.reject(new Error(await readApiError(res)))))
    .then((data: { messages?: SessionPreviewMessage[] }) => {
      if (!sessionPreviewModalState || seq !== sessionPreviewModalSeq) return;
      sessionPreviewModalState.messages = Array.isArray(data.messages) ? data.messages : [];
      sessionPreviewModalState.loading = false;
      renderSessionPreviewModalState();
    })
    .catch(() => {
      if (!sessionPreviewModalState || seq !== sessionPreviewModalSeq) return;
      sessionPreviewModalState.messages = [];
      sessionPreviewModalState.loading = false;
      renderSessionPreviewModalState();
    });
}

// ---------------------------------------------------------------------------
// Restore Session Modal
// ---------------------------------------------------------------------------

type RestoreSessionModalState = {
  agentSessionId: string;
  target: RestoreTargetChoice;
  selectedWorktreePath: string;
  customCwdValue: string;
  newBranchValue: string;
  worktreeOptions: Array<{ value: string; label: string }>;
  restoring: boolean;
};

const restoreSessionModalRoot = document.createElement("div");
document.body.appendChild(restoreSessionModalRoot);
let restoreSessionModalState: RestoreSessionModalState | null = null;
let restoreSessionModalSeq = 0;

function closeRestoreSessionModal(): void {
  restoreSessionModalState = null;
  renderRestoreSessionModal(restoreSessionModalRoot, null, {
    onClose: () => {},
    onTargetChange: () => {},
    onWorktreeChange: () => {},
    onCustomCwdChange: () => {},
    onNewBranchChange: () => {},
    onHide: () => {},
    onRestore: () => {},
  });
}

function buildRestoreWorktreeOptions(
  _session: AgentSessionSummary,
  worktrees?: Array<{ name: string; path: string }>,
): Array<{ value: string; label: string }> {
  if (!Array.isArray(worktrees)) return [];
  return worktrees
    .filter((wt) => wt && typeof wt.path === "string" && typeof wt.name === "string")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((wt) => ({ value: wt.path, label: wt.name }));
}

function renderRestoreSessionModalState(): void {
  const state = restoreSessionModalState;
  if (!state) {
    closeRestoreSessionModal();
    return;
  }
  const session = agentSessions.find((x) => x.id === state.agentSessionId);
  if (!session) {
    closeRestoreSessionModal();
    return;
  }
  const model: RestoreSessionModalViewModel = {
    sessionTitle: displaySessionTitle(session),
    sessionSubtitle: displaySessionSubtitle(session),
    provider: session.provider,
    providerSessionId: session.providerSessionId,
    target: state.target,
    sameCwdLabel: session.cwd ? `Use last known location (${session.cwd})` : "Use last known location",
    worktreeOptions: state.worktreeOptions,
    selectedWorktreePath: state.selectedWorktreePath,
    customCwdValue: state.customCwdValue,
    newBranchValue: state.newBranchValue,
    restoring: state.restoring,
  };

  renderRestoreSessionModal(restoreSessionModalRoot, model, {
    onClose: () => {
      closeRestoreSessionModal();
    },
    onTargetChange: (target) => {
      if (!restoreSessionModalState) return;
      restoreSessionModalState.target = target;
      renderRestoreSessionModalState();
    },
    onWorktreeChange: (pathValue) => {
      if (!restoreSessionModalState) return;
      restoreSessionModalState.selectedWorktreePath = pathValue;
      renderRestoreSessionModalState();
    },
    onCustomCwdChange: (cwdValue) => {
      if (!restoreSessionModalState) return;
      restoreSessionModalState.customCwdValue = cwdValue;
      renderRestoreSessionModalState();
    },
    onNewBranchChange: (branchValue) => {
      if (!restoreSessionModalState) return;
      restoreSessionModalState.newBranchValue = branchValue;
      renderRestoreSessionModalState();
    },
    onHide: () => {
      if (!restoreSessionModalState) return;
      hiddenAgentSessionIds.add(restoreSessionModalState.agentSessionId);
      saveHiddenAgentSessions();
      closeRestoreSessionModal();
      renderList();
    },
    onRestore: () => {
      if (!restoreSessionModalState || restoreSessionModalState.restoring) return;
      const stateNow = restoreSessionModalState;
      let target: RestoreAgentTarget = { target: "same_cwd" };
      if (stateNow.target === "worktree") {
        if (!stateNow.selectedWorktreePath) return;
        target = { target: "worktree", worktreePath: stateNow.selectedWorktreePath };
      } else if (stateNow.target === "new_worktree") {
        target = { target: "new_worktree", branch: stateNow.newBranchValue.trim() || `restore-${Date.now()}` };
      } else if (stateNow.target === "custom_cwd") {
        if (!stateNow.customCwdValue.trim()) return;
        target = { target: "same_cwd", cwd: stateNow.customCwdValue.trim() };
      }

      stateNow.restoring = true;
      renderRestoreSessionModalState();
      void restoreAgentSession(stateNow.agentSessionId, target).then((ok) => {
        if (!restoreSessionModalState || restoreSessionModalState.agentSessionId !== stateNow.agentSessionId) return;
        if (ok) {
          closeRestoreSessionModal();
          return;
        }
        restoreSessionModalState.restoring = false;
        renderRestoreSessionModalState();
      });
    },
  });
}

function openAgentSessionActions(agentSessionId: string): void {
  const session = agentSessions.find((x) => x.id === agentSessionId);
  if (!session) return;
  const seq = ++restoreSessionModalSeq;
  const matchedWt = session.worktree
    ? knownWorktrees.find((w) => (w.branch || w.name) === session.worktree)
    : null;
  const suggestedWorktreePath = matchedWt ? matchedWt.path : "";
  const suggestedBranch = session.worktree ?? `restore-${Date.now()}`;
  const defaultTarget: RestoreTargetChoice = suggestedWorktreePath ? "worktree" : "same_cwd";
  restoreSessionModalState = {
    agentSessionId,
    target: defaultTarget,
    selectedWorktreePath: suggestedWorktreePath,
    customCwdValue: session.cwd ?? session.projectRoot ?? "",
    newBranchValue: suggestedBranch,
    worktreeOptions: [],
    restoring: false,
  };
  renderRestoreSessionModalState();

  void authFetch("/api/worktrees")
    .then(async (res) => (res.ok ? res.json() : Promise.reject(new Error(await readApiError(res)))))
    .then((data: { worktrees?: Array<{ name: string; path: string }> }) => {
      if (!restoreSessionModalState || seq !== restoreSessionModalSeq) return;
      const state = restoreSessionModalState;
      state.worktreeOptions = buildRestoreWorktreeOptions(session, data.worktrees);
      if (
        state.worktreeOptions.length > 0 &&
        !state.worktreeOptions.some((wt) => wt.value === state.selectedWorktreePath)
      ) {
        state.selectedWorktreePath = state.worktreeOptions[0].value;
      }
      if (state.target === "worktree" && state.worktreeOptions.length === 0) {
        state.target = "same_cwd";
      }
      renderRestoreSessionModalState();
    })
    .catch(() => {
      if (!restoreSessionModalState || seq !== restoreSessionModalSeq) return;
      restoreSessionModalState.worktreeOptions = [];
      if (restoreSessionModalState.target === "worktree") restoreSessionModalState.target = "same_cwd";
      renderRestoreSessionModalState();
    });
}

function normalizeCwdGroupKey(cwd: string): string {
  // If cwd matches a known worktree path, group under the main repo root
  if (findContainingWorktree(cwd, knownWorktrees)) {
    return serverRepoRoot || cwd;
  }
  // Fallback: also handle legacy .worktrees/ paths for backwards compat
  const idx = cwd.indexOf("/.worktrees/");
  if (idx !== -1) return cwd.slice(0, idx);
  return cwd;
}

function ptyProjectKey(pty: PtySummary): string {
  return pty.projectRoot ?? (pty.cwd ? normalizeCwdGroupKey(pty.cwd) : "");
}

function ptyWorktreeLabel(pty: PtySummary): string | null {
  return pty.worktree ?? worktreeName(pty.cwd);
}

function runningPtyGroupKey(pty: PtySummary): string {
  return ptyProjectKey(pty);
}

function agentSessionProjectKey(session: AgentSessionSummary): string {
  const clientKey = session.cwd ? normalizeCwdGroupKey(session.cwd) : null;
  return (clientKey && clientKey !== session.cwd) ? clientKey : (session.projectRoot ?? "");
}

function buildInactiveAgentSessionMap(activeAgentSessionIds: Set<string>): Map<string, AgentSessionSummary[]> {
  const inactiveByProject = new Map<string, AgentSessionSummary[]>();
  const sortedAgentSessions = [...agentSessions]
    .filter((s) => !hiddenAgentSessionIds.has(s.id) && !activeAgentSessionIds.has(s.id))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  for (const session of sortedAgentSessions) {
    const key = agentSessionProjectKey(session);
    const items = inactiveByProject.get(key) ?? [];
    items.push(session);
    inactiveByProject.set(key, items);
  }
  return inactiveByProject;
}

function getInactiveSessionsForProject(groupKey: string): AgentSessionSummary[] {
  const activeAgentSessionIds = new Set(
    ptys
      .filter((p) => p.status === "running")
      .map((p) => p.agentSessionId?.trim() ?? "")
      .filter((id): id is string => id.length > 0),
  );
  return buildInactiveAgentSessionMap(activeAgentSessionIds).get(groupKey) ?? [];
}

function worktreeName(cwd: string | null): string | null {
  if (!cwd) return null;
  const matchedWorktree = findContainingWorktree(cwd, knownWorktrees);
  if (matchedWorktree) {
    return matchedWorktree.branch || matchedWorktree.name;
  }
  // Fallback: legacy .worktrees/ pattern
  const m = cwd.match(/\/\.worktrees\/([^/]+)/);
  return m ? m[1] : null;
}

const collapsedGroups = new Set<string>();
const collapsedWorktrees = new Set<string>(); // "groupKey::worktreeName"
const inlineInactiveExpanded = new Set<string>(); // directory keys where inline recent is expanded
const collapsedAgentSessionGroups = new Set<string>();
const collapsedAgentSessionWorktrees = new Set<string>(); // "projectKey::worktreeName"
const AGENT_GROUPS_COLLAPSED_KEY = "agmux:agentSessionGroupsCollapsed";
const AGENT_WORKTREES_COLLAPSED_KEY = "agmux:agentSessionWorktreesCollapsed";

const AUTO_COLLAPSE_PROJECT_THRESHOLD = 4;
const AUTO_COLLAPSE_PROJECT_SIZE = 5;
const AUTO_COLLAPSE_WORKTREE_THRESHOLD = 3;
const AUTO_COLLAPSE_WORKTREE_SIZE = 4;
const AUTO_COLLAPSE_SECTION_TOTAL = 8;

function loadCollapsedSet(key: string, target: Set<string>): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return true;
    for (const value of parsed) {
      if (typeof value === "string") target.add(value);
    }
    return true;
  } catch {
    // ignore
    return false;
  }
}

function saveCollapsedSet(key: string, source: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...source]));
  } catch {
    // ignore
  }
}

function loadBooleanPreference(key: string): boolean | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return null;
  } catch {
    return null;
  }
}

function saveBooleanPreference(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // ignore
  }
}

let hasStoredAgentGroupCollapsePref = loadCollapsedSet(AGENT_GROUPS_COLLAPSED_KEY, collapsedAgentSessionGroups);
let hasStoredAgentWorktreeCollapsePref = loadCollapsedSet(AGENT_WORKTREES_COLLAPSED_KEY, collapsedAgentSessionWorktrees);
let inactiveSessionsExpanded = false;
const ARCHIVED_SECTION_EXPANDED_KEY = "agmux:archivedSectionExpanded";
const ARCHIVED_GROUPS_COLLAPSED_KEY = "agmux:archivedGroupsCollapsed";
const ARCHIVED_WORKTREES_COLLAPSED_KEY = "agmux:archivedWorktreesCollapsed";
const collapsedArchivedGroups = new Set<string>();
const collapsedArchivedWorktrees = new Set<string>();
loadCollapsedSet(ARCHIVED_GROUPS_COLLAPSED_KEY, collapsedArchivedGroups);
loadCollapsedSet(ARCHIVED_WORKTREES_COLLAPSED_KEY, collapsedArchivedWorktrees);
let archivedSectionExpandedOverride = loadBooleanPreference(ARCHIVED_SECTION_EXPANDED_KEY);

function buildRunningPtyItem(p: PtySummary): RunningPtyItem {
  const name = displayRunningPtyName(p);
  const title = (ptyTitles.get(p.id) ?? "").trim();
  const worktree = ptyWorktreeLabel(p);
  const wtColor = worktree ? worktreeColor(worktree) : undefined;
  const activeProcess = compactWhitespace(p.activeProcess ?? "");
  const inferredAgent = inferAgentFromRecentInput(p.id);
  const preferTitleAgentLabel = Boolean(title) && isAgentProcessName(title) && isGenericRuntimeProcess(activeProcess);
  const process = compactWhitespace(preferTitleAgentLabel
    ? title
    : (
      inferredAgent && isGenericRuntimeProcess(activeProcess)
        ? inferredAgent
        : ((activeProcess && !isShellProcess(activeProcess) ? activeProcess : "") || activeProcess || title || name)
    ));
  const inputPreview = ptyLastInput.get(p.id) ?? "";
  const readyInfo = ptyReady.get(p.id) ?? readinessFromSummary(p);
  const changedAt = ptyStateChangedAt.get(p.id);
  const elapsed = changedAt && readyInfo.state !== "unknown" ? formatElapsedTime(changedAt) : "";
  const secondaryText = inputPreview ? `> ${inputPreview}` : "";
  const prApprovalCount = p.pr?.votes.filter((v) => v.vote === "approved" || v.vote === "approvedWithSuggestions").length ?? 0;

  return {
    id: p.id,
    color: wtColor ?? ptyColor(p.id),
    active: p.id === activePtyId,
    readyUnviewed: unviewedReadyPtys.has(p.id) && p.id !== activePtyId,
    prMarker: p.pr ? (p.pr.hasNewComments && p.id !== activePtyId ? "new" : "seen") : undefined,
    prUnresolved: p.pr?.unresolvedCount,
    prApproved: prApprovalCount >= REQUIRED_PR_APPROVALS,
    prApprovalCount,
    prRequiredApprovals: REQUIRED_PR_APPROVALS,
    prWaitingForReview: p.pr ? prWaitingForReviewPtys.has(p.id) : undefined,
    readyState: readyInfo.state,
    readyIndicator: readyInfo.indicator,
    readyReason: readyInfo.reason,
    name,
    process: process && process !== name ? process : undefined,
    title: title && title !== process && title !== name ? title : undefined,
    secondaryText,
    worktree,
    cwd: p.cwd ?? undefined,
    elapsed: elapsed || undefined,
  };
}

function buildInactiveAgentSessionItem(session: AgentSessionSummary): InactivePtyItem {
  const process = displayInactiveSessionTitle(session);
  const intent = displaySessionIntent(session);
  const subtitle = displayInactiveSessionSubtitle(session);
  const elapsed = formatElapsedTime(session.lastSeenAt);
  const worktree = session.worktree ?? worktreeName(session.cwd);

  const tooltipParts = [capitalizeWord(session.provider)];
  if (subtitle) tooltipParts.push(subtitle);
  if (elapsed) tooltipParts.push(`${elapsed} ago`);
  if (worktree) tooltipParts.push(`worktree: ${worktree}`);

  return {
    id: session.id,
    color: worktree ? worktreeColor(worktree) : ptyColor(session.id),
    process,
    secondaryText: subtitle,
    firstInput: intent ?? undefined,
    secondaryTitle: tooltipParts.join("\n"),
    worktree,
    cwd: session.cwd ?? undefined,
    elapsed: elapsed || undefined,
    exitLabel: `${session.provider} session`,
  };
}

// ---------------------------------------------------------------------------
// Mobile UI
// ---------------------------------------------------------------------------

const AGENT_PROCESS_NAMES = [
  "claude",
  "codex",
  "aider",
  "goose",
  "opencode",
  "cursor-agent",
  "pi",
];
const QUICK_PROMPTS_AGENT = [
  "Summarize progress",
  "Next steps?",
  "Show diff summary",
  "Run tests",
];
const QUICK_PROMPTS_SHELL = [
  "pwd",
  "ls",
  "git status",
  "git diff --stat",
];

function isAgentProcessName(process: string): boolean {
  const lower = process.toLowerCase();
  return AGENT_PROCESS_NAMES.some((name) => lower.includes(name));
}

function pathBaseName(input: string): string {
  const normalized = input.replace(/\/+$/g, "");
  const segs = normalized.split("/").filter(Boolean);
  return segs.at(-1) ?? input;
}

function mobileActiveProcessLabel(process: string): string {
  const trimmed = process.trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("shell:")) return "";
  if (isShellProcess(trimmed)) return "";
  return trimmed;
}

function buildMobileTitle(pty: PtySummary, process: string, worktree?: string): string {
  const parts: string[] = [];
  const projectRoot = ptyProjectKey(pty);
  if (projectRoot) {
    const project = pathBaseName(projectRoot);
    if (project) parts.push(project);
  }
  if (worktree) parts.push(worktree);
  const active = mobileActiveProcessLabel(process);
  if (active) parts.push(active);
  if (parts.length > 0) return parts.join(" • ");
  if (worktree) return worktree;
  return "Session";
}

function buildMobileSessionMeta(pty: PtySummary, item: RunningPtyItem): string {
  const parts = [item.process, item.worktree, item.title]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index);
  if (parts.length > 0) return parts.join(" • ");
  const fallback = buildMobileTitle(pty, item.process ?? item.name, item.worktree);
  return fallback === "Session" ? "" : fallback;
}

function buildMobileMetaPills(item: RunningPtyItem): string[] {
  return [item.process, item.worktree]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index);
}

function getOutputPreviewLines(ptyId: string, maxLines = 6): string[] {
  const st = terms.get(ptyId);
  if (!st) return [];
  const buf = st.term.buffer.active;
  const start = Math.max(0, buf.length - maxLines * 3);
  const lines: string[] = [];
  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true).replace(/\s+$/g, "");
    lines.push(text);
  }
  while (lines.length > 0 && lines[0].trim().length === 0) lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) lines.pop();
  return lines.slice(-maxLines);
}

function buildMobileRunningSession(p: PtySummary): MobileRunningSession {
  const item = buildRunningPtyItem(p);
  const lastInput = ptyLastInput.get(p.id) ?? "";
  const meta = buildMobileSessionMeta(p, item);
  const metaPills = buildMobileMetaPills(item);
  return {
    id: p.id,
    process: item.name,
    subtitle: meta || lastInput,
    metaPills: metaPills.length > 0 ? metaPills : undefined,
    worktree: item.worktree,
    cwd: item.cwd,
    readyState: item.readyState,
    readyIndicator: item.readyIndicator,
    readyReason: item.readyReason,
    readyUnviewed: item.readyUnviewed,
    elapsed: item.elapsed,
    lastInput,
    outputPreview: getOutputPreviewLines(p.id, 3),
    active: item.active,
  };
}

function buildMobileFocus(p: PtySummary): MobileFocus {
  const item = buildRunningPtyItem(p);
  const lastInput = ptyLastInput.get(p.id) ?? "";
  const metaPills = buildMobileMetaPills(item);
  return {
    id: p.id,
    title: item.name,
    subtitle: lastInput,
    metaPills: metaPills.length > 0 ? metaPills : undefined,
    readyState: item.readyState,
    readyIndicator: item.readyIndicator,
    readyReason: item.readyReason,
    elapsed: item.elapsed,
    lastInput,
  };
}

function mapInactiveItemToMobileSession(item: InactivePtyItem, projectLabel: string): MobileInactiveSession {
  const provider = item.exitLabel.replace(/\s+session$/i, "").toLowerCase();
  const providerLabel = capitalizeWord(provider);
  const projectNorm = projectLabel.trim().toLowerCase();
  const firstInputRaw = item.firstInput?.trim() ?? "";
  const firstInput = firstInputRaw && firstInputRaw.toLowerCase() !== projectNorm ? firstInputRaw : "";
  const subtitleRaw = item.secondaryText.trim();
  const projectSubtitle = `project:${projectNorm}`;
  const subtitleNormalized = subtitleRaw.toLowerCase();
  const isBranchSubtitle = subtitleNormalized.startsWith("branch:");
  const subtitle = subtitleRaw &&
    subtitleNormalized !== projectSubtitle &&
    subtitleNormalized !== projectNorm &&
    !(item.worktree && isBranchSubtitle)
    ? subtitleRaw
    : "";
  return {
    id: item.id,
    title: providerLabel || item.process,
    subtitle,
    provider,
    worktree: item.worktree ?? undefined,
    elapsed: item.elapsed ?? undefined,
    firstInput: firstInput || undefined,
  };
}

function flattenInactiveGroupItems(group: InactiveGroup): InactivePtyItem[] {
  const items = [...group.items];
  for (const wt of group.worktrees) {
    items.push(...wt.items);
  }
  return items;
}

function flattenProjectInactiveItems(group: PtyGroup): InactivePtyItem[] {
  const items = [...group.inactiveSessions];
  for (const wt of group.inactiveWorktrees) {
    items.push(...wt.items);
  }
  return items;
}

function stripProjectPrefix(value: string, projectLabel: string): string {
  const text = value.trim();
  const label = projectLabel.trim();
  if (!label) return text;
  const prefix = `${label} • `;
  if (text.startsWith(prefix)) return text.slice(prefix.length).trim();
  if (text === label) return "Session";
  return text;
}

let mobileRenderPending = false;
function scheduleMobileRender(): void {
  if (!mobileViewport) return;
  if (mobileRenderPending) return;
  mobileRenderPending = true;
  requestAnimationFrame(() => {
    mobileRenderPending = false;
    renderMobileViewState();
  });
}

function reparentTermToMobile(): void {
  if (!mobileTermMountEl || !activePtyId) return;
  // Already reparented for this PTY
  if (mobileReparentedPtyId === activePtyId && mobileTermMountEl.contains(terms.get(activePtyId)?.container ?? null)) return;

  // Return any previously reparented term first
  returnTermToDesktop();

  const st = terms.get(activePtyId);
  if (!st) return;

  st.container.classList.remove("hidden");
  mobileTermMountEl.appendChild(st.container);
  if (!st.opened) {
    st.term.open(st.container);
    st.opened = true;
  }
  st.term.options.disableStdin = true;
  mobileReparentedPtyId = activePtyId;

  requestAnimationFrame(() => {
    fitAndResizeActive();
    reflowActiveTerm();
  });
}

function returnTermToDesktop(): void {
  if (!mobileReparentedPtyId) return;
  const st = terms.get(mobileReparentedPtyId);
  if (st) {
    st.term.options.disableStdin = false;
    st.container.classList.add("hidden");
    terminalEl.appendChild(st.container);
  }
  mobileReparentedPtyId = null;
}

function sendMobileInput(text: string): void {
  if (!activePtyId) return;
  const normalized = text.replace(/\r\n?/g, "\n");
  // Mobile submit is always server-gated: write body, then server sends Enter.
  const targetPtyId = activePtyId;
  const body = normalized.replace(/[\r\n]+/g, "");
  sendWsMessage({ type: "mobile_submit", ptyId: targetPtyId, body });
  trackUserInput(targetPtyId, `${body}\r`);
  scheduleProviderHistoryRefresh(targetPtyId);
  mobileInputDraftByPtyId.delete(targetPtyId);
  renderMobileViewState();
}

function activeMobileInputDraft(): string {
  if (!activePtyId) return "";
  return mobileInputDraftByPtyId.get(activePtyId) ?? "";
}

function setActiveMobileInputDraft(value: string): void {
  if (!activePtyId) return;
  if (!value) {
    mobileInputDraftByPtyId.delete(activePtyId);
    return;
  }
  mobileInputDraftByPtyId.set(activePtyId, value);
}

function openMobilePreview(agentSessionId: string): void {
  const session = agentSessions.find((x) => x.id === agentSessionId);
  if (!session) return;
  const seq = ++mobilePreviewSeq;
  mobilePreviewState = {
    id: session.id,
    title: displaySessionTitle(session),
    subtitle: displaySessionSubtitle(session),
    provider: session.provider,
    providerSessionId: session.providerSessionId,
    loading: true,
    messages: [],
  };
  renderMobileViewState();

  void authFetch(
    `/api/agent-sessions/${encodeURIComponent(session.provider)}/${encodeURIComponent(session.providerSessionId)}/conversation`,
  )
    .then(async (res) => (res.ok ? res.json() : Promise.reject(new Error(await readApiError(res)))))
    .then((data: { messages?: SessionPreviewMessage[] }) => {
      if (!mobilePreviewState || seq !== mobilePreviewSeq) return;
      mobilePreviewState.messages = Array.isArray(data.messages) ? data.messages : [];
      mobilePreviewState.loading = false;
      renderMobileViewState();
    })
    .catch(() => {
      if (!mobilePreviewState || seq !== mobilePreviewSeq) return;
      mobilePreviewState.messages = [];
      mobilePreviewState.loading = false;
      renderMobileViewState();
    });
}

function requestMobileTmuxSnapshot(ptyId: string): void {
  const summary = ptys.find((p) => p.id === ptyId);
  const focus = summary ? buildMobileFocus(summary) : null;
  const seq = ++mobileTerminalSnapshotSeq;
  const requestId = `mobile-snapshot-${seq}`;
  mobileTerminalSnapshotPendingRequestId = requestId;
  mobileTerminalSnapshot = {
    seq,
    ptyId,
    title: focus?.title ?? "Terminal snapshot",
    subtitle: focus?.subtitle ?? "",
    capturedAt: "",
    text: "",
    lineCount: 0,
    truncated: false,
    linesRequested: MOBILE_TMUX_SNAPSHOT_LINES,
    loading: true,
    error: null,
  };
  renderMobileViewState();
  saveMobileSnapshotPtyId(ptyId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    mobileTerminalSnapshotPendingRequestId = null;
    mobileTerminalSnapshot = {
      ...mobileTerminalSnapshot,
      loading: false,
      error: "Not connected",
    };
    renderMobileViewState();
    return;
  }
  sendWsMessage({
    type: "mobile_snapshot_request",
    requestId,
    ptyId,
    lines: MOBILE_TMUX_SNAPSHOT_LINES,
  });
}

function maybeRestoreMobileSnapshot(): void {
  if (!mobileViewport) return;
  if (!mobileSnapshotRestorePtyId) return;
  if (!activePtyId || activePtyId !== mobileSnapshotRestorePtyId) return;
  if (mobileTerminalSnapshot || mobileTerminalSnapshotPendingRequestId) return;
  mobileSnapshotRestorePtyId = null;
  requestMobileTmuxSnapshot(activePtyId);
}

function buildMobileViewModel(): MobileViewModel {
  const runningPtys = ptys.filter((p) => p.status === "running");
  const running = runningPtys.map((p) => buildMobileRunningSession(p));
  const activeIdx = running.findIndex((r) => r.id === activePtyId);
  if (activeIdx > 0) {
    const [active] = running.splice(activeIdx, 1);
    running.unshift(active);
  }
  const runningById = new Map(running.map((session) => [session.id, session]));

  const projectModel = latestPtyListModel ?? {
    groups: [],
    showHeaders: false,
    inactive: null,
    archived: null,
  } as PtyListModel;

  const runningProjects: MobileProjectGroup[] = projectModel.groups.map((group) => ({
    key: group.key,
    label: group.label,
    title: group.title,
    pinned: group.pinned,
    inactiveTotal: group.inactiveTotal,
    running: group.items
      .map((item) => runningById.get(item.id))
      .filter((session): session is MobileRunningSession => Boolean(session))
      .map((session) => ({
        ...session,
        process: stripProjectPrefix(session.process, group.label),
      })),
  })).filter((group) => group.running.length > 0);
  if (runningProjects.length === 0 && running.length > 0) {
    runningProjects.push({
      key: "",
      label: "Sessions",
      title: undefined,
      pinned: false,
      inactiveTotal: 0,
      running,
    });
  }

  const inlineInactiveProjects: MobileInactiveProjectGroup[] = projectModel.groups
    .filter((group) => group.inactiveTotal > 0)
    .map((group) => ({
      key: group.key,
      label: group.label,
      title: group.title,
      archived: false,
      pinned: group.pinned,
      sessions: flattenProjectInactiveItems(group).map((item) => mapInactiveItemToMobileSession(item, group.label)),
    }))
    .filter((group) => group.sessions.length > 0);

  const orphanInactiveProjects: MobileInactiveProjectGroup[] = (projectModel.inactive?.groups ?? [])
    .map((group) => ({
      key: group.key,
      label: group.label,
      title: group.title,
      archived: false,
      pinned: false,
      sessions: flattenInactiveGroupItems(group).map((item) => mapInactiveItemToMobileSession(item, group.label)),
    }))
    .filter((group) => group.sessions.length > 0);

  const inactiveProjects: MobileInactiveProjectGroup[] = [...inlineInactiveProjects, ...orphanInactiveProjects];

  const archivedProjects: MobileInactiveProjectGroup[] = (projectModel.archived?.groups ?? [])
    .map((group) => ({
      key: group.key,
      label: group.label,
      title: group.title,
      archived: true,
      pinned: false,
      sessions: flattenInactiveGroupItems(group).map((item) => mapInactiveItemToMobileSession(item, group.label)),
    }))
    .filter((group) => group.sessions.length > 0);

  const findProjectLabel = (key: string): string => {
    const match = [...runningProjects, ...inactiveProjects, ...archivedProjects].find((group) => group.key === key);
    if (match) return match.label;
    if (!key) return "Other";
    return key.split("/").filter(Boolean).at(-1) ?? key;
  };

  const inactiveProjectLabel = mobileInactiveProjectKey != null ? findProjectLabel(mobileInactiveProjectKey) : null;
  const visibleInactiveProjects = mobileInactiveProjectKey == null
    ? inactiveProjects
    : inactiveProjects.filter((group) => group.key === mobileInactiveProjectKey);
  const visibleArchivedProjects = mobileInactiveProjectKey == null
    ? archivedProjects
    : archivedProjects.filter((group) => group.key === mobileInactiveProjectKey);

  const activeSummary = activePtyId ? ptys.find((p) => p.id === activePtyId) ?? null : null;
  const focus = activeSummary ? buildMobileFocus(activeSummary) : null;
  const activeTitle = focus?.title ?? "No session";
  const activeProcess = activeSummary ? buildRunningPtyItem(activeSummary).process : "";
  const quickPrompts = focus
    ? (activeProcess && isAgentProcessName(activeProcess) ? QUICK_PROMPTS_AGENT : QUICK_PROMPTS_SHELL)
    : [];

  const mobileTheme = THEMES.get(mobileTerminalThemeKey) ?? activeTheme;
  const terminalTheme = mobileTheme.terminal;

  return {
    connected: wsConnected,
    view: mobileView,
    running,
    runningProjects,
    inactiveProjects: visibleInactiveProjects,
    archivedProjects: visibleArchivedProjects,
    inactiveProjectLabel,
    focus,
    activeTitle,
    inputDraft: activeMobileInputDraft(),
    quickPrompts,
    preview: mobilePreviewState,
    terminalSnapshot: mobileTerminalSnapshot,
    settingsOpen: mobileSettingsOpen,
    terminalThemeKey: mobileTerminalThemeKey,
    terminalThemes: [...THEMES].map(([key, theme]) => ({ key, name: theme.name })),
    terminalFontSize: mobileTerminalFontSize,
    historyButtonBg: terminalTheme.background ?? mobileTheme.panel,
    historyButtonText: terminalTheme.foreground ?? mobileTheme.text,
    historyButtonBorder: terminalTheme.cursor ?? mobileTheme.line,
    showFollowButton: focus ? activeTermIsScrolledUp() : false,
  };
}

function renderMobileViewState(): void {
  if (mobileView === "session") {
    const runningPtys = ptys.filter((p) => p.status === "running");
    const active = activePtyId ? runningPtys.find((p) => p.id === activePtyId) : null;
    if (!active && runningPtys.length > 0) {
      const saved = loadSavedActivePty();
      const restoreTarget = saved
        ? (
          runningPtys.find((p) => p.id === saved.ptyId) ??
          (saved.tmuxSession
            ? runningPtys.find(
              (p) =>
                p.backend === "tmux" &&
                p.tmuxSession === saved.tmuxSession &&
                (saved.tmuxServer ? p.tmuxServer === saved.tmuxServer : true),
            )
            : null)
        )
        : null;
      const fallback = restoreTarget ?? runningPtys[0];
      setActive(fallback.id);
    }
    const activeAfterRestore = activePtyId ? runningPtys.find((p) => p.id === activePtyId) : null;
    if (!activeAfterRestore && runningPtys.length > 0) {
      mobileView = "active";
      saveMobileView();
    }
  }
  if (!mobileViewport && !mobilePreviewState && !mobileSettingsOpen && !mobileTerminalSnapshot) {
    returnTermToDesktop();
    mobileTermMountEl = null;
    renderMobileView(mobileRoot, null, {
      onSelectRunning: () => {},
      onCloseRunning: () => {},
      onRenameRunning: () => {},
      onOpenLaunch: () => {},
      onTogglePinProject: () => {},
      onArchiveProject: () => {},
      onUnarchiveProject: () => {},
      onShowInactive: () => {},
      onBack: () => {},
      onChangeDraft: () => {},
      onSendDraft: () => {},
      onQuickPrompt: () => {},
      onInterrupt: () => {},
      onArrowUp: () => {},
      onArrowDown: () => {},
      onTabKey: () => {},
      onFollowOutput: () => {},
      onOpenTermSnapshot: () => {},
      onCloseTermSnapshot: () => {},
      onPreviewInactive: () => {},
      onRestoreInactive: () => {},
      onClosePreview: () => {},
      onTermMountReady: () => {},
      onOpenSettings: () => {},
      onCloseSettings: () => {},
      onTerminalThemeChange: () => {},
      onTerminalFontSizeChange: () => {},
    });
    if (activePtyId) {
      updateTerminalVisibility();
      requestAnimationFrame(() => { fitAndResizeActive(); reflowActiveTerm(); });
    }
    return;
  }
  renderMobileView(mobileRoot, buildMobileViewModel(), {
    onSelectRunning: (ptyId) => {
      setActive(ptyId);
      mobileView = "session";
      mobileInactiveProjectKey = null;
      saveMobileView();
      mobileTerminalSnapshot = null;
      mobileTerminalSnapshotPendingRequestId = null;
      saveMobileSnapshotPtyId(null);
      renderMobileViewState();
    },
    onCloseRunning: (ptyId) => {
      if (mobileReparentedPtyId === ptyId) returnTermToDesktop();
      killPty(ptyId);
      if (activePtyId === ptyId) {
        mobileTerminalSnapshot = null;
        mobileTerminalSnapshotPendingRequestId = null;
        saveMobileSnapshotPtyId(null);
      }
      if (activePtyId === ptyId && mobileView === "session") {
        mobileTermMountEl = null;
        mobileView = "active";
        saveMobileView();
      }
      renderMobileViewState();
    },
    onRenameRunning: (ptyId) => {
      void renamePty(ptyId);
    },
    onOpenLaunch: () => {
      const active = activePtyId ? ptys.find((p) => p.id === activePtyId) : null;
      const groupCwd = active?.cwd ? normalizeCwdGroupKey(active.cwd) : "";
      openLaunchModal(groupCwd);
    },
    onTogglePinProject: (projectKey) => {
      if (pinnedDirectories.has(projectKey)) pinnedDirectories.delete(projectKey);
      else pinnedDirectories.add(projectKey);
      savePinnedDirectories();
      renderList();
    },
    onArchiveProject: (projectKey) => {
      archiveDirectory(projectKey);
    },
    onUnarchiveProject: (projectKey) => {
      unarchiveDirectory(projectKey);
    },
    onOpenSettings: () => {
      mobileSettingsOpen = true;
      renderMobileViewState();
    },
    onCloseSettings: () => {
      mobileSettingsOpen = false;
      renderMobileViewState();
    },
    onShowInactive: (projectKey) => {
      mobileInactiveProjectKey = projectKey;
      mobileView = "inactive";
      saveMobileView();
      mobileTerminalSnapshot = null;
      mobileTerminalSnapshotPendingRequestId = null;
      saveMobileSnapshotPtyId(null);
      renderMobileViewState();
    },
    onBack: () => {
      returnTermToDesktop();
      mobileTermMountEl = null;
      mobileTerminalSnapshot = null;
      mobileTerminalSnapshotPendingRequestId = null;
      mobileInactiveProjectKey = null;
      mobileView = "active";
      saveMobileView();
      saveMobileSnapshotPtyId(null);
      renderMobileViewState();
    },
    onChangeDraft: (value) => {
      setActiveMobileInputDraft(value);
      renderMobileViewState();
    },
    onSendDraft: (value) => {
      sendMobileInput(value ?? activeMobileInputDraft());
    },
    onQuickPrompt: (prompt) => {
      sendMobileInput(prompt);
    },
    onInterrupt: () => {
      if (!activePtyId) return;
      sendWsMessage({ type: "input", ptyId: activePtyId, data: "\u0003" });
      addEvent(`Sent interrupt to ${activePtyId}`);
      scheduleMobileRender();
    },
    onArrowUp: () => {
      if (!activePtyId) return;
      sendWsMessage({ type: "input", ptyId: activePtyId, data: "\u001b[A" });
    },
    onArrowDown: () => {
      if (!activePtyId) return;
      sendWsMessage({ type: "input", ptyId: activePtyId, data: "\u001b[B" });
    },
    onTabKey: () => {
      if (!activePtyId) return;
      sendWsMessage({ type: "input", ptyId: activePtyId, data: "\t" });
    },
    onFollowOutput: () => {
      scrollActiveTerminalToBottom();
    },
    onOpenTermSnapshot: () => {
      if (!activePtyId) return;
      requestMobileTmuxSnapshot(activePtyId);
    },
    onCloseTermSnapshot: () => {
      mobileTerminalSnapshot = null;
      mobileTerminalSnapshotPendingRequestId = null;
      saveMobileSnapshotPtyId(null);
      renderMobileViewState();
    },
    onPreviewInactive: (agentSessionId) => openMobilePreview(agentSessionId),
    onRestoreInactive: (agentSessionId) => {
      mobilePreviewState = null;
      renderMobileViewState();
      openAgentSessionActions(agentSessionId);
    },
    onClosePreview: () => {
      mobilePreviewState = null;
      renderMobileViewState();
    },
    onTerminalThemeChange: (key) => {
      setMobileTerminalTheme(key);
    },
    onTerminalFontSizeChange: (size) => {
      setMobileTerminalFontSize(size);
    },
    onTermMountReady: (el) => {
      mobileTermMountEl = el;
      if (el && mobileView === "session" && activePtyId) {
        reparentTermToMobile();
      }
    },
  });
  maybeRestoreMobileSnapshot();
}

function buildInactiveWorktreeSubgroups(
  items: InactivePtyItem[],
  keyPrefix: string,
): { rootItems: InactivePtyItem[]; worktrees: InactiveWorktreeSubgroup[] } {
  const rootItems: InactivePtyItem[] = [];
  const wtMap = new Map<string, { items: InactivePtyItem[]; path: string }>();
  for (const item of items) {
    if (item.worktree) {
      let wt = wtMap.get(item.worktree);
      if (!wt) {
        wt = { items: [], path: item.cwd ?? "" };
        wtMap.set(item.worktree, wt);
      }
      wt.items.push(item);
    } else {
      rootItems.push(item);
    }
  }
  const worktrees = [...wtMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, wt]) => {
      const wtKey = `${keyPrefix}::${name}`;
      const worktreeCount = wtMap.size;
      const autoCollapseWorktree = !hasStoredAgentWorktreeCollapsePref &&
        (worktreeCount >= AUTO_COLLAPSE_WORKTREE_THRESHOLD || wt.items.length >= AUTO_COLLAPSE_WORKTREE_SIZE);
      return {
        name,
        path: wt.path,
        collapsed: collapsedAgentSessionWorktrees.has(wtKey) || autoCollapseWorktree,
        items: wt.items,
      };
    });
  return { rootItems, worktrees };
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function reorderSidebarPty(sourcePtyId: string, targetPtyId: string, placement: PtyReorderPlacement): void {
  const source = ptys.find((p) => p.id === sourcePtyId && p.status === "running");
  const target = ptys.find((p) => p.id === targetPtyId && p.status === "running");
  if (!source || !target) return;
  if (runningPtyGroupKey(source) !== runningPtyGroupKey(target)) return;

  const currentOrder = runningPtys().map((p) => p.id);
  const nextOrder = reorderPtyIds(currentOrder, sourcePtyId, targetPtyId, placement);
  if (sameStringList(currentOrder, nextOrder)) return;
  sidebarPtyOrder = nextOrder;
  saveSidebarPtyOrder();
  renderList();
}

function togglePrWaitingForReview(ptyId: string): void {
  const summary = ptys.find((p) => p.id === ptyId);
  if (!summary?.pr) return;

  if (prWaitingForReviewPtys.has(ptyId)) {
    prWaitingForReviewPtys.delete(ptyId);
  } else {
    prWaitingForReviewPtys.add(ptyId);
  }
  savePrWaitingForReviewPtys();
  renderList();
}

function renderList(): void {
  // Group running PTYs by CWD (normalize .worktrees/ paths to parent repo).
  pruneSidebarPtyOrder();
  const runningPtys = orderRunningPtysForSidebar(ptys, {
    pinnedDirectories,
    getGroupKey: runningPtyGroupKey,
    manualOrder: sidebarPtyOrder,
  });
  const activeAgentSessionIds = new Set(
    runningPtys
      .map((p) => p.agentSessionId?.trim() ?? "")
      .filter((id): id is string => id.length > 0),
  );
  const runningByDir = new Map<string, RunningPtyItem[]>();
  for (const p of runningPtys) {
    const key = runningPtyGroupKey(p);
    let arr = runningByDir.get(key);
    if (!arr) {
      arr = [];
      runningByDir.set(key, arr);
    }
    arr.push(buildRunningPtyItem(p));
  }

  // Group inactive agent sessions by project, preferring client-side worktree detection.
  const inactiveSessionMap = buildInactiveAgentSessionMap(activeAgentSessionIds);
  const inactiveByProject = new Map<string, InactivePtyItem[]>();
  for (const [key, sessions] of inactiveSessionMap.entries()) {
    inactiveByProject.set(key, sessions.map((session) => buildInactiveAgentSessionItem(session)));
  }

  // Auto-unarchive directories that have running sessions
  for (const k of runningByDir.keys()) {
    if (archivedDirectories.has(k)) {
      archivedDirectories.delete(k);
      saveArchivedDirectories();
    }
  }

  // Collect all visible directory keys: pinned dirs + dirs with running PTYs (exclude archived).
  const visibleDirKeys = new Set<string>(
    [...pinnedDirectories, ...runningByDir.keys()].filter((k) => !archivedDirectories.has(k)),
  );

  // Build unified directory groups: pinned first, then non-pinned, both alphabetical.
  const pinnedKeys = [...visibleDirKeys].filter((k) => pinnedDirectories.has(k)).sort(compareSidebarGroupKeys);
  const nonPinnedKeys = [...visibleDirKeys].filter((k) => !pinnedDirectories.has(k)).sort(compareSidebarGroupKeys);
  let allVisibleKeys = [...pinnedKeys, ...nonPinnedKeys];



  const groups: PtyGroup[] = allVisibleKeys.map((key) => {
    const basename = key ? key.split("/").filter(Boolean).at(-1) ?? key : "Other";
    const runningItems = runningByDir.get(key) ?? [];

    // Inline inactive sessions for this directory
    const dirInactiveItems = inactiveByProject.get(key) ?? [];
    const inactiveSub = buildInactiveWorktreeSubgroups(dirInactiveItems, key);

    return {
      key,
      label: basename,
      title: key || undefined,
      pinned: pinnedDirectories.has(key),
      collapsed: collapsedGroups.has(key),
      worktrees: [],
      items: runningItems,
      inactiveSessions: inactiveSub.rootItems,
      inactiveWorktrees: inactiveSub.worktrees,
      inactiveTotal: dirInactiveItems.length,
      inlineInactiveExpanded: inlineInactiveExpanded.has(key),
    };
  });

  // Build "Inactive" section: directories with sessions that are not pinned, not running, and not archived.
  // Directories confirmed to not exist on disk are treated as archived.
  const orphanInactiveKeys: string[] = [];
  const autoArchivedKeys: string[] = [];
  for (const k of [...inactiveByProject.keys()].sort(compareSidebarGroupKeys)) {
    if (visibleDirKeys.has(k) || archivedDirectories.has(k)) continue;
    const exists = directoryExistsCache.get(k);
    if (exists === false) {
      autoArchivedKeys.push(k);
    } else {
      orphanInactiveKeys.push(k);
    }
  }

  const orphanGroups = orphanInactiveKeys.map((key) => {
    const allItems = inactiveByProject.get(key) ?? [];
    const sub = buildInactiveWorktreeSubgroups(allItems, key);
    const groupTotal = allItems.length;
    const autoCollapseGroup = !hasStoredAgentGroupCollapsePref &&
      (orphanInactiveKeys.length >= AUTO_COLLAPSE_PROJECT_THRESHOLD || groupTotal >= AUTO_COLLAPSE_PROJECT_SIZE);
    return {
      key,
      label: key ? key.split("/").filter(Boolean).at(-1) ?? key : "(unknown project)",
      title: key || undefined,
      collapsed: collapsedAgentSessionGroups.has(key) || autoCollapseGroup,
      total: groupTotal,
      items: sub.rootItems,
      worktrees: sub.worktrees,
    };
  });

  const orphanTotal = orphanGroups.reduce((acc, g) => acc + g.total, 0);

  // Build "Archived" section: explicitly archived directories + dirs that no longer exist on disk.
  const archivedKeys = [
    ...[...archivedDirectories].filter((k) => inactiveByProject.has(k)),
    ...autoArchivedKeys,
  ].sort(compareSidebarGroupKeys);

  const archivedGroups = archivedKeys.map((key) => {
    const allItems = inactiveByProject.get(key) ?? [];
    const sub = buildInactiveWorktreeSubgroups(allItems, key);
    const groupTotal = allItems.length;
    return {
      key,
      label: key ? key.split("/").filter(Boolean).at(-1) ?? key : "(unknown project)",
      title: key || undefined,
      collapsed: collapsedArchivedGroups.has(key),
      total: groupTotal,
      items: sub.rootItems,
      worktrees: sub.worktrees,
      archived: true as const,
    };
  });

  const archivedTotal = archivedGroups.reduce((acc, g) => acc + g.total, 0);
  const archivedAutoExpanded = !(
    archivedTotal >= AUTO_COLLAPSE_SECTION_TOTAL ||
    archivedGroups.length >= AUTO_COLLAPSE_PROJECT_THRESHOLD
  );
  const archivedExpanded = archivedSectionExpandedOverride ?? archivedAutoExpanded;

  const model: PtyListModel = {
    groups,
    showHeaders: allVisibleKeys.length >= 1,
    inactive: orphanTotal > 0
      ? {
        label: "Inactive",
        expanded: inactiveSessionsExpanded,
        total: orphanTotal,
        groups: orphanGroups,
      }
      : null,
    archived: archivedTotal > 0
      ? {
        label: "Archived",
        expanded: archivedExpanded,
        total: archivedTotal,
        groups: archivedGroups,
      }
      : null,
  };

  latestPtyListModel = model;
  renderPrContextBar();

  renderPtyList(listEl, model, {
    onToggleGroup: (groupKey) => {
      if (collapsedGroups.has(groupKey)) collapsedGroups.delete(groupKey);
      else collapsedGroups.add(groupKey);
      renderList();
    },
    onToggleWorktree: (groupKey, wtName) => {
      const key = `${groupKey}::${wtName}`;
      if (collapsedWorktrees.has(key)) collapsedWorktrees.delete(key);
      else collapsedWorktrees.add(key);
      renderList();
    },
    onTogglePin: (groupKey) => {
      if (pinnedDirectories.has(groupKey)) pinnedDirectories.delete(groupKey);
      else pinnedDirectories.add(groupKey);
      savePinnedDirectories();
      renderList();
    },
    onToggleInlineInactive: (groupKey) => {
      if (inlineInactiveExpanded.has(groupKey)) inlineInactiveExpanded.delete(groupKey);
      else inlineInactiveExpanded.add(groupKey);
      renderList();
    },
    onOpenReactivateProject: (groupKey) => openReactivateProjectModal(groupKey),
    onOpenLaunch: (groupKey) => openLaunchModal(groupKey),
    onOpenLaunchInWorktree: (groupKey, worktreePath) => openLaunchModal(groupKey, worktreePath),
    onSelectPty: (ptyId) => setActive(ptyId),
    onReorderPty: (sourcePtyId, targetPtyId, placement) => {
      reorderSidebarPty(sourcePtyId, targetPtyId, placement);
    },
    onTogglePrWaitingForReview: (ptyId) => {
      togglePrWaitingForReview(ptyId);
    },
    onRenamePty: (ptyId) => {
      void renamePty(ptyId);
    },
    onKillPty: (ptyId) => {
      killPty(ptyId);
    },
    onResumeInactive: (ptyId) => {
      openSessionPreviewModal(ptyId);
    },
    onInactiveActions: (ptyId) => {
      openAgentSessionActions(ptyId);
    },
    onToggleInactive: () => {
      inactiveSessionsExpanded = !inactiveSessionsExpanded;
      renderList();
    },
    onToggleInactiveGroup: (groupKey) => {
      if (collapsedAgentSessionGroups.has(groupKey)) collapsedAgentSessionGroups.delete(groupKey);
      else collapsedAgentSessionGroups.add(groupKey);
      hasStoredAgentGroupCollapsePref = true;
      saveCollapsedSet(AGENT_GROUPS_COLLAPSED_KEY, collapsedAgentSessionGroups);
      renderList();
    },
    onToggleInactiveWorktree: (groupKey, wtName) => {
      const key = `${groupKey}::${wtName}`;
      if (collapsedAgentSessionWorktrees.has(key)) collapsedAgentSessionWorktrees.delete(key);
      else collapsedAgentSessionWorktrees.add(key);
      hasStoredAgentWorktreeCollapsePref = true;
      saveCollapsedSet(AGENT_WORKTREES_COLLAPSED_KEY, collapsedAgentSessionWorktrees);
      renderList();
    },
    onArchive: (groupKey) => archiveDirectory(groupKey),
    onUnarchive: (groupKey) => unarchiveDirectory(groupKey),
    onToggleArchived: () => {
      archivedSectionExpandedOverride = !archivedExpanded;
      saveBooleanPreference(ARCHIVED_SECTION_EXPANDED_KEY, archivedSectionExpandedOverride);
      renderList();
    },
    onToggleArchivedGroup: (groupKey) => {
      if (collapsedArchivedGroups.has(groupKey)) collapsedArchivedGroups.delete(groupKey);
      else collapsedArchivedGroups.add(groupKey);
      saveCollapsedSet(ARCHIVED_GROUPS_COLLAPSED_KEY, collapsedArchivedGroups);
      renderList();
    },
    onToggleArchivedWorktree: (groupKey, wtName) => {
      const key = `${groupKey}::${wtName}`;
      if (collapsedArchivedWorktrees.has(key)) collapsedArchivedWorktrees.delete(key);
      else collapsedArchivedWorktrees.add(key);
      saveCollapsedSet(ARCHIVED_WORKTREES_COLLAPSED_KEY, collapsedArchivedWorktrees);
      renderList();
    },
    onShowMore: (_contextKey) => {
      // Pagination state is managed in pty-list-view; just re-render.
      renderList();
    },
  });
  renderMobileViewState();
}

function focusActiveTerm(): void {
  if (mobileViewport) return;
  const st = activePtyId ? terms.get(activePtyId) : null;
  if (st?.opened) st.term.focus();
}

function setActive(ptyId: string): void {
  const summary = ptys.find((p) => p.id === ptyId);
  if (!summary || summary.status !== "running") {
    pendingActivePtyId = ptyId;
    return;
  }
  pendingActivePtyId = null;

  activePtyId = ptyId;
  unviewedReadyPtys.delete(ptyId);
  // Viewing a session clears its PR new-comment marker (optimistic + durable).
  if (summary.pr?.hasNewComments) {
    summary.pr.hasNewComments = false;
    void authFetch("/api/azure-pr/viewed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ptyId }),
    }).catch(() => {});
  }
  saveActivePty(ptyId);
  ensureTerm(ptyId);
  updateTerminalVisibility();
  updateKickButtonVisibility();
  requestAnimationFrame(() => {
    fitAndResizeActive();
    reflowActiveTerm();
    focusActiveTerm();
  });
  syncProviderHistoryStateWithPtys();
  renderList();
  renderInputContextBar();
}

function highlight(ptyId: string, ttlMs: number): void {
  const el = listEl.querySelector(`[data-pty-id="${ptyId}"]`) as HTMLElement | null;
  if (!el) return;
  el.classList.add("highlight");
  setTimeout(() => el.classList.remove("highlight"), ttlMs);
}

async function newShell(): Promise<void> {
  const res = await authFetch("/api/ptys/shell", { method: "POST" });
  if (!res.ok) {
    addEvent(`Failed to create PTY: ${await readApiError(res)}`);
    return;
  }
  const json = (await res.json()) as { id: string };
  addEvent(`Created PTY ${json.id}`);
  await refreshList();
  refreshTmuxSessions().catch(() => {});
  setActive(json.id);
}

async function attachTmuxSession(selected: TmuxSessionInfo): Promise<void> {
  const existing = ptys.find(
    (p) =>
      p.status === "running" &&
      p.backend === "tmux" &&
      (p.tmuxServer ?? "agmux") === selected.server &&
      ((p.tmuxSession ?? "") === selected.name ||
        (p.tmuxSession ?? "").startsWith(selected.name + ":")),
  );
  if (existing) {
    addEvent(`Using existing tmux ${selected.name}`);
    setActive(existing.id);
    return;
  }
  const res = await authFetch("/api/ptys/attach-tmux", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ name: selected.name, server: selected.server }),
  });
  if (!res.ok) {
    addEvent(`Failed to attach tmux ${selected.name}: ${await readApiError(res)}`);
    return;
  }
  const json = (await res.json()) as { id: string };
  addEvent(`Attached tmux ${selected.name}`);
  await refreshList();
  setActive(json.id);
}

btnNew.addEventListener("click", () => {
  newShell().catch(() => {
    // ignore
  });
});

btnFollow.addEventListener("click", () => {
  scrollActiveTerminalToBottom();
});

btnKickOthers.addEventListener("click", () => {
  if (!activePtyId) return;
  // Disconnect other WS subscribers viewing the same PTY
  sendWsMessage({ type: "kick_other_subscribers", ptyId: activePtyId });
  // Kill other PTYs sharing the same tmux session (the cross-device case)
  for (const p of sameSessionPtys()) {
    void killPtyDirect(p.id);
  }
  // Re-assert our terminal size
  requestAnimationFrame(() => fitAndResizeActive());
});


function toggleInputHistory(): void {
  if (!activePtyId) return;
  inputHistoryExpanded = !inputHistoryExpanded;
  renderInputContextBar();
}

inputContextToggleEl.addEventListener("click", () => {
  toggleInputHistory();
});

inputContextToggleEl.addEventListener("keydown", (ev) => {
  if ((ev.target as Element | null)?.closest("button")) return;
  if (ev.key !== "Enter" && ev.key !== " ") return;
  ev.preventDefault();
  toggleInputHistory();
});

type EmacsWorktreeAction = {
  busy: () => boolean;
  setBusy: (busy: boolean) => void;
  route: string;
  successLabel: string;
  failureLabel: string;
};

async function openActiveEmacsWorktreeAction(action: EmacsWorktreeAction): Promise<void> {
  if (!activePtyId || action.busy()) return;
  const ptyId = activePtyId;
  action.setBusy(true);
  renderInputContextBar();
  try {
    const res = await authFetch(`/api/ptys/${encodeURIComponent(ptyId)}/${action.route}`, { method: "POST" });
    if (!res.ok) {
      addEvent(`Failed to open ${action.failureLabel}: ${await readApiError(res)}`);
      return;
    }
    const json = (await res.json()) as { path?: string };
    addEvent(`Opened ${action.successLabel}${json.path ? `: ${json.path}` : ""}`);
  } catch (err) {
    addEvent(`Failed to open ${action.failureLabel}: ${errorMessage(err)}`);
  } finally {
    action.setBusy(false);
    renderInputContextBar();
    focusActiveTerm();
  }
}

btnBranchReview.addEventListener("click", (ev) => {
  ev.preventDefault();
  ev.stopPropagation();
  void openActiveEmacsWorktreeAction({
    busy: () => branchReviewOpening,
    setBusy: (busy) => {
      branchReviewOpening = busy;
    },
    route: "open-branch-review",
    successLabel: "branch review",
    failureLabel: "branch review",
  });
});

btnMagit.addEventListener("click", (ev) => {
  ev.preventDefault();
  ev.stopPropagation();
  void openActiveEmacsWorktreeAction({
    busy: () => magitOpening,
    setBusy: (busy) => {
      magitOpening = busy;
    },
    route: "open-magit",
    successLabel: "Magit",
    failureLabel: "Magit",
  });
});

function subscribeIfNeeded(ptyId: string): void {
  if (subscribed.has(ptyId)) return;
  subscribed.add(ptyId);
  sendWsMessage({ type: "subscribe", ptyId });
}

function termIsScrolledUp(term: Terminal): boolean {
  const b = term.buffer.active as unknown as { baseY?: unknown; viewportY?: unknown; length: number };
  const baseY = typeof b.baseY === "number" ? b.baseY : Math.max(0, b.length - term.rows);
  const viewportY = typeof b.viewportY === "number" ? b.viewportY : baseY;
  return viewportY < baseY;
}

function activeTermIsScrolledUp(): boolean {
  if (!activePtyId) return false;
  const st = terms.get(activePtyId);
  if (!st) return false;
  return termIsScrolledUp(st.term);
}

function updateFollowButtonVisibility(): void {
  const visible = !mobileViewport && activeTermIsScrolledUp();
  btnFollow.classList.toggle("visible", visible);
}

function scrollActiveTerminalToBottom(): void {
  if (!activePtyId) return;
  const st = terms.get(activePtyId);
  if (!st) return;
  st.term.scrollToBottom();
  updateFollowButtonVisibility();
  if (mobileViewport) scheduleMobileRender();
}

// Terminal scrollback lives in tmux, not the local xterm buffer. The server
// resolves the entry to a pane line — submit-time anchors matched by ts,
// refined by locating the prompt echo — and drives tmux copy-mode there.
// Best-effort: a no-op if the text has scrolled out of tmux history.
function scrollActiveTerminalToHistory(entry: HistoryEntry): void {
  if (!activePtyId) return;
  sendWsMessage({
    type: "history_scroll_to",
    ptyId: activePtyId,
    text: entry.text,
    ...(entry.ts > 0 ? { ts: entry.ts } : {}),
  });
}

function termBufferHasRenderableText(st: TermState, maxLines = 400): boolean {
  const buf = st.term.buffer.active;
  const start = Math.max(0, buf.length - maxLines);
  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    if (line.translateToString(true).trim().length > 0) return true;
  }
  return false;
}

function refreshTermViewport(st: TermState): void {
  if (st.term.rows <= 0) return;
  st.term.refresh(0, st.term.rows - 1);
}

// Force xterm.js to reflow the active terminal buffer.  A plain refresh()
// only re-renders the viewport without recalculating line wrapping, which
// leaves garbled output after reconnects and resizes.  Scrolling by +1/−1
// triggers a full reflow just like a manual wheel scroll.
function reflowActiveTerm(): void {
  if (!activePtyId) return;
  const st = terms.get(activePtyId);
  if (!st) return;
  st.term.scrollLines(-1);
  st.term.scrollLines(1);
  refreshTermViewport(st);
}

// Debounced reflow: coalesces multiple writes within a single frame into one
// reflow.  Called after pty_output writes so that snapshots arriving after
// reconnect (which land after the initial setActive reflow) still get reflowed.
let reflowRafPending = false;
function scheduleReflow(): void {
  if (reflowRafPending) return;
  reflowRafPending = true;
  requestAnimationFrame(() => {
    reflowRafPending = false;
    reflowActiveTerm();
  });
}

function updateTerminalVisibility(): void {
  const hasActive = Boolean(activePtyId);
  placeholderEl.classList.toggle("hidden", hasActive);
  if (!hasActive) {
    const hasAny = ptys.some((p) => p.status === "running");
    placeholderEl.textContent = hasAny ? "select a PTY" : "No sessions — click New PTY to start";
  }
  syncProviderHistoryStateWithPtys();
  updateFollowButtonVisibility();
  renderInputContextBar();
  for (const [ptyId, st] of terms.entries()) {
    st.container.classList.toggle("hidden", !hasActive || ptyId !== activePtyId);
  }
}

function fitAndResizeActive(): void {
  if (!activePtyId) return;
  // On mobile, reparenting handles fit; skip if term is in hidden desktop container
  if (mobileViewport && mobileReparentedPtyId !== activePtyId) return;
  const st = terms.get(activePtyId);
  if (!st) return;
  if (!st.opened) {
    st.term.open(st.container);
    st.opened = true;
  }

  st.fit.fit();

  const cols = st.term.cols;
  const rows = st.term.rows;
  if (cols <= 0 || rows <= 0) return;
  const sizeChanged = !st.lastResize || st.lastResize.cols !== cols || st.lastResize.rows !== rows;
  if (sizeChanged) {
    st.lastResize = { cols, rows };
    queueResize(activePtyId, cols, rows);
  }
  // First subscribe only after we have a concrete fitted size. This avoids
  // tmux snapshot/output replay being wrapped to stale/default dimensions.
  subscribeIfNeeded(activePtyId);
  maybeHydrateActiveDesktopTerm();
}

function maybeHydrateActiveDesktopTerm(): void {
  if (mobileViewport || !activePtyId) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const summary = ptys.find((p) => p.id === activePtyId);
  if (!summary || summary.status !== "running" || summary.backend !== "tmux") return;
  const st = terms.get(activePtyId);
  if (!st) return;
  if (termBufferHasRenderableText(st)) return;
  if (desktopHydrationPending?.ptyId === activePtyId) return;

  const requestId = `desktop-hydration-${Date.now()}-${activePtyId}`;
  desktopHydrationPending = { requestId, ptyId: activePtyId };
  sendWsMessage({
    type: "mobile_snapshot_request",
    requestId,
    ptyId: activePtyId,
    lines: DESKTOP_TMUX_HYDRATION_LINES,
  });
}

const ro = new ResizeObserver(() => {
  requestAnimationFrame(() => { fitAndResizeActive(); reflowActiveTerm(); });
});
ro.observe(terminalEl);
window.addEventListener("resize", () => {
  syncSidebarWidthToViewport();
  fitAndResizeActive();
  reflowActiveTerm();
});

// --- Keybindings ---

function runningPtys(): PtySummary[] {
  pruneSidebarPtyOrder();
  return orderRunningPtysForSidebar(ptys, {
    pinnedDirectories,
    getGroupKey: runningPtyGroupKey,
    manualOrder: sidebarPtyOrder,
  });
}

function ptyVisibleForDesktopCycling(pty: PtySummary): boolean {
  if (mobileViewport) return true;
  return !collapsedGroups.has(runningPtyGroupKey(pty));
}

function switchPtyByOffset(offset: number): void {
  const running = runningPtys();
  const next = findRunningPtyByOffset(running, activePtyId, offset, {
    isVisible: ptyVisibleForDesktopCycling,
  });
  if (!next) return;
  setActive(next.id);
}

function switchToNextReady(): void {
  const running = runningPtys();
  const next = findNextReadyRunningPty(running, activePtyId, {
    isVisible: ptyVisibleForDesktopCycling,
    isReady: (candidate) => ptyReady.get(candidate.id)?.state === "ready",
  });
  if (!next) return;
  setActive(next.id);
}

document.addEventListener(
  "keydown",
  (ev: KeyboardEvent) => {
    if (!ev.ctrlKey || !ev.shiftKey || ev.altKey || ev.metaKey) return;
    switch (ev.code) {
      case "Backslash":
        ev.preventDefault();
        ev.stopPropagation();
        toggleSidebar();
        return;
      case "BracketRight":
        ev.preventDefault();
        ev.stopPropagation();
        switchPtyByOffset(1);
        return;
      case "BracketLeft":
        ev.preventDefault();
        ev.stopPropagation();
        switchPtyByOffset(-1);
        return;
      case "Backquote":
        ev.preventDefault();
        ev.stopPropagation();
        newShell().catch(() => {});
        return;
      case "KeyQ":
        ev.preventDefault();
        ev.stopPropagation();
        if (activePtyId) killPty(activePtyId);
        return;
      case "Space":
        ev.preventDefault();
        ev.stopPropagation();
        switchToNextReady();
        return;
    }
  },
  { capture: true },
);

// --- Keybindings popup ---

const btnKeys = $("btn-keys") as HTMLButtonElement;

const keysBackdrop = document.createElement("div");
keysBackdrop.className = "keys-backdrop hidden";
document.body.appendChild(keysBackdrop);

const keysPopup = document.createElement("div");
keysPopup.className = "keys-popup hidden";
keysPopup.innerHTML = `
  <div class="keys-popup-title">Keybindings</div>
  <table>
    <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>\`</kbd></td><td>New shell</td></tr>
    <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Q</kbd></td><td>Close PTY</td></tr>
    <tr><td>Select text</td><td>Copy to clipboard</td></tr>
    <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>\\</kbd></td><td>Toggle sidebar</td></tr>
    <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>]</kbd></td><td>Next PTY</td></tr>
    <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>[</kbd></td><td>Previous PTY</td></tr>
    <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd></td><td>Next ready PTY</td></tr>
  </table>`;
document.body.appendChild(keysPopup);

function toggleKeysPopup(): void {
  const show = keysPopup.classList.contains("hidden");
  keysPopup.classList.toggle("hidden", !show);
  keysBackdrop.classList.toggle("hidden", !show);
}

btnKeys.addEventListener("click", toggleKeysPopup);
keysBackdrop.addEventListener("click", toggleKeysPopup);
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !keysPopup.classList.contains("hidden")) {
    toggleKeysPopup();
  }
});

// --- Settings modal ---

const DEFAULT_WORKTREE_TEMPLATE = "../{repo-name}-{branch}";

const settingsModalRoot = document.createElement("div");
document.body.appendChild(settingsModalRoot);

type SettingsModalState = {
  worktreePathTemplate: string;
  saving: boolean;
  dirty: boolean;
};

let settingsModalState: SettingsModalState | null = null;
let settingsModalSeq = 0;

function settingsPreviewPath(template: string): string {
  const t = template || DEFAULT_WORKTREE_TEMPLATE;
  const repoName = serverRepoRoot ? serverRepoRoot.split("/").pop() ?? "repo" : "repo";
  return t
    .replace(/\{repo-name\}/g, repoName)
    .replace(/\{repo-root\}/g, serverRepoRoot || "/path/to/repo")
    .replace(/\{branch\}/g, "feature-example");
}

function systemThemeDescription(): string {
  if (!useSystemTheme) return "";
  const resolvedThemeName = THEMES.get(activeThemeKey)?.name ?? activeTheme.name;
  return `System theme is ${systemThemeMedia.matches ? "dark" : "light"}, using ${resolvedThemeName}.`;
}

function renderSettingsModalState(): void {
  const state = settingsModalState;
  const themeOptions = useSystemTheme
    ? [...SYSTEM_THEME_DARK_TO_LIGHT.keys()].map((key) => ({
      key,
      name: THEMES.get(key)?.name ?? key,
    }))
    : [...THEMES].map(([key, theme]) => ({ key, name: theme.name }));
  const tmuxOptions = tmuxSessions.map((session) => ({
    key: tmuxSessionKey(session),
    label: tmuxSessionLabel(session),
  }));
  if (tmuxOptions.length === 0) {
    tmuxOptions.push({ key: "", label: "(no tmux sessions)" });
  }
  const model: SettingsModalViewModel | null = state
    ? {
      worktreePathTemplate: state.worktreePathTemplate,
      previewPath: settingsPreviewPath(state.worktreePathTemplate),
      saving: state.saving,
      themeKey: useSystemTheme ? systemThemeDarkKey : selectedThemeKey,
      themes: themeOptions,
      useSystemTheme,
      systemThemeDescription: systemThemeDescription(),
      tmuxSessionKey: tmuxOptions.some((opt) => opt.key === selectedTmuxSessionKey) ? selectedTmuxSessionKey : "",
      tmuxSessions: tmuxOptions,
    }
    : null;

  renderSettingsModal(settingsModalRoot, model, {
    onClose: () => {
      settingsModalState = null;
      renderSettingsModalState();
    },
    onTemplateChange: (value) => {
      if (!settingsModalState) return;
      settingsModalState.worktreePathTemplate = value;
      settingsModalState.dirty = true;
      renderSettingsModalState();
    },
    onReset: () => {
      if (!settingsModalState) return;
      settingsModalState.worktreePathTemplate = "";
      settingsModalState.dirty = true;
      renderSettingsModalState();
    },
    onThemeChange: (key) => {
      setTheme(key);
    },
    onUseSystemThemeChange: (enabled) => {
      setUseSystemTheme(enabled);
    },
    onTmuxSessionChange: (key) => {
      selectedTmuxSessionKey = key;
      renderSettingsModalState();
      const selected = selectedTmuxSession();
      if (!selected) return;
      checkSelectedTmuxSessionAndMaybeWarn()
        .then(() => attachTmuxSession(selected))
        .catch((err) => {
          addEvent(`Attach tmux failed: ${errorMessage(err)}`);
        });
    },
    onTmuxSessionFocus: () => {
      refreshTmuxSessions().catch((err) => {
        addEvent(`Failed to refresh tmux sessions: ${errorMessage(err)}`);
      });
    },
    onSave: () => {
      if (!settingsModalState || settingsModalState.saving) return;
      settingsModalState.saving = true;
      renderSettingsModalState();
      const template = settingsModalState.worktreePathTemplate.trim() || null;
      void authFetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worktreePathTemplate: template }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(await readApiError(res));
          settingsModalState = null;
          renderSettingsModalState();
        })
        .catch((err) => {
          if (!settingsModalState) return;
          settingsModalState.saving = false;
          renderSettingsModalState();
          window.alert(errorMessage(err));
        });
    },
  });
}

function openSettingsModal(): void {
  const seq = ++settingsModalSeq;
  settingsModalState = {
    worktreePathTemplate: "",
    saving: false,
    dirty: false,
  };
  renderSettingsModalState();
  void refreshTmuxSessions().catch(() => {});

  void authFetch("/api/settings")
    .then(async (res) => {
      if (!res.ok || !settingsModalState || seq !== settingsModalSeq || settingsModalState.dirty) return;
      const data = (await res.json()) as { worktreePathTemplate?: string };
      settingsModalState.worktreePathTemplate = data.worktreePathTemplate ?? "";
      renderSettingsModalState();
    })
    .catch(() => {});
}

const btnSettings = $("btn-settings") as HTMLButtonElement;
btnSettings.addEventListener("click", () => openSettingsModal());

void (async () => {
  let authed = false;
  try {
    await ensureAuthToken();
    authed = true;
    await Promise.all([loadPtyInputMeta(), refreshWorktreeCache()]);
    connectWs();
    btnNew.disabled = false;
    await refreshTmuxSessions();
  } catch (err) {
    addEvent(`Failed to initialize session: ${errorMessage(err)}`);
  }
  if (!authed) return;
  await refreshList();

  // Restore previously active PTY for this browser tab.
  if (!activePtyId) {
    const saved = loadSavedActivePty();
    if (saved) {
      const running = ptys.filter((p) => p.status === "running");
      const target =
        running.find((p) => p.id === saved.ptyId) ??
        (saved.tmuxSession
          ? running.find(
            (p) =>
              p.backend === "tmux" &&
              (saved.tmuxServer ? p.tmuxServer === saved.tmuxServer : true) &&
              (p.tmuxSession === saved.tmuxSession ||
                (p.tmuxSession ?? "").startsWith(saved.tmuxSession + ":") ||
                saved.tmuxSession.startsWith((p.tmuxSession ?? "") + ":")),
          )
          : null);
      if (target) setActive(target.id);
    }
  }
})();

const LIST_REFRESH_CONNECTED_ACTIVE_MS = 30_000;
const LIST_REFRESH_CONNECTED_IDLE_MS = 60_000;
const LIST_REFRESH_DISCONNECTED_ACTIVE_MS = 5000;
const LIST_REFRESH_DISCONNECTED_IDLE_MS = 15_000;
const LIST_REFRESH_HIDDEN_MS = 60_000;
let listRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function listRefreshInterval(): number {
  if (document.hidden) return LIST_REFRESH_HIDDEN_MS;
  const running = ptys.some((p) => p.status === "running");
  if (wsConnected) {
    return running ? LIST_REFRESH_CONNECTED_ACTIVE_MS : LIST_REFRESH_CONNECTED_IDLE_MS;
  }
  return running ? LIST_REFRESH_DISCONNECTED_ACTIVE_MS : LIST_REFRESH_DISCONNECTED_IDLE_MS;
}

function scheduleListRefresh(immediate = false): void {
  if (listRefreshTimer) return;
  const delay = immediate ? 0 : listRefreshInterval();
  listRefreshTimer = setTimeout(async () => {
    listRefreshTimer = null;
    await refreshList();
    scheduleListRefresh();
  }, delay);
}

document.addEventListener("visibilitychange", () => {
  if (listRefreshTimer) {
    clearTimeout(listRefreshTimer);
    listRefreshTimer = null;
  }
  scheduleListRefresh();
});

// Refresh sidebar on a slower, adaptive cadence to reduce idle network traffic.
scheduleListRefresh(true);

// Minimal debug hooks for e2e tests and local inspection.
function dumpBuffer(st: TermState, maxLines = 120): string {
  const out: string[] = [];
  const buf = st.term.buffer.active;
  const start = Math.max(0, buf.length - maxLines);
  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    out.push(line.translateToString(true));
  }
  return out.join("\n");
}

(window as any).__agmux = {
  activePtyId: () => activePtyId,
  cleanupCopiedTerminalText,
  dumpActive: () => {
    if (!activePtyId) return "";
    const st = terms.get(activePtyId);
    if (!st) return "";
    return dumpBuffer(st);
  },
  bufferActiveInfo: () => {
    if (!activePtyId) return { baseY: 0, viewportY: 0, length: 0, rows: 0 };
    const st = terms.get(activePtyId);
    if (!st) return { baseY: 0, viewportY: 0, length: 0, rows: 0 };
    const b = st.term.buffer.active;
    const rawBaseY = (b as unknown as { baseY?: unknown }).baseY;
    const rawViewportY = (b as unknown as { viewportY?: unknown }).viewportY;
    const baseY = typeof rawBaseY === "number" ? rawBaseY : Math.max(0, b.length - st.term.rows);
    const viewportY = typeof rawViewportY === "number" ? rawViewportY : baseY;
    return {
      baseY,
      viewportY,
      length: b.length,
      rows: st.term.rows,
    };
  },
  dumpViewport: () => {
    if (!activePtyId) return "";
    const st = terms.get(activePtyId);
    if (!st) return "";
    const buf = st.term.buffer.active;
    const rawViewportY = (buf as unknown as { viewportY?: unknown }).viewportY;
    const start = typeof rawViewportY === "number" ? rawViewportY : Math.max(0, buf.length - st.term.rows);
    const end = start + st.term.rows;
    const lines: string[] = [];
    for (let i = start; i < end; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      lines.push(line.translateToString(true));
    }
    return lines.join("\n");
  },
  scrollToBottomActive: () => {
    scrollActiveTerminalToBottom();
  },
  sendInput: (data: string) => {
    if (!activePtyId) return;
    trackUserInput(activePtyId, data);
    sendWsMessage({ type: "input", ptyId: activePtyId, data });
  },
};
