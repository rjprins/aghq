import { Fragment, render } from "preact";
import type {
  OrphanBranch,
  WorktreeAnnotated,
  WorktreesFullResponse,
  WorktreeTombstone,
} from "../shared/worktrees.js";
import { rowMatchesFilter } from "./worktree-filter.js";

export type WorktreesPanelViewModel = {
  projectRoot: string;
  data: WorktreesFullResponse | null;
  loading: boolean;
  error: string | null;
  filter: string;
  expandedPath: string | null;
  expandedStacks: ReadonlySet<string>;
  orphansExpanded: boolean;
  tombstonesExpanded: boolean;
  busyPaths: ReadonlySet<string>;
  rowErrors: ReadonlyMap<string, string>;
  labelDrafts: ReadonlyMap<string, string>;
  rescanning: boolean;
  reapAll: { total: number; done: number; freedBytes: number; failures: number } | null;
};

export type WorktreesPanelHandlers = {
  onClose: () => void;
  onFilterChange: (value: string) => void;
  onRescan: () => void;
  onReapAllSafe: () => void;
  onToggleRow: (path: string) => void;
  onToggleStack: (sectionKey: string, stack: string) => void;
  onToggleOrphans: () => void;
  onToggleTombstones: () => void;
  onLabelDraftChange: (path: string, value: string) => void;
  onLabelSave: (path: string) => void;
  onReap: (path: string, opts: { salvage: boolean }) => void;
  onMoveCanonical: (path: string) => void;
  onDropBranch: (branch: string) => void;
};

// Fixed section order per the worktree-management design.
const SECTIONS: Array<{ key: string; label: string }> = [
  { key: "active", label: "Active" },
  { key: "open", label: "Open" },
  { key: "local-only", label: "Local-only" },
  { key: "review", label: "Review" },
  { key: "stale", label: "Stale" },
  { key: "ephemeral", label: "Ephemeral" },
  { key: "unknown", label: "Unknown" },
  { key: "reap-check", label: "Reap — check first" },
  { key: "reapable", label: "Reapable" },
];

function sectionForRow(w: WorktreeAnnotated): string {
  if (w.reapClass === "reap-safe") return "reapable";
  if (w.reapClass === "reap-check") return "reap-check";
  switch (w.state) {
    case "active":
      return "active";
    case "open":
      return "open";
    case "local-only":
      return "local-only";
    case "review":
      return "review";
    case "stale":
      return "stale";
    case "ephemeral":
      return "ephemeral";
    case "merged":
      // Merged rows normally carry a reapClass; be conservative if not.
      return "reap-check";
    default:
      return "unknown";
  }
}

export function formatBytesShort(n: number): string {
  if (n >= 950 * 1024 * 1024) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

// Same short format as app.ts formatElapsedTime (not exported there).
function relTime(sinceMs: number | null): string {
  if (!sinceMs) return "";
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

function isoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function basename(p: string): string {
  return p.split("/").filter(Boolean).at(-1) ?? p;
}

function truncate(s: string, max = 90): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

type SectionItem =
  | { type: "row"; row: WorktreeAnnotated }
  | { type: "stack"; stack: string; rows: WorktreeAnnotated[] };

function buildSectionItems(rows: WorktreeAnnotated[]): SectionItem[] {
  const sorted = [...rows].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  const items: SectionItem[] = [];
  const emittedStacks = new Set<string>();
  for (const row of sorted) {
    if (row.stack) {
      if (emittedStacks.has(row.stack)) continue;
      emittedStacks.add(row.stack);
      const stackRows = sorted.filter((r) => r.stack === row.stack);
      // A stack that ended up alone in this section reads better as a plain row.
      if (stackRows.length === 1) items.push({ type: "row", row });
      else items.push({ type: "stack", stack: row.stack, rows: stackRows });
    } else {
      items.push({ type: "row", row });
    }
  }
  return items;
}

function OverlayBadges({ row }: { row: WorktreeAnnotated }) {
  const o = row.overlays;
  const badges: Array<{ cls: string; text: string; title: string }> = [];
  if (o.dirty) badges.push({ cls: "dirty", text: "dirty", title: "Uncommitted changes" });
  if (!o.dirty && o.ignoredOnly) {
    badges.push({ cls: "ignored", text: "ignored-only", title: "Only gitignored files present (e.g. .venv)" });
  }
  if (o.unpushedCount != null && o.unpushedCount > 0) {
    badges.push({ cls: "unpushed", text: `unpushed:${o.unpushedCount}`, title: "Commits not on the upstream" });
  }
  if (o.drifted) badges.push({ cls: "drift", text: "drift", title: "Directory name does not match branch name" });
  if (o.offConvention) {
    badges.push({ cls: "drift", text: "off-convention", title: "Path does not match the worktree template" });
  }
  if (o.neverPushed) badges.push({ cls: "never-pushed", text: "never-pushed", title: "Branch never had an upstream" });
  return (
    <>
      {badges.map((b) => (
        <span key={b.text} className={`wt-badge ${b.cls}`} title={b.title}>
          {b.text}
        </span>
      ))}
    </>
  );
}

function WorktreeRow(
  { row, model, handlers }: { row: WorktreeAnnotated; model: WorktreesPanelViewModel; handlers: WorktreesPanelHandlers },
) {
  const expanded = model.expandedPath === row.path;
  const busy = model.busyPaths.has(row.path);
  const rowError = model.rowErrors.get(row.path);
  const context = row.label ?? row.prTitle ?? row.firstPrompt;
  const displayName = row.branch || `${row.name} (detached)`;
  const canMove = row.overlays.drifted || row.overlays.offConvention;
  const labelDraft = model.labelDrafts.get(row.path) ?? row.label ?? "";
  const headMissing = row.head == null;

  return (
    <div
      className={`wt-row${expanded ? " expanded" : ""}`}
      onClick={() => handlers.onToggleRow(row.path)}
    >
      <div className="wt-row-main">
        <span className="wt-branch" title={row.path}>
          {displayName}
          {row.overlays.drifted && row.branch ? <span className="wt-dir-drift"> ({basename(row.path)})</span> : null}
        </span>
        <span className={`wt-badge state state-${row.state}`}>{row.state}</span>
        <OverlayBadges row={row} />
        <span className="wt-row-meta">
          {row.lastActivityAt ? <span title={new Date(row.lastActivityAt).toLocaleString()}>{relTime(row.lastActivityAt)}</span> : null}
          {row.diskBytes != null ? <span title="Disk usage">{formatBytesShort(row.diskBytes)}</span> : null}
          {row.sessionCount > 0 ? (
            <span title={`${row.sessionCount} recorded agent session(s)${row.liveSessionCount > 0 ? `, ${row.liveSessionCount} live` : ""}`}>
              {row.sessionCount} sess{row.liveSessionCount > 0 ? ` (${row.liveSessionCount} live)` : ""}
            </span>
          ) : null}
        </span>
      </div>
      {context ? <div className="wt-context">{truncate(context)}</div> : null}
      {expanded ? (
        <div className="wt-details" onClick={(ev) => ev.stopPropagation()}>
          <div className="wt-evidence">{row.evidence || "(no evidence recorded)"}</div>
          <div className="wt-path"><code>{row.path}</code></div>
          {row.prId ? (
            <div className="wt-pr-line">
              PR !{row.prId}
              {row.prTitle ? ` — ${row.prTitle}` : ""}
              {row.prStatus ? ` (${row.prStatus})` : ""}
            </div>
          ) : null}
          <div className="wt-label-edit">
            <input
              type="text"
              className="launch-modal-input"
              placeholder="Label…"
              value={labelDraft}
              onInput={(ev) => handlers.onLabelDraftChange(row.path, (ev.target as HTMLInputElement).value)}
            />
            <button
              type="button"
              disabled={busy || labelDraft === (row.label ?? "")}
              onClick={() => handlers.onLabelSave(row.path)}
            >
              Save label
            </button>
          </div>
          {row.reapClass === "reap-check" && row.overlays.dirty ? (
            <div className="wt-salvage-note">
              Uncommitted changes will be archived to the attic (tarball) before removal.
            </div>
          ) : null}
          <div className="wt-actions">
            {row.reapClass === "reap-safe" ? (
              <button
                type="button"
                className="close-wt-danger"
                disabled={busy || headMissing}
                title={headMissing ? "No HEAD recorded — rescan first" : "Remove this worktree"}
                onClick={() => handlers.onReap(row.path, { salvage: false })}
              >
                {busy ? "Reaping…" : "Reap"}
              </button>
            ) : null}
            {row.reapClass === "reap-check" ? (
              <button
                type="button"
                className="close-wt-danger"
                disabled={busy || headMissing}
                title={headMissing ? "No HEAD recorded — rescan first" : "Salvage uncommitted changes, then remove"}
                onClick={() => handlers.onReap(row.path, { salvage: true })}
              >
                {busy ? "Reaping…" : "Reap with salvage"}
              </button>
            ) : null}
            {canMove ? (
              <button
                type="button"
                disabled={busy}
                title="git worktree move to the canonical template path"
                onClick={() => handlers.onMoveCanonical(row.path)}
              >
                {busy ? "Working…" : "Move to canonical path"}
              </button>
            ) : null}
          </div>
          {rowError ? <div className="wt-error">{rowError}</div> : null}
        </div>
      ) : rowError ? (
        <div className="wt-error">{rowError}</div>
      ) : null}
    </div>
  );
}

function OrphanBranchRow(
  { orphan, model, handlers }: { orphan: OrphanBranch; model: WorktreesPanelViewModel; handlers: WorktreesPanelHandlers },
) {
  const key = `branch:${orphan.branch}`;
  const busy = model.busyPaths.has(key);
  const err = model.rowErrors.get(key);
  return (
    <div className="wt-row orphan">
      <div className="wt-row-main">
        <span className="wt-branch">{orphan.branch}</span>
        {orphan.mergedIntoDefault ? <span className="wt-badge state state-merged">merged</span> : null}
        {orphan.upstreamGone ? <span className="wt-badge">upstream gone</span> : null}
        {orphan.neverPushed ? <span className="wt-badge never-pushed">never-pushed</span> : null}
        <span className="wt-row-meta">
          {orphan.lastCommitAt ? <span title={new Date(orphan.lastCommitAt).toLocaleString()}>{relTime(orphan.lastCommitAt)}</span> : null}
        </span>
        <button
          type="button"
          disabled={busy}
          title="Attic-tag then delete this branch"
          onClick={() => handlers.onDropBranch(orphan.branch)}
        >
          {busy ? "Dropping…" : "Drop"}
        </button>
      </div>
      {err ? <div className="wt-error">{err}</div> : null}
    </div>
  );
}

function TombstoneRow({ t }: { t: WorktreeTombstone }) {
  const context = t.label ?? t.prTitle ?? t.firstPrompt;
  return (
    <div className="wt-row tombstone">
      <div className="wt-row-main">
        <span className="wt-branch">{t.branch || basename(t.path)}</span>
        <span className="wt-row-meta">
          <span title={new Date(t.reapedAt).toLocaleString()}>reaped {isoDate(t.reapedAt)}</span>
        </span>
      </div>
      {context ? <div className="wt-context">{truncate(context)}</div> : null}
      {t.reapEvidence ? <div className="wt-evidence">{t.reapEvidence}</div> : null}
      {t.salvagePath ? <div className="wt-path">salvage: <code>{t.salvagePath}</code></div> : null}
      {t.atticTag ? <div className="wt-path">tag: <code>{t.atticTag}</code></div> : null}
    </div>
  );
}

export function renderWorktreesPanel(
  root: Element,
  model: WorktreesPanelViewModel | null,
  handlers: WorktreesPanelHandlers,
): void {
  if (!model) {
    render(null, root);
    return;
  }

  const q = model.filter.trim().toLowerCase();
  const rows = (model.data?.worktrees ?? []).filter((w) => rowMatchesFilter(w, q));
  const bySection = new Map<string, WorktreeAnnotated[]>();
  for (const row of rows) {
    const key = sectionForRow(row);
    const list = bySection.get(key);
    if (list) list.push(row);
    else bySection.set(key, [row]);
  }

  // Scope the batch button to the visible (filtered) rows so off-screen rows are never reaped.
  const safeRows = (model.data?.worktrees ?? []).filter(
    (w) => w.reapClass === "reap-safe" && rowMatchesFilter(w, q),
  );
  const safeBytes = safeRows.reduce((acc, w) => acc + (w.diskBytes ?? 0), 0);
  const orphans = model.data?.orphanBranches ?? [];
  const tombstones = model.data?.tombstones ?? [];
  const repoName = model.data ? basename(model.data.repoRoot) : basename(model.projectRoot);
  const progress = model.reapAll;
  const reapBatchRunning = progress != null && progress.done < progress.total;

  render(
    <div
      className="launch-modal-overlay"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) handlers.onClose();
      }}
    >
      <div
        className="launch-modal worktrees-panel"
        tabIndex={-1}
        ref={(el) => {
          if (el && el !== document.activeElement && !el.contains(document.activeElement)) el.focus();
        }}
        onKeyDown={(ev) => {
          if (ev.key === "Escape") {
            ev.preventDefault();
            handlers.onClose();
          }
        }}
      >
        <div className="worktrees-panel-header">
          <h3>Worktrees — {repoName}</h3>
          <input
            type="text"
            className="launch-modal-input worktrees-filter"
            placeholder="Filter…"
            value={model.filter}
            onInput={(ev) => handlers.onFilterChange((ev.target as HTMLInputElement).value)}
          />
          <button
            type="button"
            disabled={model.rescanning || reapBatchRunning}
            title={reapBatchRunning ? "Wait for the reap batch to finish" : undefined}
            onClick={() => handlers.onRescan()}
          >
            {model.rescanning ? "Scanning…" : "Rescan"}
          </button>
          {safeRows.length > 0 ? (
            <button
              type="button"
              className="launch-modal-go"
              disabled={reapBatchRunning}
              onClick={() => handlers.onReapAllSafe()}
            >
              Reap all safe ({safeRows.length}
              {safeBytes > 0 ? ` — frees ~${formatBytesShort(safeBytes)}` : ""})
            </button>
          ) : null}
          <button type="button" className="worktrees-close" title="Close" onClick={() => handlers.onClose()}>
            {"×"}
          </button>
        </div>

        {progress ? (
          <div className="worktrees-progress">
            {progress.done < progress.total ? "Reaping" : "Reaped"} {progress.done}/{progress.total}
            {progress.freedBytes > 0 ? ` · freed ${formatBytesShort(progress.freedBytes)}` : ""}
            {progress.failures > 0 ? ` · ${progress.failures} failed` : ""}
          </div>
        ) : null}
        {model.error ? <div className="wt-error worktrees-error">{model.error}</div> : null}
        {model.loading && !model.data ? <div className="worktrees-loading">Loading…</div> : null}
        {model.data && rows.length === 0 && !model.loading ? (
          <div className="worktrees-loading">{q ? "No worktrees match the filter." : "No worktrees."}</div>
        ) : null}

        <div className="worktrees-body">
          {SECTIONS.map((section) => {
            const sectionRows = bySection.get(section.key);
            if (!sectionRows || sectionRows.length === 0) return null;
            const items = buildSectionItems(sectionRows);
            return (
              <Fragment key={section.key}>
                <div className="worktrees-section-header">
                  {section.label} <span className="worktrees-section-count">{sectionRows.length}</span>
                </div>
                {items.map((item) => {
                  if (item.type === "row") {
                    return <WorktreeRow key={item.row.path} row={item.row} model={model} handlers={handlers} />;
                  }
                  const stackKey = `${section.key}::${item.stack}`;
                  const open = model.expandedStacks.has(stackKey);
                  return (
                    <Fragment key={stackKey}>
                      <div
                        className="wt-row wt-stack-header"
                        onClick={() => handlers.onToggleStack(section.key, item.stack)}
                      >
                        <span className="group-chevron">{open ? "▼" : "▶"}</span>
                        <span className="wt-branch">stack: {item.stack} ({item.rows.length})</span>
                      </div>
                      {open
                        ? item.rows.map((row) => (
                          <div key={row.path} className="wt-stack-member">
                            <WorktreeRow row={row} model={model} handlers={handlers} />
                          </div>
                        ))
                        : null}
                    </Fragment>
                  );
                })}
              </Fragment>
            );
          })}

          {orphans.length > 0 ? (
            <>
              <div
                className="worktrees-section-header collapsible"
                onClick={() => handlers.onToggleOrphans()}
              >
                <span className="group-chevron">{model.orphansExpanded ? "▼" : "▶"}</span>
                Branches without worktrees <span className="worktrees-section-count">{orphans.length}</span>
              </div>
              {model.orphansExpanded
                ? orphans.map((o) => <OrphanBranchRow key={o.branch} orphan={o} model={model} handlers={handlers} />)
                : null}
            </>
          ) : null}

          {tombstones.length > 0 ? (
            <>
              <div
                className="worktrees-section-header collapsible"
                onClick={() => handlers.onToggleTombstones()}
              >
                <span className="group-chevron">{model.tombstonesExpanded ? "▼" : "▶"}</span>
                Past worktrees <span className="worktrees-section-count">{tombstones.length}</span>
              </div>
              {model.tombstonesExpanded
                ? tombstones.map((t) => <TombstoneRow key={`${t.path}:${t.reapedAt}`} t={t} />)
                : null}
            </>
          ) : null}
        </div>

        {model.data ? (
          <div className="worktrees-footer">
            scanned {(() => {
              const rel = relTime(model.data.scannedAt);
              return !rel || rel === "now" ? "just now" : `${rel} ago`;
            })()} · default branch: {model.data.defaultBranch}
          </div>
        ) : null}
      </div>
    </div>,
    root,
  );
}
